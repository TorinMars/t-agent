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
      getManifest: () => require('../manifest.json'),
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
    methods,
    features
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
    assert.equal(socket.messages[0].version, require('../manifest.json').version, 'hello carries the manifest version');
    assert.deepEqual(socket.messages[0].methods, methods);
    assert.deepEqual(socket.messages[0].features, features, 'hello lists the features of options newer than their method');
    assert.equal(methods.length, 26);
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
  await t.test('back and forward fall back to the page history when Chrome skips the entries', async () => {
    const id = opened.tab_id;
    Object.assign(tabs.get(id), { url: 'http://localhost/second', status: 'complete' });
    const steps = [];
    chrome.tabs.goBack = async () => {
      throw Error('Cannot find a next page in history.');
    };
    chrome.tabs.goForward = chrome.tabs.goBack;
    const exec = chrome.scripting.executeScript;
    chrome.scripting.executeScript = async p => {
      const step = p.args?.[0];
      if (step !== 'back' && step !== 'forward') return exec(p);
      steps.push(step);
      if (step === 'back') setTimeout(() => {
        tabs.get(id).url = 'http://localhost/first';
      }, 20);
      return [{ result: undefined }];
    };
    try {
      const back = await dispatch('tabs.navigate', { tab_id: id, action: 'back' });
      assert.equal(back.tab.url, 'http://localhost/first');
      await assert.rejects(dispatch('tabs.navigate', { tab_id: id, action: 'forward' }), /no later page/);
      assert.deepEqual(steps, ['back', 'forward']);
    } finally {
      chrome.scripting.executeScript = exec;
      delete chrome.tabs.goBack;
      delete chrome.tabs.goForward;
    }
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
  const itemsOf = id => socket.messages.filter(m => m.event === 'record.items' && m.data.recording_id === id).flatMap(m => m.data.items);
  await t.test('open with record attaches before the first navigation', async () => {
    const log = [];
    const real = {
      create: chrome.tabs.create,
      update: chrome.tabs.update,
      attach: chrome.debugger.attach,
      send: chrome.debugger.sendCommand
    };
    chrome.tabs.create = async p => {
      log.push(`create ${p.url}`);
      return real.create(p);
    };
    chrome.tabs.update = async (id, p) => {
      if (p.url) log.push(`navigate ${p.url}`);
      return real.update(id, p);
    };
    chrome.debugger.attach = async (...args) => {
      log.push('attach');
      return real.attach(...args);
    };
    chrome.debugger.sendCommand = async (source, method, p) => {
      if (method === 'Network.enable') log.push('Network.enable');
      return real.send(source, method, p);
    };
    try {
      await assert.rejects(dispatch('tabs.open', { url: 'http://localhost/a', record: 'yes' }), /BAD_PARAMS/);
      await assert.rejects(dispatch('tabs.open', { url: 'http://localhost/a', record: { types: 'XHR' } }), /BAD_PARAMS/);
      log.length = 0;
      const r = await dispatch('tabs.open', {
        url: 'http://localhost/first',
        record: {
          types: ['xhr'],
          max_body_bytes: 100
        }
      });
      assert.deepEqual(log, ['create about:blank', 'attach', 'Network.enable', 'navigate http://localhost/first'], 'the debugger is attached on about:blank, before the page loads');
      assert.match(r.recording_id, /^rec_/);
      assert.equal(r.tab.url, 'http://localhost/first');
      assert.equal(r.tab.how, 'group');
      assert.deepEqual(r.options.types, ['xhr']);
      assert.equal(r.options.max_body_bytes, 100);
      // A late about:blank report does not end the recording.
      chrome.tabs.onUpdated.fire(r.tab.tab_id, { url: 'about:blank' }, tabs.get(r.tab.tab_id));
      await tick();
      assert.equal((await dispatch('tabs.list')).tabs.find(x => x.tab_id === r.tab.tab_id).recording_id, r.recording_id);
      // The page committed: the recorder goes in at once.
      const before = injections.length;
      onEvent.fire({ tabId: r.tab.tab_id }, 'Page.frameNavigated', { frame: { id: 'main', url: 'http://localhost/first' } });
      await tick();
      const recorder = injections.slice(before).find(i => i.func.name === 'installRecorder');
      assert(recorder, 'installRecorder at commit');
      assert.equal(recorder.injectImmediately, true);
      assert.equal(recorder.args[0], r.recording_id);
      await dispatch('record.stop', { recording_id: r.recording_id });
      const first = itemsOf(r.recording_id)[0];
      assert.deepEqual([first.kind, first.source, first.action, first.to], ['nav', 'agent', 'open', 'http://localhost/first']);
      await dispatch('tabs.close', { tab_id: r.tab.tab_id });
    } finally {
      Object.assign(chrome.tabs, { create: real.create, update: real.update });
      Object.assign(chrome.debugger, { attach: real.attach, sendCommand: real.send });
    }
  });
  await t.test('record types and max body: other types keep the item without bodies, or are dropped', async () => {
    await assert.rejects(dispatch('record.start', { tab_id: 11, drop_other_types: true }), /drop_other_types needs types/);
    await assert.rejects(dispatch('record.start', { tab_id: 11, types: ['X-HR'] }), /BAD_PARAMS/);
    await assert.rejects(dispatch('record.start', { tab_id: 11, max_body_bytes: -1 }), /BAD_PARAMS/);
    const run = async (params, prefix) => {
      const r = await dispatch('record.start', { tab_id: 11, ...params });
      commands.length = 0;
      for (const [n, type] of [['s', 'Script'], ['x', 'XHR']]) {
        const requestId = `${prefix}${n}`;
        await event('Network.requestWillBeSent', { requestId, type, request: { url: `http://localhost/${requestId}`, method: 'POST', headers: {}, postData: 'name=a-long-form-value' } });
        await event('Network.responseReceived', { requestId, response: { status: 200, mimeType: 'application/json', headers: {} } });
        await event('Network.loadingFinished', { requestId, encodedDataLength: 32 });
      }
      const bodyFetches = commands.filter(c => c.method === 'Network.getResponseBody').map(c => c.p.requestId);
      await dispatch('record.stop', { recording_id: r.recording_id });
      return { items: itemsOf(r.recording_id), bodyFetches, r };
    };
    const kept = await run({ types: ['XHR'], max_body_bytes: 8 }, 'k');
    assert.deepEqual(kept.bodyFetches, ['kx'], 'only the bodies of the chosen types are fetched');
    const script = kept.items.find(i => i.kind === 'response' && i.req_id === 'ks');
    assert.equal(script.body_omitted, 'type');
    assert.equal(script.response.body, undefined);
    assert.equal(script.request.post_data, undefined);
    assert(kept.items.some(i => i.kind === 'request' && i.req_id === 'ks'), 'the request item of another type stays');
    const xhr = kept.items.find(i => i.kind === 'response' && i.req_id === 'kx');
    assert(new TextEncoder().encode(xhr.response.body).length <= 8);
    assert.equal(xhr.response.body_truncated, true);
    assert.equal(xhr.response.body_bytes, 32, 'the size before the cut');
    assert(xhr.request.post_data.length <= 8);
    assert.equal(xhr.request.post_data_truncated, true);
    assert.equal(xhr.request.post_data_bytes, 22);
    assert(!JSON.stringify(kept.items).includes('private'), 'bodies are still redacted');
    const dropped = await run({ types: ['xhr'], drop_other_types: true }, 'd');
    assert(!dropped.items.some(i => i.req_id === 'ds'), 'no items for other types');
    assert(dropped.items.some(i => i.kind === 'response' && i.req_id === 'dx' && i.response.body !== undefined));
    const all = await run({}, 'a');
    assert.deepEqual(all.bodyFetches, ['as', 'ax'], 'defaults unchanged: every body');
    assert(all.items.every(i => i.body_omitted === undefined));
    assert.equal(all.r.options.max_body_bytes, null);
  });
  await t.test('agent actions are recorded once with source agent, before their input', async () => {
    const r = await dispatch('record.start', { tab_id: 11 });
    const marks = () => injections.filter(i => i.func.name === 'agentWindow');
    const before = marks().length;
    // The click item is queued before the debugger sends the mouse event.
    const realSend = chrome.debugger.sendCommand;
    let queuedAtMouse = null;
    chrome.debugger.sendCommand = async (source, method, p) => {
      if (method === 'Input.dispatchMouseEvent' && queuedAtMouse === null) {
        await dispatch('record.stop', { recording_id: r.recording_id }).catch(() => {});
        queuedAtMouse = itemsOf(r.recording_id).filter(i => i.source === 'agent').length;
      }
      return realSend(source, method, p);
    };
    try {
      await dispatch('input.click', { tab_id: 11, target: { selector: '#save' } });
    } finally {
      chrome.debugger.sendCommand = realSend;
    }
    assert.equal(queuedAtMouse, 1, 'the agent item comes before the input it causes');
    const windows = marks().slice(before).map(i => i.args[0]);
    assert.equal(windows.length, 2, 'the recorder is told before and after the input');
    assert(windows[0] >= 1000 && windows[1] <= 500);
    const click = itemsOf(r.recording_id).find(i => i.source === 'agent');
    assert.deepEqual([click.kind, click.command, click.target.tag, click.target.name, click.button, click.count], ['click', 'input.click', 'button', 'Save', 'left', 1]);

    const r2 = await dispatch('record.start', { tab_id: 11 });
    chrome.tabs.reload = async () => {};
    try {
      await dispatch('input.type', { tab_id: 11, target: { selector: '#name' }, text: 'hunter2', submit: true });
      await dispatch('input.press', { tab_id: 11, key: 'a' });
      await dispatch('input.press', { tab_id: 11, key: 'Enter', modifiers: ['Shift'] });
      await dispatch('input.select', { tab_id: 11, target: { selector: '#choice' }, values: ['two'] });
      await dispatch('input.scroll', { tab_id: 11, dy: 300 });
      tabs.get(11).status = 'complete';
      await dispatch('tabs.navigate', { tab_id: 11, url: 'http://localhost/handed' });
      await dispatch('tabs.navigate', { tab_id: 11, action: 'reload' });
    } finally {
      delete chrome.tabs.reload;
    }
    await dispatch('record.stop', { recording_id: r2.recording_id });
    const agent = itemsOf(r2.recording_id).filter(i => i.source === 'agent');
    assert.deepEqual(agent.map(i => `${i.kind} ${i.command || i.action}`), ['input input.type', 'key input.press', 'key input.press', 'change input.select', 'scroll input.scroll', 'nav go', 'nav reload'], 'one item per command (the Enter of --submit is part of the type item)');
    assert.deepEqual([agent[0].value, agent[0].submit], ['hunter2', true]);
    assert.equal(agent[1].key, '<redacted:1>', 'a printable key is kept as its length only');
    assert.deepEqual([agent[2].key, agent[2].modifiers], ['Enter', ['Shift']]);
    assert.deepEqual(agent[3].values, ['two']);
    assert.equal(agent[4].dy, 300);
    assert.deepEqual([agent[5].from, agent[5].to], ['http://localhost/handed', 'http://localhost/handed']);
    assert.equal(agent[6].transition, 'reload');    commands.length = 0;
  });
  await t.test('a typed secret in an agent item is kept as its length only', async () => {
    const exec = chrome.scripting.executeScript;
    chrome.scripting.executeScript = async p => p.func.name === 'pageAction' && p.args[0] === 'resolve' ? [{
      result: { ok: true, result: { ref: 'e2', tag: 'input', type: 'password', name: 'Password', sensitive: true, rect: { x: 0, y: 0, w: 10, h: 10 } } }
    }] : exec(p);
    try {
      const r = await dispatch('record.start', { tab_id: 11 });
      await dispatch('input.type', { tab_id: 11, target: { selector: '#password' }, text: 'never-in-a-recording' });
      await dispatch('record.stop', { recording_id: r.recording_id });
      const text = JSON.stringify(itemsOf(r.recording_id));
      assert(!text.includes('never-in-a-recording'));
      assert(text.includes('<redacted:20>'));
    } finally {
      chrome.scripting.executeScript = exec;
    }
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
  await t.test('tabs.reveal brings a T-Agent page tab forward without a handed tab', async () => {
    const focusedWindows = [];
    const realUpdate = chrome.windows.update;
    chrome.windows.update = async (id, p) => focusedWindows.push([id, p]);
    for (const id of [11, 12]) tabs.get(id).active = false;
    tabs.set(31, { id: 31, url: 'http://127.0.0.1:3000/h5?pane=1', groupId: -1, windowId: 4, lastAccessed: 900 });
    tabs.set(32, { id: 32, url: 'http://127.0.0.1:3000/?x=1', groupId: -1, windowId: 2, lastAccessed: 500 });
    tabs.set(33, { id: 33, url: 'http://127.0.0.1:3000/', groupId: -1, windowId: 3, lastAccessed: 700 });
    tabs.set(34, { id: 34, url: 'http://127.0.0.1:3001/', groupId: -1, windowId: 3, lastAccessed: 999 });
    try {
      assert.deepEqual(await dispatch('tabs.reveal', { origin: 'http://127.0.0.1:3000' }), { focused: true, tab_id: 33 }, 'the one used last, never a column or another port');
      assert.equal(tabs.get(33).active, true);
      assert.deepEqual(focusedWindows.at(-1), [3, { focused: true }]);
      tabs.get(33).active = false;
      tabs.get(32).active = true;
      assert.equal((await dispatch('tabs.reveal', { origin: 'http://127.0.0.1:3000' })).tab_id, 32, 'the front tab first');
      assert.deepEqual(await dispatch('tabs.reveal', { origin: 'http://localhost:4000' }), { focused: false });
      for (const origin of ['http://127.0.0.1:3000/', 'file:///tmp', 'chrome://settings', 42, undefined]) await assert.rejects(dispatch('tabs.reveal', { origin }), /BAD_PARAMS/);
      assert.equal(injections.filter(i => [31, 32, 33].includes(i.target?.tabId)).length, 0, 'no page is read');
    } finally {
      chrome.windows.update = realUpdate;
      for (const id of [31, 32, 33, 34]) tabs.delete(id);
      tabs.get(11).active = true;
    }
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
