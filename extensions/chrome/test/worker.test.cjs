const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(r => setImmediate(r));
function signal() {
  const listeners = [];
  return {
    addListener: f => listeners.push(f),
    fire: (...args) => listeners.forEach(f => f(...args)),
    listeners
  };
}
test('worker protocol, tab policy and capture lifecycle without network', {
  timeout: 15000
}, async t => {
  const session = {
      handed: [11],
      owned: []
    },
    local = {
      token: 'tab_fixture',
      server_url: 'http://127.0.0.1:3000',
      name: 'Fixture'
    };
  const tabs = new Map([[11, {
    id: 11,
    url: 'http://localhost/handed',
    title: 'Handed',
    groupId: -1,
    windowId: 1,
    active: true
  }], [12, {
    id: 12,
    url: 'http://localhost/private',
    title: 'Private',
    groupId: -1,
    windowId: 1
  }], [13, {
    id: 13,
    url: 'chrome://settings',
    groupId: -1,
    windowId: 1
  }]]);
  let nextTab = 20,
    attached = false,
    busy = false,
    groupTitle = '';
  const commands = [],
    badges = [],
    injections = [];
  const onEvent = signal(),
    onDetach = signal();
  global.chrome = {
    storage: {
      session: {
        get: async () => session,
        set: async v => Object.assign(session, v)
      },
      local: {
        get: async () => local
      },
      onChanged: signal()
    },
    runtime: {
      id: 'fixture-extension',
      onMessage: signal()
    },
    alarms: {
      create: () => {},
      onAlarm: signal()
    },
    action: {
      setBadgeText: async v => badges.push(v),
      setBadgeBackgroundColor: async () => {}
    },
    windows: {
      update: async () => {}
    },
    tabs: {
      onRemoved: signal(),
      onUpdated: signal(),
      query: async p => [...tabs.values()].filter(t => (!p.active || t.active) && (p.groupId === undefined || t.groupId === p.groupId)),
      get: async id => {
        if (!tabs.has(id)) throw Error('missing');
        return tabs.get(id);
      },
      create: async p => {
        const t = {
          id: nextTab++,
          windowId: 1,
          title: 'New',
          groupId: -1,
          status: 'complete',
          ...p
        };
        tabs.set(t.id, t);
        return t;
      },
      group: async p => {
        for (const id of p.tabIds) {
          tabs.get(id).groupId = 5;
          chrome.tabs.onUpdated.fire(id, {
            groupId: 5
          }, tabs.get(id));
        }
        await tick();
        return 5;
      },
      update: async (id, p) => Object.assign(tabs.get(id), p),
      remove: async id => tabs.delete(id)
    },
    tabGroups: {
      get: async () => ({
        id: 5,
        title: groupTitle
      }),
      query: async () => [],
      update: async () => {
        groupTitle = 'T-Agent';
      },
      onUpdated: signal()
    },
    scripting: {
      executeScript: async p => {
        injections.push(p);
        if (p.func.name === 'pageAction') return [{
          result: {
            ok: true,
            result: {
              ref: 'e1',
              tag: 'button',
              name: 'Save',
              rect: {
                x: 10,
                y: 20,
                w: 100,
                h: 30
              }
            }
          }
        }];
        return [{
          result: undefined
        }];
      }
    },
    debugger: {
      onEvent,
      onDetach,
      attach: async () => {
        if (busy) throw Error('already attached');
        attached = true;
      },
      detach: async () => {
        attached = false;
      },
      sendCommand: async (source, method, p) => {
        commands.push({
          source,
          method,
          p
        });
        if (method === 'Network.getResponseBody') return {
          body: '{"password":"private","ok":true}',
          base64Encoded: false
        };
        return {};
      }
    }
  };
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.messages = [];
      Socket.latest = this;
    }
    send(s) {
      this.messages.push(JSON.parse(s));
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen();
    }
    async message(m) {
      await this.onmessage({
        data: JSON.stringify(m)
      });
    }
  }
  const previousSocket = global.WebSocket;
  global.WebSocket = Socket;
  const intervals = [];
  const realInterval = global.setInterval,
    realClear = global.clearInterval;
  global.setInterval = (fn, ms) => {
    const x = {
      fn,
      ms
    };
    intervals.push(x);
    return x;
  };
  global.clearInterval = () => {};
  t.after(() => {
    global.WebSocket = previousSocket;
    global.setInterval = realInterval;
    global.clearInterval = realClear;
    delete global.chrome;
  });
  const {
    dispatch,
    methods
  } = await import('../background.js');
  await tick();
  const socket = Socket.latest;
  socket.open();
  const runtime = async (m, tab) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](m, {
    id: chrome.runtime.id,
    ...(tab ? {
      tab
    } : {})
  }, resolve));
  const event = async (method, p) => {
    onEvent.fire({
      tabId: 11
    }, method, p);
    await tick();
  };
  await t.test('hello, ping, error envelope and persistent handed tabs', async () => {
    assert.equal(socket.messages[0].token, 'tab_fixture');
    assert.deepEqual(socket.messages[0].methods, methods);
    assert.equal(methods.length, 25);
    intervals.find(i => i.ms === 20000).fn();
    assert.equal(socket.messages.at(-1).type, 'ping');
    assert.equal((await dispatch('tabs.list')).tabs[0].how, 'handed');
    await socket.message({
      type: 'cmd',
      id: 'c_1',
      method: 'page.snapshot',
      params: {
        tab_id: 12
      }
    });
    assert.equal(socket.messages.at(-1).error.code, 'TAB_NOT_ALLOWED');
    assert.equal(injections.length, 0);
    await assert.rejects(dispatch('page.snapshot', {
      tab_id: 13
    }), /TAB_NOT_SCRIPTABLE/);
    await assert.rejects(dispatch('no.such.method'), /UNKNOWN_METHOD/);
    await assert.rejects(dispatch('input.type', {
      tab_id: 11,
      text: 42
    }), /BAD_PARAMS/);
  });
  let opened;
  await t.test('group creation and handover release never close a person tab', async () => {
    opened = (await dispatch('tabs.open', {
      url: 'http://localhost/new'
    })).tab;
    assert.equal(opened.how, 'group');
    assert(session.owned.includes(opened.tab_id));
    await runtime({
      type: 'handover',
      tab_id: 12
    });
    assert(session.handed.includes(12));
    assert.deepEqual(await dispatch('tabs.close', {
      tab_id: 12
    }), {
      released: true
    });
    assert(tabs.has(12));
    await assert.rejects(dispatch('page.snapshot', {
      tab_id: 12
    }), /TAB_NOT_ALLOWED/);
    assert(badges.some(b => b.tabId === 12 && b.text === 'ON'));
  });
  let request;
  await t.test('capture metadata, body, headers, console and raw boundary', async () => {
    await dispatch('net.start', {
      tab_id: 11,
      max_body_bytes: 16
    });
    assert(attached);
    await event('Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'XHR',
      request: {
        url: 'http://localhost/x?token=secret',
        method: 'POST',
        headers: {
          Cookie: 'secret-cookie',
          Authorization: 'Bearer secret-auth'
        },
        postData: '{"token":"long-secret-that-crosses-the-limit"}'
      }
    });
    await event('Network.responseReceived', {
      requestId: 'r1',
      response: {
        status: 200,
        mimeType: 'application/json',
        headers: {
          'Set-Cookie': 'server-secret'
        }
      }
    });
    await event('Network.loadingFinished', {
      requestId: 'r1',
      encodedDataLength: 32
    });
    await event('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{
        value: 'Hello'
      }]
    });
    request = (await dispatch('net.list', {
      tab_id: 11
    })).requests[0];
    assert.equal(request.status, 200);
    const safe = await dispatch('net.get', {
      tab_id: 11,
      req_id: 'r1'
    });
    assert.equal(safe.request.headers.Cookie, '<redacted:13>');
    assert(!safe.request.post_data.includes('long-secret'));
    assert(!safe.response.body.includes('private'));
    const raw = await dispatch('net.get', {
      tab_id: 11,
      req_id: 'r1',
      raw: true
    });
    assert.equal(raw.request.headers.Cookie, 'secret-cookie');
    assert(raw.response.body.includes('pri'));
    assert.equal((await dispatch('page.console', {
      tab_id: 11
    })).entries[0].text, 'Hello');
    await socket.message({
      type: 'cmd',
      id: 'safe',
      method: 'net.get',
      params: {
        tab_id: 11,
        req_id: 'r1'
      }
    });
    assert(!JSON.stringify(socket.messages.at(-1)).includes('secret-cookie'));
    await socket.message({
      type: 'cmd',
      id: 'raw',
      method: 'net.get',
      params: {
        tab_id: 11,
        req_id: 'r1',
        raw: true
      }
    });
    assert(JSON.stringify(socket.messages.at(-1)).includes('secret-cookie'));
  });
  await t.test('record sequence, redaction, detach cancellation and shared capture', async () => {
    const r = await dispatch('record.start', {
      tab_id: 11
    });
    await runtime({
      type: 'record.item',
      recording_id: r.recording_id,
      item: {
        at: 1,
        kind: 'submit',
        url: tabs.get(11).url,
        target: {
          tag: 'form'
        },
        fields: {
          name: 'joe',
          csrf: 'unsafe'
        }
      }
    }, tabs.get(11));
    const end = await dispatch('record.stop', {
      recording_id: r.recording_id
    });
    assert.equal(end.items, 1);
    assert(attached, 'manual capture must survive recording stop');
    const item = socket.messages.find(m => m.event === 'record.items').data.items[0];
    assert.equal(item.seq, 1);
    assert(!JSON.stringify(item).includes('unsafe'), 'the secret-named field is redacted'); // csrf -> <redacted:N>
    assert(JSON.stringify(item).includes('joe'), 'a non-secret field is kept');
    await dispatch('net.stop', {
      tab_id: 11
    });
    assert(!attached);
    const again = await dispatch('record.start', {
      tab_id: 11
    });
    onDetach.fire({
      tabId: 11
    }, 'canceled_by_user');
    await tick();
    assert(socket.messages.some(m => m.event === 'record.stopped' && m.data.recording_id === again.recording_id));
    assert.equal((await dispatch('tabs.list')).tabs.find(t => t.tab_id === 11).capturing, false);
  });
  await t.test('debugger busy, CDP input and takeback detach', async () => {
    busy = true;
    await assert.rejects(dispatch('net.start', {
      tab_id: 11
    }), /DEBUGGER_BUSY/);
    busy = false;
    await dispatch('net.start', {
      tab_id: 11
    });
    await dispatch('input.click', {
      tab_id: 11,
      target: {
        selector: '#save'
      },
      modifiers: ['Control']
    });
    const mouse = commands.find(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouse.p.x, 60);
    assert.equal(mouse.p.y, 35);
    assert.equal(mouse.p.modifiers, 2);
    await runtime({
      type: 'takeback',
      tab_id: 11
    });
    assert(!attached);
    assert(!session.handed.includes(11));
    await assert.rejects(dispatch('net.start', {
      tab_id: 11
    }), /TAB_NOT_ALLOWED/);
  });
  await t.test('revocation suppresses minute-alarm reconnect', async () => {
    await socket.onclose({
      code: 4401
    });
    assert(session.blocked);
    chrome.alarms.onAlarm.fire({
      name: 'browser-reconnect'
    });
    await tick();
    assert.equal(Socket.latest, socket);
    assert.equal((await runtime({
      type: 'status'
    })).status, 'needs pairing');
  });
});
