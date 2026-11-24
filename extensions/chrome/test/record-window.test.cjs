// A recording's own window and the tabs a recorded page opens, with mocked Chrome APIs ("The recording's own window" and "A recording
// follows the windows the page opens" in docs/design/browser-extension.md): tabs.open with `window` makes a new window for the recording
// (focused for 'front', not for 'back') and leaves T-Agent's shared background window alone; tabs the recorded page opens join the same
// recording (nested popups too, at most 10 tabs), their items carry `tab`, stopping detaches all of them, and the closing rules stay.
const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
// chrome.webRequest events: listeners come and go (only while a recording runs).
function wrSignal() {
  const listeners = [];
  return {
    addListener: f => listeners.push(f),
    removeListener: f => listeners.includes(f) && listeners.splice(listeners.indexOf(f), 1),
    fire: (...args) => [...listeners].forEach(f => f(...args)),
    listeners
  };
}
function signal() {
  const listeners = [];
  return {
    addListener: f => listeners.push(f),
    fire: (...args) => listeners.forEach(f => f(...args)),
    listeners
  };
}
test('a recording opens its own window and follows the tabs its page opens', {
  timeout: 20000
}, async t => {
  const session = {},
    local = {
      token: 'tab_fixture',
      server_url: 'http://127.0.0.1:3000',
      name: 'Fixture'
    };
  // The person's window 1 (focused) with their tab 11; T-Agent's windows get ids from 100.
  const tabs = new Map([[11, {
    id: 11,
    url: 'http://localhost/person',
    title: 'Person',
    groupId: -1,
    windowId: 1,
    active: true,
    status: 'complete'
  }]]);
  const windows = new Map([[1, {
    id: 1,
    type: 'normal',
    focused: true
  }]]);
  let nextTab = 20,
    nextWindow = 100,
    busy = false,
    reloads = 0,
    diskVersion = null;
  const focusCalls = [],
    created = [],
    commands = [],
    ungrouped = [],
    groupCalls = [],
    injections = [];
  const groups = new Map(),
    attached = new Set();
  const onEvent = signal(),
    onDetach = signal();
  global.fetch = async url => {
    assert.match(String(url), /manifest\.json$/);
    return {
      json: async () => ({
        version: diskVersion
      })
    };
  };
  global.chrome = {
    storage: {
      session: {
        get: async () => session,
        set: async v => Object.assign(session, v)
      },
      local: {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in local).map(k => [k, local[k]])),
        set: async v => Object.assign(local, v),
        remove: async k => delete local[k]
      },
      onChanged: signal()
    },
    runtime: {
      id: 'fixture-extension',
      getManifest: () => require('../manifest.json'),
      getURL: p => `chrome-extension://fixture-extension/${p}`,
      reload: () => reloads++,
      onMessage: signal()
    },
    management: {
      getSelf: async () => ({
        installType: 'development'
      })
    },
    alarms: {
      create: () => {},
      onAlarm: signal()
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    },
    windows: {
      create: async p => {
        created.push(p);
        const id = nextWindow++;
        windows.set(id, {
          id,
          type: 'normal',
          focused: p.focused !== false
        });
        const tab = await chrome.tabs.create({
          url: p.url,
          windowId: id,
          active: true
        }, true);
        return {
          id,
          type: 'normal',
          focused: p.focused !== false,
          tabs: [tab]
        };
      },
      get: async (id, p) => {
        const w = windows.get(id);
        if (!w) throw Error('No window');
        return {
          ...w,
          ...(p?.populate ? {
            tabs: [...tabs.values()].filter(x => x.windowId === id)
          } : {})
        };
      },
      update: async (id, p) => {
        focusCalls.push(['windows.update', id, p]);
        if (p.focused) for (const w of windows.values()) w.focused = w.id === id;
      }
    },
    webNavigation: {
      onCreatedNavigationTarget: signal()
    },
    webRequest: {
      onBeforeRequest: wrSignal(),
      onCompleted: wrSignal(),
      onErrorOccurred: wrSignal()
    },
    tabs: {
      onCreated: signal(),
      onRemoved: signal(),
      onUpdated: signal(),
      onActivated: signal(),
      onDetached: signal(),
      query: async p => [...tabs.values()].filter(x => (!p.active || x.active) && (p.groupId === undefined || x.groupId === p.groupId) && (p.windowId === undefined || x.windowId === p.windowId)),
      get: async id => {
        if (!tabs.has(id)) throw Error('missing');
        return tabs.get(id);
      },
      create: async (p, internal) => {
        if (!internal) created.push({
          tab: p
        });
        if (p.active && !internal) focusCalls.push(['tabs.create active', p]);
        const x = {
          id: nextTab++,
          windowId: 1,
          title: 'New',
          groupId: -1,
          status: 'complete',
          active: false,
          ...p
        };
        if (!x.url) x.url = 'about:blank';
        tabs.set(x.id, x);
        return x;
      },
      group: async p => {
        groupCalls.push(p);
        // Chrome makes a new group in the "current" window unless createProperties.windowId names one, and moves the tab there.
        const windowId = p.groupId === undefined ? p.createProperties?.windowId ?? 1 : groups.get(p.groupId).windowId;
        for (const id of p.tabIds) tabs.get(id).windowId = windowId;
        const gid = p.groupId ?? 500 + windowId;
        groups.set(gid, {
          id: gid,
          windowId,
          title: groups.get(gid)?.title || ''
        });
        for (const id of p.tabIds) tabs.get(id).groupId = gid;
        return gid;
      },
      ungroup: async id => {
        ungrouped.push(id);
        tabs.get(id).groupId = -1;
      },
      update: async (id, p) => {
        if (p.active) focusCalls.push(['tabs.update active', id]);
        return Object.assign(tabs.get(id), p);
      },
      remove: async id => {
        const x = tabs.get(id);
        tabs.delete(id);
        chrome.tabs.onRemoved.fire(id, {
          windowId: x?.windowId
        });
      },
      captureVisibleTab: async () => {
        focusCalls.push(['captureVisibleTab']);
        return 'data:image/png;base64,VISIBLE';
      }
    },
    tabGroups: {
      get: async id => groups.get(id),
      query: async p => [...groups.values()].filter(g => g.title === p.title && g.windowId === p.windowId),
      update: async (id, p) => Object.assign(groups.get(id), p),
      onUpdated: signal()
    },
    scripting: {
      executeScript: async p => {
        injections.push(p);
        if (p.func.name === 'pageAction') {
          const [method] = p.args;
          const result = method === 'viewport' ? {
            width: 800,
            height: 600,
            device_scale_factor: 2
          } : {
            ref: 'e1',
            tag: 'button',
            name: 'Go',
            rect: {
              x: 0,
              y: 0,
              w: 10,
              h: 10
            },
            title: 'T',
            url: 'http://localhost/x',
            elements: []
          };
          return [{
            result: {
              ok: true,
              result
            }
          }];
        }
        if (p.world === 'MAIN') return [{
          result: {
            ok: true,
            value: 1,
            type: 'number'
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
      attach: async source => {
        if (busy) throw Error('already attached');
        attached.add(source.tabId);
      },
      detach: async source => {
        attached.delete(source.tabId);
      },
      sendCommand: async (source, method, p) => {
        commands.push({
          tab: source.tabId,
          method,
          p
        });
        if (method === 'Page.captureScreenshot') return {
          data: 'CDPSHOT'
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
  // The worker's ping and flush intervals must not keep the test process alive.
  const realInterval = global.setInterval;
  global.setInterval = (fn, ms) => realInterval(fn, ms).unref();
  t.after(() => {
    global.setInterval = realInterval;
    global.WebSocket = previousSocket;
    delete global.chrome;
    delete global.fetch;
  });
  const {
    dispatch,
    userUsed
  } = await import('../background.js');
  for (let i = 0; i < 5 && !Socket.latest; i++) await tick();
  const socket = Socket.latest;
  socket.open();
  const events = name => socket.messages.filter(m => m.type === 'event' && m.event === name).map(m => m.data);
  const runtime = (m, tab) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](m, {
    id: chrome.runtime.id,
    ...(tab ? {
      tab
    } : {})
  }, resolve));
  const settle = async () => {
    for (let i = 0; i < 20; i++) await tick();
  };
  const itemsOf = id => socket.messages.filter(m => m.type === 'event' && m.event === 'record.items' && m.data.recording_id === id).flatMap(m => m.data.items);
  // The page of a recorded tab opens a tab: Chrome adds it (a popup window, or a tab next to its opener) and reports it.
  let nextPopupWindow = 300;
  const popup = ({
    opener,
    url = 'http://localhost/popup',
    via = 'created',
    window = 'popup'
  }) => {
    const id = nextTab++;
    const windowId = window === 'popup' ? nextPopupWindow++ : tabs.get(opener).windowId;
    if (window === 'popup') windows.set(windowId, {
      id: windowId,
      type: 'popup',
      focused: true
    });
    tabs.set(id, {
      id,
      windowId,
      url: '',
      pendingUrl: url,
      title: '',
      groupId: -1,
      active: true,
      status: 'loading'
    });
    if (via === 'created' || via === 'both') chrome.tabs.onCreated.fire({
      ...tabs.get(id),
      openerTabId: opener
    });
    if (via === 'navigation' || via === 'both') chrome.webNavigation.onCreatedNavigationTarget.fire({
      sourceTabId: opener,
      sourceFrameId: 0,
      tabId: id,
      url
    });
    return id;
  };
  const load = id => {
    const x = tabs.get(id);
    Object.assign(x, {
      url: x.pendingUrl || x.url,
      status: 'complete'
    });
    delete x.pendingUrl;
    chrome.tabs.onUpdated.fire(id, {
      url: x.url,
      status: 'complete'
    }, x);
  };
  let shared, rec, other;
  await t.test('the hello lists open.window and record.tabs', async () => {
    for (const f of ['open.window', 'record.tabs', 'open.record']) assert(socket.messages[0].features.includes(f), f);
    assert.equal(require('../manifest.json').version, '1.0.6');
    assert(require('../manifest.json').permissions.includes('webNavigation'));
  });
  await t.test('window needs record, and is front or back', async () => {
    await assert.rejects(dispatch('tabs.open', {
      url: 'http://localhost/a',
      window: 'front'
    }), /BAD_PARAMS: window is for a recording/);
    await assert.rejects(dispatch('tabs.open', {
      url: 'http://localhost/a',
      record: {},
      window: 'side'
    }), /BAD_PARAMS: window must be front or back/);
    assert.equal(created.length, 0, 'nothing opened');
  });
  await t.test('open --record makes a new focused window for the recording and leaves the shared window alone', async () => {
    shared = (await dispatch('tabs.open', {
      url: 'http://localhost/shared'
    })).tab;
    assert.deepEqual(created.at(-1), {
      url: 'http://localhost/shared',
      focused: false,
      state: 'normal'
    });
    created.length = 0;
    const r = await dispatch('tabs.open', {
      url: 'http://localhost/rec',
      record: {},
      window: 'front'
    });
    rec = r;
    assert.deepEqual(created, [{
      url: 'about:blank',
      focused: true,
      state: 'normal'
    }], 'one new window, focused, normal size, not minimized; no tab in the shared window');
    assert.notEqual(r.tab.window_id, shared.window_id);
    assert.deepEqual(r.window, {
      window_id: r.tab.window_id,
      focused: true,
      own: true
    });
    assert.equal(r.tab.url, 'http://localhost/rec');
    assert.equal(r.tab.how, 'group', 'grouped in its own window');
    assert.equal(tabs.get(r.tab.tab_id).windowId, r.tab.window_id, 'the group did not move it into another window');
    assert.equal([...tabs.values()].filter(x => x.windowId === shared.window_id).length, 1, 'the shared window still holds only its own tab');
    assert(!focusCalls.some(c => c[0] === 'windows.update' && c[1] === shared.window_id), 'the shared window is never focused');
    // The new window's activation is T-Agent's own, not the person's.
    chrome.tabs.onActivated.fire({
      tabId: r.tab.tab_id,
      windowId: r.tab.window_id
    });
    await delay(400);
    assert.equal(events('tab.used').length, 0);
  });
  await t.test('a later open goes to the shared window; the recording window is never reused', async () => {
    created.length = 0;
    const later = (await dispatch('tabs.open', {
      url: 'http://localhost/later'
    })).tab;
    assert.equal(later.window_id, shared.window_id);
    assert.deepEqual(created, [{
      tab: {
        windowId: shared.window_id,
        url: 'http://localhost/later',
        active: false
      }
    }]);
    created.length = 0;
    other = await dispatch('tabs.open', {
      url: 'http://localhost/agent-only',
      record: {},
      window: 'back'
    });
    assert.deepEqual(created, [{
      url: 'about:blank',
      focused: false,
      state: 'normal'
    }], '--background: its own window, without the focus');
    assert.deepEqual(other.window, {
      window_id: other.tab.window_id,
      focused: false,
      own: true
    });
    assert.notEqual(other.tab.window_id, rec.tab.window_id, 'a second recording gets a window of its own');
    assert.notEqual(other.tab.window_id, shared.window_id);
    await dispatch('record.stop', {
      recording_id: other.recording_id
    });
    created.length = 0;
    const again = (await dispatch('tabs.open', {
      url: 'http://localhost/again'
    })).tab;
    assert.equal(again.window_id, shared.window_id, 'still the shared window');
    await dispatch('tabs.close', {
      tab_id: again.tab_id
    });
    await dispatch('tabs.close', {
      tab_id: later.tab_id
    });
  });
  let p1, p2, earlyTab;
  await t.test('a popup of the recorded page joins the recording with the debugger attached', async () => {
    p1 = popup({
      opener: rec.tab.tab_id,
      via: 'both'
    });
    await settle();
    assert(attached.has(p1), 'the debugger is attached to the popup');
    const opened = events('tab.opened');
    assert.equal(opened.length, 1, 'joined once although Chrome reported it twice');
    assert.deepEqual(opened[0], {
      tab_id: p1,
      opener_tab_id: rec.tab.tab_id,
      recording_id: rec.recording_id,
      url: 'http://localhost/popup'
    });
    assert.equal(tabs.get(p1).windowId, 300, 'the popup stays where Chrome put it');
    assert(!groupCalls.some(g => g.tabIds.includes(p1)), 'not grouped or moved');
    load(p1);
    await settle();
    // The page recorder runs there, with the same recording id.
    assert(injections.some(i => i.func.name === 'installRecorder' && i.target.tabId === p1 && i.args[0] === rec.recording_id));
    // It is a T-Agent tab: commands may use it, and it is listed with the recording.
    const listed = (await dispatch('tabs.list')).tabs.find(x => x.tab_id === p1);
    assert.equal(listed.recording_id, rec.recording_id);
    assert.equal(listed.how, 'group');
    // The popup's own activation (Chrome focuses a popup window) is not the person's.
    chrome.tabs.onActivated.fire({
      tabId: p1,
      windowId: 300
    });
    await delay(400);
    assert.equal(events('tab.used').length, 0);
    // Network and page items of the popup go into the same recording with its tab.
    onEvent.fire({
      tabId: p1
    }, 'Network.requestWillBeSent', {
      requestId: 'p1-1',
      request: {
        url: 'http://localhost/api/popup',
        method: 'GET',
        headers: {}
      },
      type: 'Fetch',
      timestamp: 1,
      wallTime: Date.now() / 1000
    });
    await runtime({
      type: 'record.item',
      recording_id: rec.recording_id,
      item: {
        kind: 'click',
        target: {
          tag: 'button'
        }
      }
    }, {
      id: p1
    });
    // Another tab's page cannot write into it.
    await runtime({
      type: 'record.item',
      recording_id: rec.recording_id,
      item: {
        kind: 'click'
      }
    }, {
      id: 11
    });
  });
  await t.test('the first load of an opened tab, before the debugger is there, is recorded through chrome.webRequest', async () => {
    const wr = chrome.webRequest;
    assert.equal(wr.onBeforeRequest.listeners.length, 1, 'listening while a recording runs');
    const id = nextTab;
    // Chrome reports the document request before the tab itself.
    wr.onBeforeRequest.fire({
      requestId: '900',
      tabId: id,
      method: 'GET',
      url: 'http://localhost/early?token=early-secret',
      type: 'main_frame',
      timeStamp: Date.now()
    });
    const joinedId = popup({
      opener: rec.tab.tab_id,
      url: 'http://localhost/early',
      via: 'navigation'
    });
    assert.equal(joinedId, id);
    wr.onBeforeRequest.fire({
      requestId: '901',
      tabId: id,
      method: 'POST',
      url: 'http://localhost/api/early',
      type: 'xmlhttprequest',
      timeStamp: Date.now()
    });
    await settle();
    assert(attached.has(id));
    wr.onCompleted.fire({
      requestId: '900',
      tabId: id,
      method: 'GET',
      url: 'http://localhost/early?token=early-secret',
      type: 'main_frame',
      statusCode: 200,
      responseHeaders: [{
        name: 'Content-Type',
        value: 'text/html; charset=utf-8'
      }, {
        name: 'Set-Cookie',
        value: 'sid=cookie-secret'
      }]
    });
    wr.onErrorOccurred.fire({
      requestId: '901',
      tabId: id,
      method: 'POST',
      url: 'http://localhost/api/early',
      type: 'xmlhttprequest',
      error: 'net::ERR_ABORTED'
    });
    // Once the debugger is attached, new requests are the debugger's.
    wr.onBeforeRequest.fire({
      requestId: '902',
      tabId: id,
      method: 'GET',
      url: 'http://localhost/api/after',
      type: 'xmlhttprequest',
      timeStamp: Date.now()
    });
    // Requests of the person's own tab are never recorded.
    wr.onBeforeRequest.fire({
      requestId: '903',
      tabId: 11,
      method: 'GET',
      url: 'http://localhost/person-api',
      type: 'xmlhttprequest',
      timeStamp: Date.now()
    });
    earlyTab = id;
  });
  await t.test('a popup of the popup joins too (a popup window reported by webNavigation only)', async () => {
    p2 = popup({
      opener: p1,
      url: 'http://localhost/nested',
      via: 'navigation'
    });
    await settle();
    assert(attached.has(p2));
    assert.equal(events('tab.opened').at(-1).opener_tab_id, p1);
  });
  await t.test('a tab the recorded page opens next to it (target=_blank) joins as well', async () => {
    const before = events('tab.opened').length;
    const blank = popup({
      opener: rec.tab.tab_id,
      url: 'http://localhost/blank',
      via: 'created',
      window: 'same'
    });
    await settle();
    assert.equal(events('tab.opened').length, before + 1);
    assert(attached.has(blank));
    // A tab that closes leaves the recording, which goes on.
    await chrome.tabs.remove(blank);
    await settle();
    assert(!attached.has(blank));
    assert.equal((await dispatch('tabs.list')).tabs.find(x => x.tab_id === rec.tab.tab_id).recording_id, rec.recording_id);
    // A tab opened by a tab that does not record does not join.
    popup({
      opener: shared.tab_id,
      via: 'both'
    });
    await settle();
    assert.equal(events('tab.opened').length, before + 1);
  });
  await t.test('at most 10 tabs per recording', async () => {
    const before = events('tab.opened').length;
    // Joined so far: p1, the early tab, p2 and the closed blank tab (4 of 9).
    const more = [];
    for (let i = 0; i < 7; i++) more.push(popup({
      opener: p2,
      url: `http://localhost/many/${i}`,
      via: 'navigation'
    }));
    await settle();
    assert.equal(events('tab.opened').length, before + 5, 'five more join, then the limit');
    assert(!attached.has(more[5]) && !attached.has(more[6]));
    for (const id of more.slice(0, 5)) await chrome.tabs.remove(id);
    for (const id of more.slice(5)) tabs.delete(id);
    await settle();
  });
  await t.test('the person used a popup while it recorded: it is kept', async () => {
    assert.equal(await userUsed(p2, 'input'), true);
    assert.deepEqual(events('tab.used').at(-1), {
      tab_id: p2,
      how: 'input',
      kept: true
    });
  });
  await t.test('stopping the recording detaches from all of its tabs; the items carry their tab', async () => {
    await dispatch('record.stop', {
      recording_id: rec.recording_id
    });
    for (const id of [rec.tab.tab_id, p1, p2]) assert(!attached.has(id), `detached from ${id}`);
    const items = itemsOf(rec.recording_id);
    for (const x of items) assert.equal(x.tab, x.tab_id, 'every item has its tab');
    const opened = items.find(x => x.kind === 'tab' && x.action === 'opened' && x.tab === p1);
    assert.equal(opened.opener, rec.tab.tab_id);
    assert.equal(opened.url, 'http://localhost/popup');
    assert.equal(items.filter(x => x.tab === p1)[0], opened, 'the first item of an opened tab is its tab item, with its opener');
    assert(items.some(x => x.kind === 'request' && x.tab === p1 && x.url === 'http://localhost/api/popup'), 'the popup\'s request');
    assert(items.some(x => x.kind === 'click' && x.tab === p1), 'the popup\'s click');
    assert.equal(items.filter(x => x.kind === 'click').length, 1, 'only the popup\'s own page wrote');
    assert(items.some(x => x.kind === 'tab' && x.action === 'closed'), 'a closed tab has its item');
    const limit = items.filter(x => x.kind === 'tab' && x.recorded === false);
    assert.equal(limit.length, 1, 'the limit is noted once');
    assert.match(limit[0].reason, /at most 10 tabs/);
    const early = items.filter(x => x.tab === earlyTab && x.via === 'webRequest');
    assert.deepEqual(early.map(x => [x.kind, x.req_id, x.type]), [['request', 'wr-900', 'Document'], ['request', 'wr-901', 'Fetch'], ['response', 'wr-900', 'Document'], ['response', 'wr-901', 'Fetch']]);
    const doc = early.find(x => x.kind === 'response' && x.req_id === 'wr-900');
    assert.equal(doc.status, 200);
    assert.equal(doc.response.mime, 'text/html');
    assert.equal(doc.body_omitted, 'early');
    assert(!JSON.stringify(early).includes('cookie-secret') && !JSON.stringify(early).includes('early-secret'), 'redacted like the debugger\'s items');
    assert.equal(early.find(x => x.req_id === 'wr-901' && x.kind === 'response').failed, 'net::ERR_ABORTED');
    assert(!items.some(x => x.url === 'http://localhost/api/after' || x.url === 'http://localhost/person-api'));
    assert.equal(chrome.webRequest.onBeforeRequest.listeners.length + chrome.webRequest.onCompleted.listeners.length, 0, 'no webRequest listener once no recording runs');
    // A new popup of a tab that no longer records does not join.
    const n = events('tab.opened').length;
    popup({
      opener: p1,
      via: 'both'
    });
    await settle();
    assert.equal(events('tab.opened').length, n);
  });
  await t.test('closing rules unchanged: an unused tab closes automatically, a used one is kept, the window goes with its last tab', async () => {
    await dispatch('tabs.close', {
      tab_id: p1,
      auto: true
    });
    assert(!tabs.has(p1), 'the popup nobody used closes like any T-Agent tab');
    await assert.rejects(dispatch('tabs.close', {
      tab_id: p2,
      auto: true
    }), /TAB_NOT_ALLOWED/, 'the popup the person used is kept');
    await dispatch('tabs.close', {
      tab_id: rec.tab.tab_id,
      auto: true
    });
    assert(!tabs.has(rec.tab.tab_id), 'the unused recording tab closes by the same rules');
    assert(!focusCalls.some(c => c[0] === 'windows.remove'), 'T-Agent never closes a window itself');
    await dispatch('tabs.close', {
      tab_id: earlyTab,
      auto: true
    });
    await settle();
    assert.deepEqual(session.joined.map(([id]) => id), [p2], 'the joined tab that is left is remembered across a worker restart');
  });
});
