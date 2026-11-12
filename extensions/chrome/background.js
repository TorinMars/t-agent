import { redact, cut } from './redact.js';
import { pageAction, installRecorder } from './page.js';
import { captures, cdp, attach, detach, setCaptureEmitter, summary, detail, matches } from './capture.js';
export const methods = ['tabs.list', 'tabs.open', 'tabs.close', 'tabs.navigate', 'tabs.activate', 'page.snapshot', 'page.query', 'input.click', 'input.type', 'input.press', 'input.hover', 'input.scroll', 'input.select', 'page.eval', 'page.wait', 'page.screenshot', 'page.console', 'net.start', 'net.stop', 'net.list', 'net.get', 'page.fetch', 'record.start', 'record.stop', 'debug.detach'];
const recordings = new Map(),
  owned = new Set(),
  handed = new Set(),
  grouping = new Set();
let lastTab,
  socket,
  retry = 0,
  retryTimer,
  pingTimer,
  blocked = false,
  status = 'needs pairing';
const ready = (async () => {
  const s = await chrome.storage.session.get(['handed', 'owned', 'blocked']);
  for (const id of s.handed || []) handed.add(id);
  for (const id of s.owned || []) owned.add(id);
  blocked = !!s.blocked;
})();
const persist = () => chrome.storage.session.set({
  handed: [...handed],
  owned: [...owned],
  blocked
});
const fail = (code, message) => {
  throw new Error(`${code}: ${message}`);
};
function send(message, raw = false) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const payload = raw ? message : redact(message);
  let data = JSON.stringify(payload);
  if (new TextEncoder().encode(data).length > 32 * 1024 * 1024) {
    // Cap large binary/text results while preserving the command's result shape.
    const trim = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, v] of Object.entries(value)) {
        if (typeof v === 'string' && v.length > 1024 * 1024) {
          value[key] = cut(v, 1024 * 1024).text;
          value.truncated = true;
        } else if (typeof v === 'object') trim(v);
      }
    };
    trim(payload.result || payload.data);
    if (payload.result) payload.result.truncated = true;
    data = JSON.stringify(payload);
    while (new TextEncoder().encode(data).length > 32 * 1024 * 1024) {
      let changed = false;
      const shrink = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, v] of Object.entries(value)) {
          if (Array.isArray(v) && v.length > 1) {
            value[key] = v.slice(0, Math.ceil(v.length / 2));
            changed = true;
          } else if (typeof v === 'object') shrink(v);
        }
      };
      shrink(payload.result || payload.data);
      if (!changed) {
        if (payload.result) payload.result = {
          truncated: true
        };else return;
      }
      data = JSON.stringify(payload);
    }
  }
  socket.send(data);
}
const event = (name, data) => send({
  type: 'event',
  event: name,
  data
});
const scriptable = url => /^https?:\/\//i.test(url || '') && !/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(url);
async function allowed(t) {
  if (!scriptable(t.url || t.pendingUrl)) fail('TAB_NOT_SCRIPTABLE', 'This page cannot be controlled');
  if (handed.has(t.id)) return 'handed';
  if (owned.has(t.id) && t.groupId >= 0) {
    const g = await chrome.tabGroups.get(t.groupId);
    if (g.title === 'T-Agent') return 'group';
  }
  fail('TAB_NOT_ALLOWED', 'Hand this tab over using the extension button');
}
async function getTab(id) {
  await ready;
  if (id === undefined) {
    if (lastTab !== undefined) id = lastTab;else {
      const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
      });
      for (const t of tabs) try {
        await allowed(t);
        id = t.id;
        break;
      } catch {/* Not allowed. */}
    }
  }
  if (!Number.isInteger(id)) fail('TAB_NOT_FOUND', 'No controllable tab');
  let t;
  try {
    t = await chrome.tabs.get(id);
  } catch {
    fail('TAB_NOT_FOUND', 'Tab no longer exists');
  }
  await allowed(t);
  lastTab = t.id;
  return t;
}
async function tabInfo(t) {
  return {
    tab_id: t.id,
    window_id: t.windowId,
    url: t.url,
    title: t.title,
    active: t.active,
    how: await allowed(t),
    capturing: captures.has(t.id),
    recording_id: recordings.get(t.id)?.id || null
  };
}
const page = async (id, method, p = {}) => {
  await allowed(await chrome.tabs.get(id));
  try {
    const [r] = await chrome.scripting.executeScript({
      target: {
        tabId: id
      },
      func: pageAction,
      args: [method, p]
    });
    if (!r.result?.ok) throw new Error(r.result?.error || 'INTERNAL: Page script returned no result');
    return r.result.result;
  } catch (e) {
    if (/(REF_NOT_FOUND|ELEMENT_NOT_FOUND|ELEMENT_NOT_INTERACTABLE|UNKNOWN_METHOD):/.test(e.message)) throw e;
    throw new Error(`BAD_PARAMS: ${e.message}`);
  }
};
async function badge(id) {
  await chrome.action.setBadgeText({
    tabId: id,
    text: recordings.has(id) ? 'REC' : handed.has(id) ? 'ON' : ''
  }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({
    tabId: id,
    color: recordings.has(id) ? '#b3261e' : '#40566b'
  }).catch(() => {});
}
function item(id, kind, data) {
  const r = recordings.get(id);
  if (!r) return;
  if (kind === 'dom' && !r.dom) return;
  const safe = redact(data);
  r.queue.push({
    ...safe,
    seq: ++r.count,
    at: Number.isFinite(safe.at) ? safe.at : Date.now(),
    kind,
    tab_id: id,
    url: safe.url || r.url
  });
  if (r.queue.length >= 200) flush(r);
}
function flush(r) {
  while (r.queue.length) {
    const batch = [];
    let bytes = 0;
    while (r.queue.length && batch.length < 200) {
      const next = r.queue[0],
        size = new TextEncoder().encode(JSON.stringify(next)).length;
      if (batch.length && bytes + size > 28 * 1024 * 1024) break;
      batch.push(r.queue.shift());
      bytes += size;
    }
    event('record.items', {
      recording_id: r.id,
      items: batch
    });
  }
}
setCaptureEmitter((id, kind, data) => {
  const r = recordings.get(id);
  if (r && (!['request', 'response', 'ws'].includes(kind) || r.network)) item(id, kind, data);
});
async function stopRecord(id, reason) {
  const r = recordings.get(id);
  if (!r) return null;
  recordings.delete(id);
  clearInterval(r.timer);
  flush(r);
  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: id
      },
      func: () => globalThis.__tagentRecorder?.stop()
    });
  } catch {/* Navigated or closed. */}
  if (!captures.get(id)?.manual) await detach(id);
  await badge(id);
  if (reason) event('record.stopped', {
    recording_id: r.id,
    reason
  });
  return {
    recording_id: r.id,
    items: r.count,
    duration_ms: Date.now() - r.started
  };
}
async function release(id) {
  await stopRecord(id, 'taken back');
  await detach(id);
  handed.delete(id);
  owned.delete(id);
  await persist();
  await badge(id);
  event('tab.released', {
    tab_id: id
  });
}
async function install(id) {
  const r = recordings.get(id);
  if (r) await chrome.scripting.executeScript({
    target: {
      tabId: id
    },
    func: installRecorder,
    args: [r.id]
  });
}
async function waitLoaded(id, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(id);
    if (t.status === 'complete') return t;
    await new Promise(r => setTimeout(r, 50));
  }
  fail('TIMEOUT', 'Navigation timed out');
}
const modifiers = p => (p.modifiers || []).reduce((n, m) => n | ({
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8
}[m] || 0), 0);
export async function dispatch(method, p = {}) {
  await ready;
  if (!methods.includes(method)) fail('UNKNOWN_METHOD', method);
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('BAD_PARAMS', 'params must be an object');
  for (const key of ['max_bytes', 'max_body_bytes', 'limit', 'timeout_ms', 'network_idle_ms']) if (p[key] !== undefined && (!Number.isInteger(p[key]) || p[key] < 0)) fail('BAD_PARAMS', `${key} must be a non-negative integer`);
  if (method === 'input.type' && typeof p.text !== 'string') fail('BAD_PARAMS', 'text must be a string');
  if (method === 'input.press' && (typeof p.key !== 'string' || !p.key)) fail('BAD_PARAMS', 'key is required');
  if (method === 'input.select' && !Array.isArray(p.values)) fail('BAD_PARAMS', 'values must be an array');
  if (method === 'page.query' && typeof p.selector !== 'string') fail('BAD_PARAMS', 'selector is required');
  if (p.mode && !['outline', 'text', 'html'].includes(p.mode)) fail('BAD_PARAMS', 'Unknown snapshot mode');
  if (p.button && !['left', 'right', 'middle'].includes(p.button)) fail('BAD_PARAMS', 'Unknown mouse button');
  if (p.count !== undefined && (!Number.isInteger(p.count) || p.count < 1 || p.count > 3)) fail('BAD_PARAMS', 'count must be 1, 2, or 3');
  if (p.modifiers !== undefined && (!Array.isArray(p.modifiers) || p.modifiers.some(m => !['Control', 'Meta', 'Shift', 'Alt'].includes(m)))) fail('BAD_PARAMS', 'Invalid modifiers');
  for (const types of [p.types, p.filter?.types]) if (types !== undefined && !Array.isArray(types)) fail('BAD_PARAMS', 'types must be an array');
  if (method === 'tabs.list') {
    const tabs = [];
    for (const t of await chrome.tabs.query({})) try {
      tabs.push(await tabInfo(t));
    } catch {/* Only allowed tabs. */}
    return {
      tabs
    };
  }
  if (method === 'tabs.open') {
    if (!scriptable(p.url)) fail('TAB_NOT_SCRIPTABLE', 'Use an HTTP or HTTPS page');
    const t = await chrome.tabs.create({
      url: p.url,
      active: p.active ?? false
    });
    owned.add(t.id);
    grouping.add(t.id);
    try {
      const groups = await chrome.tabGroups.query({
        title: 'T-Agent',
        windowId: t.windowId
      });
      const gid = await chrome.tabs.group({
        tabIds: [t.id],
        ...(groups[0] ? {
          groupId: groups[0].id
        } : {})
      });
      await chrome.tabGroups.update(gid, {
        title: 'T-Agent',
        color: 'blue'
      });
      await persist();
      lastTab = t.id;
      return {
        tab: await tabInfo(await chrome.tabs.get(t.id))
      };
    } catch (e) {
      owned.delete(t.id);
      await chrome.tabs.remove(t.id);
      throw e;
    } finally {
      grouping.delete(t.id);
    }
  }
  if (method === 'record.stop' && p.recording_id) {
    const r = [...recordings].find(([, v]) => v.id === p.recording_id);
    if (!r) fail('NOT_CAPTURING', 'Recording not found');
    p = {
      ...p,
      tab_id: r[0]
    };
  }
  const t = await getTab(p.tab_id),
    id = t.id;
  if (method === 'tabs.close') {
    if (handed.has(id)) {
      await release(id);
      return {
        released: true
      };
    }
    await chrome.tabs.remove(id);
    return {};
  }
  if (method === 'tabs.activate') {
    await chrome.tabs.update(id, {
      active: true
    });
    await chrome.windows.update(t.windowId, {
      focused: true
    });
    return {
      tab: await tabInfo(await chrome.tabs.get(id))
    };
  }
  if (method === 'tabs.navigate') {
    if (p.url && !scriptable(p.url)) fail('TAB_NOT_SCRIPTABLE', 'Use an HTTP or HTTPS page');
    if (p.action === 'back') await chrome.tabs.goBack(id);else if (p.action === 'forward') await chrome.tabs.goForward(id);else if (p.action === 'reload') await chrome.tabs.reload(id);else if (p.url) await chrome.tabs.update(id, {
      url: p.url
    });else fail('BAD_PARAMS', 'Supply url or action');
    return {
      tab: await tabInfo(p.wait === 'none' ? await chrome.tabs.get(id) : await waitLoaded(id))
    };
  }
  if (method === 'page.eval') {
    if (typeof p.expression !== 'string') fail('BAD_PARAMS', 'expression is required');
    let value, valueType;
    try {
      if (captures.has(id)) {
        const r = await cdp(id, 'Runtime.evaluate', {
          expression: p.expression,
          awaitPromise: p.await_promise ?? true,
          returnByValue: true
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        value = r.result.value;
        valueType = r.result.type;
      } else {
        const [r] = await chrome.scripting.executeScript({
          target: {
            tabId: id
          },
          world: 'MAIN',
          func: async (expression, wait) => {
            try {
              let v = (0, eval)(expression);
              if (wait) v = await v;
              return {
                ok: true,
                value: JSON.parse(JSON.stringify(v) ?? 'null'),
                type: v === null ? 'null' : typeof v
              };
            } catch (error) {
              return {
                ok: false,
                error: error.message
              };
            }
          },
          args: [p.expression, p.await_promise ?? true]
        });
        if (!r.result?.ok) throw new Error(r.result?.error || 'Evaluation failed');
        value = r.result.value;
        valueType = r.result.type;
      }
      value = redact(value);
      const type = valueType || (value === null ? 'null' : typeof value);
      const c = cut(JSON.stringify(value) ?? 'null', 1048576);
      return {
        value: c.truncated ? c.text : value ?? null,
        type,
        truncated: c.truncated
      };
    } catch (e) {
      fail('EVAL_FAILED', e.message);
    }
  }
  if (method === 'page.fetch') {
    const [r] = await chrome.scripting.executeScript({
      target: {
        tabId: id
      },
      world: 'MAIN',
      func: async p => {
        try {
          const r = await fetch(p.url, {
            method: p.method || 'GET',
            headers: p.headers || {},
            body: p.body,
            credentials: p.credentials || 'include'
          });
          const data = new Uint8Array(await r.arrayBuffer()),
            limit = 2097152,
            b = data.slice(0, limit),
            text = /text|json|xml|javascript|form/.test(r.headers.get('content-type') || '');
          return {
            ok: true,
            value: {
              status: r.status,
              headers: Object.fromEntries(r.headers),
              ...(text ? {
                body: new TextDecoder().decode(data)
              } : {
                body_base64: btoa(Array.from(b, c => String.fromCharCode(c)).join(''))
              }),
              truncated: data.length > limit
            }
          };
        } catch (error) {
          return {
            ok: false,
            error: error.message
          };
        }
      },
      args: [p]
    });
    if (!r.result?.ok) fail('EVAL_FAILED', r.result?.error || 'Fetch failed');
    const value = redact(r.result.value);
    if (value.body !== undefined) {
      const c = cut(value.body, 2097152);
      value.body = c.text;
      value.truncated ||= c.truncated;
    }
    return value;
  }
  if (method === 'net.start') {
    const s = await attach(id, p);
    s.manual = true;
    return {
      capturing: true
    };
  }
  if (method === 'net.stop') {
    const s = captures.get(id);
    if (!s) fail('NOT_CAPTURING', 'Capture is not running');
    const count = s.requests.size;
    s.manual = false;
    if (!recordings.has(id)) await detach(id);
    return {
      count
    };
  }
  if (method === 'net.list' || method === 'net.get' || method === 'page.console') {
    const s = captures.get(id);
    if (!s) fail('NOT_CAPTURING', 'Start capture first');
    if (method === 'page.console') return {
      entries: s.console.filter(e => !p.since || e.at >= p.since).slice(-Math.max(1, Math.min(p.limit ?? 200, 2000)))
    };
    if (method === 'net.list') return {
      requests: [...s.requests.values()].filter(r => matches(r, p)).slice(-Math.max(1, Math.min(p.limit ?? 200, 2000))).map(summary)
    };
    const r = s.requests.get(p.req_id);
    if (!r) fail('REQUEST_NOT_FOUND', 'Request not found');
    return p.raw ? detail(r, p.body !== false, true) : redact(detail(r, p.body !== false));
  }
  if (method === 'record.start') {
    if (recordings.has(id)) fail('BAD_PARAMS', 'Recording already running');
    await attach(id, {
      bodies: p.bodies ?? true
    });
    const r = {
      id: `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`,
      started: Date.now(),
      count: 0,
      queue: [],
      url: t.url,
      dom: p.dom ?? true,
      network: p.network ?? true
    };
    recordings.set(id, r);
    r.timer = setInterval(() => flush(r), 1000);
    try {
      await install(id);
    } catch (e) {
      await stopRecord(id);
      throw e;
    }
    await badge(id);
    return {
      recording_id: r.id
    };
  }
  if (method === 'record.stop') {
    const r = await stopRecord(id, 'stopped');
    if (!r) fail('NOT_CAPTURING', 'Recording not running');
    return r;
  }
  if (method === 'debug.detach') {
    await stopRecord(id, 'detached');
    await detach(id);
    return {};
  }
  if (method === 'page.wait') {
    if (!p.selector && !p.text && !p.url_includes && p.network_idle_ms === undefined) fail('BAD_PARAMS', 'Supply a wait condition');
    const temporary = p.network_idle_ms !== undefined && !captures.has(id);
    if (temporary) await attach(id, {
      bodies: false
    });
    try {
      const start = Date.now(),
        timeout = Math.min(p.timeout_ms ?? 15000, 120000);
      while (Date.now() - start < timeout) {
        const matched = await page(id, 'page.wait.check', p);
        if (matched) return {
          matched
        };
        const s = captures.get(id);
        if (p.network_idle_ms !== undefined && s && !s.active && Date.now() - s.lastActivity >= p.network_idle_ms) return {
          matched: 'network_idle'
        };
        await new Promise(r => setTimeout(r, 100));
      }
      fail('TIMEOUT', 'Wait timed out');
    } finally {
      if (temporary && !recordings.has(id) && !captures.get(id)?.manual) await detach(id);
    }
  }
  if (method === 'page.screenshot') {
    const format = p.format || 'png';
    if (!['png', 'jpeg'].includes(format)) fail('BAD_PARAMS', 'Unsupported screenshot format');
    if (!p.full_page && !p.target) {
      if (!t.active) fail('BAD_PARAMS', 'Activate the tab before a visible screenshot');
      const data = await chrome.tabs.captureVisibleTab(t.windowId, {
        format,
        ...(p.quality !== undefined ? {
          quality: p.quality
        } : {})
      });
      if (!(await chrome.tabs.get(id)).active) fail('BAD_PARAMS', 'Active tab changed during capture');
      const v = await page(id, 'viewport');
      return {
        data_base64: data.split(',')[1],
        mime: `image/${format}`,
        width: Math.round(v.width * v.device_scale_factor),
        height: Math.round(v.height * v.device_scale_factor)
      };
    }
    const temporary = !captures.has(id);
    if (temporary) await attach(id, {
      bodies: false
    });
    try {
      let clip;
      if (p.target) {
        const d = await page(id, 'resolve', p);
        const m = await cdp(id, 'Page.getLayoutMetrics');
        clip = {
          x: d.rect.x + m.cssLayoutViewport.pageX,
          y: d.rect.y + m.cssLayoutViewport.pageY,
          width: d.rect.w,
          height: d.rect.h,
          scale: 1
        };
      } else {
        const m = await cdp(id, 'Page.getLayoutMetrics');
        clip = {
          ...m.cssContentSize,
          scale: 1
        };
      }
      const r = await cdp(id, 'Page.captureScreenshot', {
        format,
        captureBeyondViewport: true,
        clip,
        ...(p.quality !== undefined ? {
          quality: p.quality
        } : {})
      });
      return {
        data_base64: r.data,
        mime: `image/${format}`,
        width: Math.round(clip.width),
        height: Math.round(clip.height)
      };
    } finally {
      if (temporary && !recordings.has(id) && !captures.get(id)?.manual) await detach(id);
    }
  }
  if (captures.has(id) && ['input.click', 'input.hover', 'input.type', 'input.press', 'input.scroll'].includes(method)) {
    if (method === 'input.press') {
      await cdp(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: p.key,
        modifiers: modifiers(p),
        windowsVirtualKeyCode: {
          Enter: 13,
          Tab: 9,
          Escape: 27,
          ArrowLeft: 37,
          ArrowUp: 38,
          ArrowRight: 39,
          ArrowDown: 40
        }[p.key] || p.key.toUpperCase().charCodeAt(0),
        ...(p.key === 'Enter' ? {
          text: '\r'
        } : {})
      });
      await cdp(id, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: p.key,
        modifiers: modifiers(p)
      });
      return {};
    }
    const d = await page(id, 'resolve', {
      ...p,
      focus: method === 'input.type',
      editable: method === 'input.type',
      target: p.target || {
        x: 10,
        y: 10
      }
    });
    const x = p.target?.x ?? d.rect.x + d.rect.w / 2,
      y = p.target?.y ?? d.rect.y + d.rect.h / 2;
    if (method === 'input.type') {
      if (p.clear) await page(id, 'input.type', {
        ...p,
        text: '',
        clear: true,
        submit: false
      });
      await cdp(id, 'Input.insertText', {
        text: p.text
      });
      if (p.submit) await dispatch('input.press', {
        tab_id: id,
        key: 'Enter'
      });
      return {};
    }
    if (method === 'input.scroll') await cdp(id, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: p.dx ?? 0,
      deltaY: p.dy ?? 600
    });else if (method === 'input.hover') await cdp(id, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      modifiers: modifiers(p)
    });else for (let n = 1; n <= (p.count ?? 1); n++) {
      await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: p.button || 'left',
        clickCount: n,
        modifiers: modifiers(p)
      });
      await cdp(id, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: p.button || 'left',
        clickCount: n,
        modifiers: modifiers(p)
      });
    }
    return method === 'input.click' ? {
      clicked: {
        ref: d.ref,
        tag: d.tag,
        name: d.name
      }
    } : {};
  }
  return page(id, method, p);
}
async function connect() {
  await ready;
  if (blocked || socket?.readyState === 0 || socket?.readyState === 1) return;
  const config = await chrome.storage.local.get(['server_url', 'token', 'name']);
  if (!config.token) {
    status = 'needs pairing';
    return;
  }
  try {
    const u = new URL('/api/browser-ext/ws', config.server_url || 'http://127.0.0.1:3000');
    if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('Use a loopback server');
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(u);
    status = 'connecting';
  } catch {
    status = 'invalid server URL';
    return;
  }
  const ws = socket;
  ws.onopen = () => {
    send({
      type: 'hello',
      token: config.token,
      version: '1.0.0',
      protocol: 1,
      browser: {
        name: config.name || `Chrome on ${navigator.platform}`,
        user_agent: navigator.userAgent
      },
      methods
    }, true);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({
      type: 'ping'
    }), 20000);
  };
  ws.onmessage = async e => {
    if (typeof e.data !== 'string' || new TextEncoder().encode(e.data).length > 32 * 1024 * 1024) return;
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === 'welcome') {
      status = 'connected';
      retry = 0;
      return;
    }
    if (m.type !== 'cmd') return;
    let timer;
    try {
      const result = await Promise.race([dispatch(m.method, m.params || {}), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT: Command timed out')), Math.max(1, Math.min(m.timeout_ms ?? 30000, 120000)));
      })]);
      send({
        type: 'result',
        id: m.id,
        ok: true,
        result
      }, m.method === 'net.get' && m.params?.raw === true);
    } catch (e) {
      const match = e.message.match(/(TAB_NOT_ALLOWED|TAB_NOT_FOUND|TAB_NOT_SCRIPTABLE|REF_NOT_FOUND|ELEMENT_NOT_FOUND|ELEMENT_NOT_INTERACTABLE|TIMEOUT|EVAL_FAILED|DEBUGGER_BUSY|NOT_CAPTURING|REQUEST_NOT_FOUND|BAD_PARAMS|UNKNOWN_METHOD|INTERNAL):\s*(.*)/s);
      send({
        type: 'result',
        id: m.id,
        ok: false,
        error: {
          code: match?.[1] || 'INTERNAL',
          message: match?.[2] || e.message
        }
      });
    } finally {
      clearTimeout(timer);
    }
  };
  ws.onclose = async e => {
    if (socket !== ws) return;
    clearInterval(pingTimer);
    socket = null;
    if (e.code === 4401) {
      clearTimeout(retryTimer);
      blocked = true;
      status = 'needs pairing';
      await persist();
      return;
    }
    status = 'disconnected';
    schedule();
  };
  ws.onerror = () => ws.close();
}
function schedule() {
  clearTimeout(retryTimer);
  if (!blocked) retryTimer = setTimeout(connect, [1000, 2000, 5000, 10000, 30000][Math.min(retry++, 4)]);
}
chrome.alarms.create('browser-reconnect', {
  periodInMinutes: 1
});
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'browser-reconnect') void connect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.server_url)) {
    blocked = false;
    void persist();
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    void connect();
  }
});
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const run = async () => {
    await ready;
    if (m.type === 'record.item') {
      const id = sender.tab?.id,
        r = recordings.get(id);
      if (r?.id === m.recording_id) {
        await allowed(await chrome.tabs.get(id));
        if (m.item.kind !== 'nav') item(id, m.item.kind, m.item);
      }
      return {};
    }
    if (!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) && sender.tab) return {};
    if (m.type === 'status') return {
      status,
      blocked
    };
    if (m.type === 'popup.state') {
      const [t] = await chrome.tabs.query({
        active: true,
        currentWindow: true
      });
      let how = null;
      try {
        how = await allowed(t);
      } catch {/* No permission. */}
      return {
        tab_id: t?.id,
        how,
        status,
        scriptable: scriptable(t?.url),
        recording: recordings.has(t?.id)
      };
    }
    if (m.type === 'handover') {
      const t = await chrome.tabs.get(m.tab_id);
      if (!scriptable(t.url)) fail('TAB_NOT_SCRIPTABLE', 'This page cannot be controlled');
      handed.add(t.id);
      await persist();
      await badge(t.id);
      event('tab.handed', {
        tab_id: t.id,
        url: t.url,
        title: t.title
      });
      return {};
    }
    if (m.type === 'takeback') {
      await release(m.tab_id);
      return {};
    }
    return {};
  };
  run().then(reply, e => reply({
    error: e.message
  }));
  return true;
});
chrome.tabs.onRemoved.addListener(id => {
  void (async () => {
    await ready;
    const was = owned.has(id) || handed.has(id);
    await stopRecord(id, 'tab closed');
    await detach(id);
    owned.delete(id);
    handed.delete(id);
    await persist();
    if (lastTab === id) lastTab = undefined;
    if (was) event('tab.closed', {
      tab_id: id
    });
  })();
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  void (async () => {
    await ready;
    if (grouping.has(id) || !owned.has(id) && !handed.has(id)) return;
    if (change.groupId !== undefined) try {
      await allowed(tab);
    } catch {
      await stopRecord(id, 'tab released');
      await detach(id);
      owned.delete(id);
      await persist();
    }
    if (change.url) {
      if (recordings.has(id)) {
        const r = recordings.get(id);
        item(id, 'nav', {
          from: r.url,
          to: change.url,
          transition: change.status === 'loading' ? 'navigation' : 'history'
        });
        r.url = change.url;
      }
      if (!scriptable(change.url)) {
        await stopRecord(id, 'page not scriptable');
        await detach(id);
      } else try {
        await page(id, 'invalidate');
      } catch {/* A new document is loading. */}
    }
    if (change.status === 'complete') try {
      await allowed(tab);
      await install(id);
    } catch {/* Protected page or released. */}
  })();
});
chrome.debugger.onDetach.addListener(source => {
  const s = captures.get(source.tabId);
  captures.delete(source.tabId);
  if (s) void stopRecord(source.tabId, 'debugger detached');
});
void connect();
chrome.tabGroups.onUpdated.addListener(group => {
  if (group.title !== 'T-Agent') void (async () => {
    for (const t of await chrome.tabs.query({
      groupId: group.id
    })) if (owned.has(t.id) && !handed.has(t.id) && !grouping.has(t.id)) {
      await stopRecord(t.id, 'tab released');
      await detach(t.id);
      owned.delete(t.id);
    }
    await persist();
  })();
});
