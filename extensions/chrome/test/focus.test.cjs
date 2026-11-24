// The worker's focus and closing rules with mocked Chrome APIs ("Focus and closing" in docs/design/browser-extension.md): tabs open in one
// T-Agent window created without the focus and reused, nothing activates a tab or focuses a window unless the command asks, a visible
// screenshot of a tab that is not active goes through the debugger, page dialogs are answered and reported, the person's use releases a tab,
// tabs.close with `auto`, and the bridge's reload request with its loop guard.
const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
function signal() {
  const listeners = [];
  return {
    addListener: f => listeners.push(f),
    fire: (...args) => listeners.forEach(f => f(...args)),
    listeners
  };
}
test('focus, background window, dialogs, the person\'s use and self reload', {
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
  const groups = new Map();
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
          focused: false,
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
    tabs: {
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
      attach: async () => {
        if (busy) throw Error('already attached');
      },
      detach: async () => {},
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
  let first, second;
  await t.test('hello carries the install type and the owned tabs', async () => {
    const hello = socket.messages[0];
    assert.equal(hello.install_type, 'development');
    assert.deepEqual(hello.owned_tabs, []);
    for (const f of ['open.keep', 'close.auto', 'shot.inactive', 'dialog.answer', 'tab.used', 'reload']) assert(hello.features.includes(f), f);
  });
  await t.test('tabs open in one T-Agent window, created without the focus and reused', async () => {
    first = (await dispatch('tabs.open', {
      url: 'http://localhost/a'
    })).tab;
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], {
      url: 'http://localhost/a',
      focused: false,
      state: 'normal'
    }, 'a normal window, not focused, not minimized');
    assert.equal(first.window_id, 100);
    assert.equal(first.how, 'group');
    assert.deepEqual(groupCalls[0], {
      tabIds: [first.tab_id],
      createProperties: {
        windowId: 100
      }
    }, 'the group is made in T-Agent\'s window, so the tab is not moved into the person\'s');
    // Two opens at once: one window.
    const [b, c] = await Promise.all([dispatch('tabs.open', {
      url: 'http://localhost/b'
    }), dispatch('tabs.open', {
      url: 'http://localhost/c',
      keep: true
    })]);
    second = b.tab;
    assert.deepEqual([b.tab.window_id, c.tab.window_id], [100, 100]);
    assert.equal(created.filter(x => x.focused === false).length, 1, 'the window is reused');
    assert.deepEqual(created.slice(1).map(x => x.tab.active), [false, false], 'new tabs in it are not active');
    assert.equal(c.tab.keep, true);
    assert.equal(tabs.get(c.tab.tab_id).groupId, tabs.get(first.tab_id).groupId, 'one T-Agent group');
    assert.equal(groups.get(tabs.get(first.tab_id).groupId).title, 'T-Agent');
    assert.deepEqual(session.kept, [c.tab.tab_id]);
    assert.equal(session.agent_window, 100);
    // The keep tab cannot be closed automatically; a person's close still closes it.
    await assert.rejects(dispatch('tabs.close', {
      tab_id: c.tab.tab_id,
      auto: true
    }), /TAB_NOT_ALLOWED/);
    const before = ungrouped.length;
    await dispatch('tabs.close', {
      tab_id: c.tab.tab_id
    });
    assert(!tabs.has(c.tab.tab_id));
    assert(ungrouped.slice(before).includes(c.tab.tab_id), 'a closed tab leaves its group first, so Chrome keeps no saved "T-Agent" group');
    assert.deepEqual(focusCalls, [], 'nothing was activated or focused');
  });
  await t.test('only activate, open --active and reveal bring anything to the front', async () => {
    const id = first.tab_id;
    const run = [['tabs.navigate', {
      tab_id: id,
      url: 'http://localhost/a2'
    }], ['page.snapshot', {
      tab_id: id
    }], ['input.click', {
      tab_id: id,
      target: {
        selector: '#go'
      }
    }], ['input.type', {
      tab_id: id,
      target: {
        selector: '#q'
      },
      text: 'x'
    }], ['page.eval', {
      tab_id: id,
      expression: '1'
    }], ['page.wait', {
      tab_id: id,
      network_idle_ms: 0,
      timeout_ms: 500
    }], ['net.start', {
      tab_id: id
    }], ['input.press', {
      tab_id: id,
      key: 'Enter'
    }], ['net.stop', {
      tab_id: id
    }], ['record.start', {
      tab_id: id
    }], ['record.stop', {
      tab_id: id
    }], ['page.screenshot', {
      tab_id: id
    }], ['page.screenshot', {
      tab_id: id,
      full_page: true
    }], ['tabs.list', {}]];
    for (const [method, p] of run) await dispatch(method, p).catch(e => assert.fail(`${method}: ${e.message}`));
    assert.deepEqual(focusCalls, [], 'no command took the focus');
    await dispatch('tabs.activate', {
      tab_id: id
    });
    assert.deepEqual(focusCalls.map(c => c[0]), ['tabs.update active', 'windows.update']);
    focusCalls.length = 0;
    const shown = (await dispatch('tabs.open', {
      url: 'http://localhost/shown',
      active: true
    })).tab;
    assert.equal(shown.window_id, 100, 'open --active also uses T-Agent\'s window');
    assert.deepEqual(focusCalls.map(c => c[0]), ['tabs.update active', 'windows.update']);
    assert.deepEqual(focusCalls[1], ['windows.update', 100, {
      focused: true
    }]);
    // T-Agent's own activation does not count as the person's.
    await delay(350);
    assert(session.owned.includes(shown.tab_id));
    await dispatch('tabs.close', {
      tab_id: shown.tab_id
    });
    for (const w of windows.values()) w.focused = w.id === 1;
    focusCalls.length = 0;
  });
  await t.test('a visible screenshot of a tab that is not active goes through the debugger', async () => {
    const id = second.tab_id;
    tabs.get(id).active = false;
    commands.length = 0;
    const shot = await dispatch('page.screenshot', {
      tab_id: id
    });
    assert.equal(shot.data_base64, 'CDPSHOT');
    assert.deepEqual([shot.width, shot.height], [1600, 1200]);
    const cap = commands.find(c => c.method === 'Page.captureScreenshot');
    assert(cap, 'Page.captureScreenshot');
    assert.equal(cap.p.clip, undefined, 'the viewport, not a clip');
    assert(!focusCalls.length, 'captureVisibleTab is not used');
    // DevTools holds the debugger: an active tab falls back to captureVisibleTab, an inactive one fails.
    busy = true;
    try {
      await assert.rejects(dispatch('page.screenshot', {
        tab_id: id
      }), /DEBUGGER_BUSY/);
      tabs.get(id).active = true;
      assert.equal((await dispatch('page.screenshot', {
        tab_id: id
      })).data_base64, 'VISIBLE');
    } finally {
      busy = false;
      tabs.get(id).active = false;
      focusCalls.length = 0;
    }
  });
  await t.test('page dialogs are answered while the debugger is attached and reported with the next result', async () => {
    const id = second.tab_id;
    await dispatch('net.start', {
      tab_id: id
    });
    commands.length = 0;
    for (const [type, message] of [['alert', 'Saved'], ['confirm', 'Delete all?'], ['prompt', 'Name?'], ['beforeunload', '']]) {
      onEvent.fire({
        tabId: id
      }, 'Page.javascriptDialogOpening', {
        type,
        message,
        url: 'http://localhost/b'
      });
    }
    await tick();
    await tick();
    assert.deepEqual(commands.filter(c => c.method === 'Page.handleJavaScriptDialog').map(c => c.p.accept), [true, false, false, true], 'alert and beforeunload accepted, confirm and prompt dismissed');
    const console = await dispatch('page.console', {
      tab_id: id
    });
    assert.deepEqual(console.dialogs.map(d => `${d.type} ${d.handled}`), ['alert accepted', 'confirm dismissed', 'prompt dismissed', 'beforeunload accepted']);
    assert(console.entries.some(e => e.level === 'dialog' && e.text === 'dialog: alert Saved (accepted)'));
    assert.equal((await dispatch('page.snapshot', {
      tab_id: id
    })).dialogs, undefined, 'reported once');
    // The result message carries the tab for the bridge's tab care.
    await socket.message({
      type: 'cmd',
      id: 'c_tab',
      method: 'page.snapshot',
      params: {
        tab_id: id
      }
    });
    assert.deepEqual(socket.messages.at(-1).tab, {
      tab_id: id,
      how: 'group'
    });
    await dispatch('net.stop', {
      tab_id: id
    });
    assert(!focusCalls.length);
  });
  await t.test('the person activating or using a T-Agent tab releases it; Chrome\'s own activation does not', async () => {
    const a = first.tab_id,
      b = second.tab_id;
    // In a window without the focus (Chrome picked it after a close): nothing.
    chrome.tabs.onActivated.fire({
      tabId: a,
      windowId: 100
    });
    await delay(350);
    assert(session.owned.includes(a));
    // In the focused window, a moment after a tab of it closed: still Chrome's choice.
    windows.get(100).focused = true;
    chrome.tabs.onRemoved.fire(999, {
      windowId: 100
    });
    chrome.tabs.onActivated.fire({
      tabId: a,
      windowId: 100
    });
    await delay(350);
    assert(session.owned.includes(a));
    await delay(1200);
    // The person clicks the tab in the window they are in.
    chrome.tabs.onActivated.fire({
      tabId: a,
      windowId: 100
    });
    await delay(350);
    assert(!session.owned.includes(a), 'released');
    assert(ungrouped.includes(a), 'ungrouped, left where it is');
    assert(tabs.has(a), 'never closed');
    assert.deepEqual(events('tab.used').at(-1), {
      tab_id: a,
      how: 'activated'
    });
    await assert.rejects(dispatch('page.snapshot', {
      tab_id: a
    }), /TAB_NOT_ALLOWED/);
    windows.get(100).focused = false;
    // Trusted input inside a command (CDP input) is the command's own; the person's input afterwards releases the tab.
    await delay(1100);
    const watch = injections.filter(i => i.func.name === 'userWatch');
    assert(watch.some(i => i.target.tabId === b), 'the page watches for the person\'s input');
    const realSend = chrome.debugger.sendCommand;
    let during;
    chrome.debugger.sendCommand = async (source, method, p) => {
      if (method === 'Input.dispatchKeyEvent' && during === undefined) during = await userUsed(b, 'input');
      return realSend(source, method, p);
    };
    await dispatch('net.start', {
      tab_id: b
    });
    try {
      await dispatch('input.press', {
        tab_id: b,
        key: 'Enter'
      });
    } finally {
      chrome.debugger.sendCommand = realSend;
    }
    assert.equal(during, false);
    assert(session.owned.includes(b));
    await delay(1100);
    await runtime({
      type: 'user.input',
      kind: 'keydown'
    }, tabs.get(b));
    assert(!session.owned.includes(b));
    assert.deepEqual(events('tab.used').at(-1), {
      tab_id: b,
      how: 'input'
    });
    // A recorded tab the person uses stays T-Agent's but is kept (never closed automatically).
    const r = await dispatch('tabs.open', {
      url: 'http://localhost/rec',
      record: {}
    });
    await delay(1100);
    await runtime({
      type: 'user.input',
      kind: 'pointerdown'
    }, tabs.get(r.tab.tab_id));
    assert(session.owned.includes(r.tab.tab_id));
    assert(session.kept.includes(r.tab.tab_id));
    assert.deepEqual(events('tab.used').at(-1), {
      tab_id: r.tab.tab_id,
      how: 'input',
      kept: true
    });
    await dispatch('record.stop', {
      recording_id: r.recording_id
    });
    await assert.rejects(dispatch('tabs.close', {
      tab_id: r.tab.tab_id,
      auto: true
    }), /TAB_NOT_ALLOWED/);
    assert(!focusCalls.length);
  });
  await t.test('a window that no longer holds a T-Agent tab is not reused', async () => {
    for (const x of [...tabs.values()]) if (session.owned.includes(x.id)) await dispatch('tabs.close', {
      tab_id: x.id
    });
    assert(tabs.has(first.tab_id) && tabs.get(first.tab_id).windowId === 100, 'the released tabs stay where they are');
    const before = created.filter(x => x.focused === false).length;
    const n = (await dispatch('tabs.open', {
      url: 'http://localhost/new'
    })).tab;
    assert.equal(created.filter(x => x.focused === false).length, before + 1);
    assert(n.window_id > 100 && tabs.get(first.tab_id).windowId === 100, 'a new window: the old one holds only the person\'s tabs');
    assert.equal(session.agent_window, n.window_id);
    await dispatch('tabs.close', {
      tab_id: n.tab_id
    });
  });
  await t.test('reload: only when the folder holds a newer manifest, once per version in 10 minutes, after the recordings stop', async () => {
    const running = require('../manifest.json').version;
    diskVersion = running;
    await socket.message({
      type: 'reload',
      version: '9.9.9'
    });
    await delay(20);
    assert.equal(reloads, 0, 'the folder is not newer: no reload');
    const r = await dispatch('tabs.open', {
      url: 'http://localhost/rec2',
      record: {}
    });
    diskVersion = '9.0.0';
    await socket.message({
      type: 'reload',
      version: '9.0.0'
    });
    await delay(20);
    assert.equal(reloads, 0, 'waits while a recording runs');
    await dispatch('record.stop', {
      recording_id: r.recording_id
    });
    await delay(20);
    assert.equal(reloads, 1);
    assert.equal(local.last_reload.version, '9.0.0');
    assert.deepEqual(local.reload_state.owned, session.owned, 'the owned tabs are kept across the reload');
    assert.equal(local.reload_state.agent_window, session.agent_window);
    await socket.message({
      type: 'reload',
      version: '9.0.0'
    });
    await delay(20);
    assert.equal(reloads, 1, 'not again for the same version within 10 minutes');
    local.last_reload.at -= 11 * 60000;
    await socket.message({
      type: 'reload',
      version: '9.0.0'
    });
    await delay(20);
    assert.equal(reloads, 2, 'again after 10 minutes');
  });
});
