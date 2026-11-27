import { redact, cut } from './redact.js';
import { pageAction, installRecorder } from './page.js';
import { captures, cdp, attach, detach, setCaptureEmitter, setPageListener, summary, detail, matches, takeDialogs } from './capture.js';
import { runAction, ACTION_METHODS } from './actions.js';
// Features beyond the method names, sent in the hello: the bridge refuses a new option that an older extension would silently ignore
// (PARAM_FEATURES in services/browser-bridge.js). 1.0.4: `tabs.open` with `record`, record type filters and a body size limit, agent
// actions in recordings (source 'agent' / 'user'), click target context and the texts of what appeared in DOM change items.
// 1.0.5 ("Focus and closing" in docs/design/browser-extension.md): tabs open in T-Agent's own background window, `tabs.open` with `keep`,
// `tabs.close` with `auto` (closes only an owned tab that is not kept), a visible screenshot of a tab that is not active, page dialogs answered
// while the debugger is attached, `tab.used` when the person uses a T-Agent tab, and the `reload` request of the bridge.
// 1.0.7: a closed T-Agent tab leaves its group first (`closeTab`), so Chrome keeps no saved "T-Agent" group in the bookmarks bar.
// 1.0.6: `tabs.open` with `window` ('front' / 'back': a recording's own window, "The recording's own window" in docs/design/browser-extension.md)
// and recordings that follow the tabs and windows the recorded page opens (`tab.opened`, "A recording follows the windows the page opens").
// 1.0.8 ("Actions: drag, upload, fill, check, dialogs" in docs/design/browser-extension.md): the methods input.drag, input.upload,
// input.fill, input.check and page.dialog (actions.js); page.screenshot with `zoom` / `scale` and `annotate`; page.snapshot with `filter`
// and `diff`, elements of open shadow roots and same-origin iframes, and refs that stay the same for the same node; page.console with
// `pattern` and `levels`.
export const features = ['open.record', 'record.types', 'record.max_body', 'record.agent_actions', 'record.dom_text', 'open.keep', 'close.auto', 'shot.inactive', 'dialog.answer', 'tab.used', 'reload', 'open.window', 'record.tabs', 'input.drag', 'input.upload', 'input.fill', 'input.check', 'page.dialog', 'shot.zoom', 'shot.annotate', 'snapshot.filter', 'snapshot.diff', 'snapshot.frames', 'snapshot.stable_refs', 'console.filter'];
export const methods = ['tabs.list', 'tabs.open', 'tabs.close', 'tabs.navigate', 'tabs.activate', 'page.snapshot', 'page.query', 'input.click', 'input.type', 'input.press', 'input.hover', 'input.scroll', 'input.select', 'page.eval', 'page.wait', 'page.screenshot', 'page.console', 'net.start', 'net.stop', 'net.list', 'net.get', 'page.fetch', 'record.start', 'record.stop', 'debug.detach', 'tabs.reveal', ...ACTION_METHODS];
const recordings = new Map(),
  owned = new Set(),
  handed = new Set(),
  grouping = new Set(),
  // Owned tabs opened with `keep` (tcli browser open --keep, or a recorded tab the person used): never closed automatically.
  kept = new Set(),
  // Owned tabs that a recorded tab opened (a popup, a target=_blank link, window.open): tab id -> the tab that opened it. They joined that
  // recording, stay where Chrome put them (maybe a popup window, outside any group) and are T-Agent tabs like the ones it opens itself.
  joined = new Map(),
  // Tab id -> until when an activation of that tab is T-Agent's own (open, activate, a new window's first tab), not the person's.
  quietUntil = new Map(),
  // Tab id -> number of commands running on it, and until when its trusted input events are still the command's own (CDP input).
  busy = new Map(),
  calmUntil = new Map(),
  // Window id -> when a tab of it was closed or moved out last: Chrome then activates a neighbour by itself.
  removedAt = new Map();
let lastTab,
  socket,
  retry = 0,
  retryTimer,
  pingTimer,
  blocked = false,
  status = 'needs pairing',
  // The window T-Agent opens its tabs in, behind the person's windows ("Focus and closing" in docs/design/browser-extension.md).
  agentWindowId = null,
  windowLock = null,
  inflight = 0,
  reloadWanted = false;
const RELOAD_STATE_MS = 2 * 60000;
const ready = (async () => {
  const s = await chrome.storage.session.get(['handed', 'owned', 'kept', 'joined', 'agent_window', 'blocked']);
  // chrome.storage.session is cleared when the extension reloads itself (the bridge's `reload`): the state written just before it comes back.
  let saved = null;
  try {
    saved = (await chrome.storage.local.get(['reload_state'])).reload_state || null;
    if (saved) await chrome.storage.local.remove?.('reload_state');
  } catch {/* No saved state. */}
  const fresh = saved && Date.now() - saved.at < RELOAD_STATE_MS ? saved : {};
  for (const id of [...(s.handed || []), ...(fresh.handed || [])]) handed.add(id);
  for (const id of [...(s.owned || []), ...(fresh.owned || [])]) owned.add(id);
  for (const id of [...(s.kept || []), ...(fresh.kept || [])]) kept.add(id);
  for (const [id, opener] of [...(s.joined || []), ...(fresh.joined || [])]) if (owned.has(id)) joined.set(id, opener);
  agentWindowId = Number.isInteger(s.agent_window) ? s.agent_window : Number.isInteger(fresh.agent_window) ? fresh.agent_window : null;
  blocked = !!s.blocked;
})();
const persist = () => chrome.storage.session.set({
  handed: [...handed],
  owned: [...owned],
  kept: [...kept],
  joined: [...joined],
  agent_window: agentWindowId,
  blocked
});
const quiet = (id, ms = 1500) => quietUntil.set(id, Date.now() + ms);
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
  if (owned.has(t.id) && joined.has(t.id)) return 'group';
  if (owned.has(t.id) && t.groupId >= 0) {
    const g = await chrome.tabGroups.get(t.groupId);
    if (g.title === 'T-Agent') return 'group';
  }
  fail('TAB_NOT_ALLOWED', 'Hand this tab over using the extension button');
}
// Closes a tab of T-Agent's group. Chrome keeps the group of a closed tab as a saved tab group in the bookmarks bar (it only forgets it when the
// group is emptied by ungrouping), so the tab leaves the group first: no empty "T-Agent" group is left behind ("Focus and closing" in
// docs/design/browser-extension.md).
async function closeTab(id) {
  try {
    await chrome.tabs.ungroup(id);
  } catch {/* Not grouped, or already closed. */}
  await chrome.tabs.remove(id);
}
async function getTab(id) {
  await ready;
  if (id === undefined) {
    if (lastTab !== undefined) id = lastTab;else {
      // The active tab of the person's window when it may be used, else the T-Agent tab used last (they live in a window behind).
      const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
      });
      const others = (await chrome.tabs.query({})).filter(t => owned.has(t.id) || handed.has(t.id)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      for (const t of [...tabs, ...others]) try {
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
    ...(kept.has(t.id) ? {
      keep: true
    } : {}),
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
    if (/^(REF_NOT_FOUND|ELEMENT_NOT_FOUND|ELEMENT_NOT_INTERACTABLE|UNKNOWN_METHOD|BAD_PARAMS):/.test(e.message)) throw e;
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
// The address a recorded tab shows now: r.url for the tab the recording started in, r.tabs for the tabs it opened.
const urlOf = (r, id) => id === r.main ? r.url : r.tabs.get(id)?.url;
function setUrl(r, id, url) {
  if (id === r.main) r.url = url;else if (r.tabs.has(id)) r.tabs.get(id).url = url;
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
    // The tab of the item: a recording follows the tabs its page opens, so its items come from several tabs.
    tab: id,
    url: safe.url || urlOf(r, id)
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
// The network items of a recording, after its filters ("Recording" in docs/design/browser-extension.md): a request of a type outside
// `types` keeps its item but loses its bodies (`body_omitted: 'type'`), or is dropped with `drop_other_types`; bodies over `max_body_bytes`
// are cut (`body_truncated: true`; `body_bytes` / `post_data_bytes` keep the size before the cut).
const cutBase64 = (b64, bytes) => b64.slice(0, Math.floor(bytes / 3) * 4);
export function shapeNetwork(r, kind, data) {
  if (kind === 'request') return !r.types || r.types.has(String(data.type || '').toLowerCase()) || !r.dropOthers ? data : null;
  const wanted = !r.types || r.types.has(kind === 'ws' ? 'websocket' : String(data.type || '').toLowerCase());
  if (!wanted && r.dropOthers) return null;
  if (wanted && r.maxBody === null) return data;
  const out = { ...data };
  const fit = (holder, key, flag) => {
    if (typeof holder[key] !== 'string') return;
    const c = cut(holder[key], r.maxBody);
    if (c.truncated) {
      holder[key] = c.text;
      holder[flag] = true;
    }
  };
  if (kind === 'ws') {
    if (wanted) fit(out, 'data', 'truncated');else {
      delete out.data;
      out.body_omitted = 'type';
    }
    return out;
  }
  out.request = { ...data.request };
  out.response = { ...data.response };
  if (Array.isArray(data.frames)) out.frames = data.frames.map(f => ({ ...f }));
  if (!wanted) {
    delete out.request.post_data;
    delete out.response.body;
    delete out.response.body_base64;
    if (out.frames) for (const f of out.frames) delete f.data;
    out.body_omitted = 'type';
    return out;
  }
  fit(out.request, 'post_data', 'post_data_truncated');
  fit(out.response, 'body', 'body_truncated');
  if (typeof out.response.body_base64 === 'string' && out.response.body_base64.length > Math.ceil(r.maxBody / 3) * 4) {
    out.response.body_base64 = cutBase64(out.response.body_base64, r.maxBody);
    out.response.body_truncated = true;
  }
  if (out.frames) for (const f of out.frames) fit(f, 'data', 'truncated');
  return out;
}
setCaptureEmitter((id, kind, data) => {
  const r = recordings.get(id);
  if (!r) return;
  if (['request', 'response', 'ws'].includes(kind)) {
    if (!r.network) return;
    data = shapeNetwork(r, kind, data);
    if (!data) return;
  }
  item(id, kind, data);
});
// A recorded tab committed a new document (or reached DOMContentLoaded): the page recorder goes in at once, so the DOM changes and the
// person's actions of the first load are recorded too. installRecorder is a no-op when it already runs for this recording.
setPageListener((id, event, url) => {
  if (!recordings.has(id) || !owned.has(id) && !handed.has(id)) return;
  if (event === 'commit' && !scriptable(url)) return;
  void install(id, true).catch(() => {});
});
// One tab leaves its recording: its page recorder stops and the debugger detaches (unless `net start` runs there).
async function untrack(id) {
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
}
// Stops the recording that tab `id` is in. A tab the recorded page opened only leaves the recording (it closed, went to a page that
// cannot be recorded, the debugger left it): the recording goes on in its other tabs. `all: true` (record.stop) stops it in every tab.
async function stopRecord(id, reason, {
  all = false
} = {}) {
  const r = recordings.get(id);
  if (!r) return null;
  if (id !== r.main && !all) {
    if (reason === 'tab closed') item(id, 'tab', {
      action: 'closed',
      tab: id,
      opener: r.tabs.get(id)?.opener ?? null
    });
    recordings.delete(id);
    r.tabs.delete(id);
    await untrack(id);
    return null;
  }
  const ids = [r.main, ...r.tabs.keys()];
  for (const tab of ids) recordings.delete(tab);
  r.tabs.clear();
  clearInterval(r.timer);
  flush(r);
  for (const tab of ids) await untrack(tab);
  watchEarly();
  if (reason) event('record.stopped', {
    recording_id: r.id,
    reason
  });
  maybeReload();
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
  joined.delete(id);
  kept.delete(id);
  await persist();
  await badge(id);
  event('tab.released', {
    tab_id: id
  });
}
async function install(id, immediate = false) {
  const r = recordings.get(id);
  if (r) await chrome.scripting.executeScript({
    target: {
      tabId: id
    },
    func: installRecorder,
    args: [r.id, {
      dom: r.dom
    }],
    ...(immediate ? {
      injectImmediately: true
    } : {})
  });
}
// The options of record.start and of tabs.open's `record`, checked. `types` are CDP resource types (Document, XHR, Fetch, Script, ...), any case.
function recordOptions(p) {
  for (const key of ['network', 'dom', 'bodies', 'drop_other_types']) if (p[key] !== undefined && typeof p[key] !== 'boolean') fail('BAD_PARAMS', `${key} must be true or false`);
  const o = {
    network: p.network ?? true,
    dom: p.dom ?? true,
    bodies: p.bodies ?? true,
    types: null,
    dropOthers: false,
    maxBody: null
  };
  if (p.types !== undefined) {
    if (!Array.isArray(p.types) || !p.types.length || p.types.length > 32 || p.types.some(type => typeof type !== 'string' || !/^[A-Za-z]{1,32}$/.test(type))) fail('BAD_PARAMS', 'types must be a list of resource types such as XHR, Fetch, Document');
    o.types = new Set(p.types.map(type => type.toLowerCase()));
  }
  if (p.drop_other_types) {
    if (!o.types) fail('BAD_PARAMS', 'drop_other_types needs types');
    o.dropOthers = true;
  }
  if (p.max_body_bytes !== undefined) {
    if (!Number.isInteger(p.max_body_bytes) || p.max_body_bytes < 0) fail('BAD_PARAMS', 'max_body_bytes must be a non-negative integer');
    o.maxBody = Math.min(p.max_body_bytes, 2097152);
  }
  return o;
}
// Starts a recording of tab `id` (attaching the debugger). `inject: false` when the tab has no page yet (tabs.open with `record`): the
// recorder then goes in when the first document commits (setPageListener).
async function startRecording(id, p, url, {
  inject = true
} = {}) {
  if (recordings.has(id)) fail('BAD_PARAMS', 'Recording already running');
  const o = recordOptions(p);
  const fresh = !captures.has(id);
  // A capture that `net start` runs keeps its own body rules; the recording's filters then apply to its items only (shapeNetwork).
  await attach(id, {
    bodies: o.bodies,
    ...(fresh ? {
      body_types: o.types ? [...o.types] : null,
      ...(o.maxBody !== null ? {
        max_body_bytes: o.maxBody
      } : {})
    } : {})
  });
  const r = {
    id: `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`,
    started: Date.now(),
    count: 0,
    queue: [],
    url,
    // The tab the recording started in, and the tabs it opened that joined it (tab id -> { url, opener }); `opened` counts every tab that
    // joined, for the limit of MAX_RECORDING_TABS.
    main: id,
    tabs: new Map(),
    opened: 0,
    dom: o.dom,
    network: o.network,
    types: o.types,
    dropOthers: o.dropOthers,
    maxBody: o.maxBody,
    options: {
      network: o.network,
      dom: o.dom,
      bodies: o.bodies,
      types: o.types ? [...o.types] : null,
      drop_other_types: o.dropOthers,
      max_body_bytes: o.maxBody
    }
  };
  recordings.set(id, r);
  watchEarly();
  r.timer = setInterval(() => flush(r), 1000);
  if (inject) try {
    await install(id);
  } catch (e) {
    await stopRecord(id);
    throw e;
  }
  await badge(id);
  return r;
}
// A recording follows the tabs and windows its page opens ("A recording follows the windows the page opens" in
// docs/design/browser-extension.md): a tab whose opener is a recorded tab joins the same recording at once (chrome.tabs.onCreated with
// openerTabId, chrome.webNavigation.onCreatedNavigationTarget for popup windows, which Chrome reports without an opener tab), with the
// debugger attached before its first document commits where Chrome allows it. It stays where Chrome put it, is owned (closed by the same
// rules, kept when the person uses it) and its items carry its `tab`. At most MAX_RECORDING_TABS tabs per recording, popups of popups included.
const MAX_RECORDING_TABS = 10;
const joinable = url => !url || url === 'about:blank' || scriptable(url);
function join(sourceId, id, url) {
  const r = recordings.get(sourceId);
  if (!r || !Number.isInteger(id) || recordings.has(id) || owned.has(id) || handed.has(id) || !joinable(url)) return;
  if (r.opened >= MAX_RECORDING_TABS - 1) {
    if (!r.capped) item(sourceId, 'tab', {
      action: 'opened',
      tab: id,
      opener: sourceId,
      url: url || 'about:blank',
      recorded: false,
      reason: `at most ${MAX_RECORDING_TABS} tabs per recording`
    });
    r.capped = true;
    return;
  }
  // Synchronous up to here, so the two events of the same new tab join it once.
  r.opened++;
  recordings.set(id, r);
  r.tabs.set(id, {
    url: url || 'about:blank',
    opener: sourceId,
    // Until the debugger is attached, chrome.webRequest records the tab's requests (earlyRequest).
    gap: true
  });
  owned.add(id);
  joined.set(id, sourceId);
  // A popup window takes the focus by itself: that activation is the page's, not the person's.
  quiet(id, 3000);
  item(id, 'tab', {
    action: 'opened',
    tab: id,
    opener: sourceId,
    url: url || 'about:blank'
  });
  event('tab.opened', {
    tab_id: id,
    opener_tab_id: sourceId,
    recording_id: r.id,
    url: url || 'about:blank'
  });
  for (const [kind, d] of early.get(id) || []) earlyRequest(kind, d);
  early.delete(id);
  void (async () => {
    await persist();
    try {
      await attach(id, {
        bodies: r.options.bodies,
        ...(!captures.has(id) ? {
          body_types: r.types ? [...r.types] : null,
          ...(r.maxBody !== null ? {
            max_body_bytes: r.maxBody
          } : {})
        } : {})
      });
    } catch {/* DevTools on that tab, or it closed: its page recorder still records it. */}
    const state = r.tabs.get(id);
    if (state && captures.has(id)) state.gap = false;
    if (recordings.get(id) !== r) {
      if (!captures.get(id)?.manual) await detach(id);
      return;
    }
    await badge(id);
    // The document may have committed before the debugger was there: the recorder goes in now (a no-op when it already runs).
    const t = await chrome.tabs.get(id).catch(() => null);
    if (t && scriptable(t.url)) await install(id, true).catch(() => {});
  })().catch(() => {});
}
// The first requests of an opened tab: Chrome often starts its first document (and the fetches of that page) before the debugger can attach,
// and no CDP command of the opener reaches a popup (Target.setAutoAttach on the opener reports frames and workers, not new windows). Until
// the debugger is attached, chrome.webRequest records them: a request and a response item with `via: 'webRequest'`, headers redacted as
// always, no bodies (`body_omitted: 'early'`). Events of tabs no recording knows yet wait EARLY_MS (they can come before tabs.onCreated).
// The listeners exist only while a recording runs (watchEarly), so the worker is never woken for the requests of the browser.
const EARLY_MS = 3000;
const early = new Map(),
  earlyIds = new Map();
const WR_TYPES = {
  main_frame: 'Document',
  sub_frame: 'Document',
  stylesheet: 'Stylesheet',
  script: 'Script',
  image: 'Image',
  font: 'Font',
  xmlhttprequest: 'Fetch',
  ping: 'Ping',
  media: 'Media',
  websocket: 'WebSocket'
};
const headerObject = list => Object.fromEntries((list || []).filter(h => h?.name).map(h => [h.name, h.value ?? '']));
function earlyRequest(kind, d) {
  const r = recordings.get(d.tabId),
    state = r?.tabs.get(d.tabId);
  if (!state) {
    if (recordings.has(d.tabId)) return;
    if (recordings.size && Number.isInteger(d.tabId) && d.tabId >= 0 && kind === 'request' || early.has(d.tabId)) {
      const list = early.get(d.tabId) || [];
      if (!list.length) setTimeout(() => early.delete(d.tabId), EARLY_MS);
      if (list.length < 50 && early.size < 20) list.push([kind, d]);
      if (list.length) early.set(d.tabId, list);
    }
    return;
  }
  const reqId = `wr-${d.requestId}`;
  // A request that started in the gap is finished here too; one that started after the debugger came is the debugger's.
  if (kind === 'request' ? !state.gap : earlyIds.get(reqId) !== d.tabId) return;
  if (!r.network) return;
  const base = {
    req_id: reqId,
    method: d.method,
    url: d.url,
    type: d.type === 'xmlhttprequest' && r.types?.has('xhr') && !r.types.has('fetch') ? 'XHR' : WR_TYPES[d.type] || 'Other',
    via: 'webRequest'
  };
  let data;
  if (kind === 'request') {
    earlyIds.set(reqId, d.tabId);
    data = {
      ...base,
      at: Math.round(d.timeStamp || Date.now()),
      status: 0
    };
  } else {
    earlyIds.delete(reqId);
    data = {
      ...base,
      status: d.statusCode || 0,
      request: {
        headers: {}
      },
      response: {
        headers: headerObject(d.responseHeaders),
        mime: String(headerObject(d.responseHeaders)['content-type'] || headerObject(d.responseHeaders)['Content-Type'] || '').split(';')[0]
      },
      from_cache: !!d.fromCache,
      body_omitted: 'early',
      ...(kind === 'failed' ? {
        failed: String(d.error || 'failed')
      } : {})
    };
  }
  data = shapeNetwork(r, kind === 'request' ? 'request' : 'response', data);
  if (data) item(d.tabId, kind === 'request' ? 'request' : 'response', data);
}
const onEarlyRequest = d => earlyRequest('request', d),
  onEarlyDone = d => earlyRequest('response', d),
  onEarlyFailed = d => earlyRequest('failed', d);
let earlyOn = false;
function watchEarly() {
  const wr = chrome.webRequest;
  if (!wr || earlyOn === recordings.size > 0) return;
  earlyOn = recordings.size > 0;
  const filter = {
    urls: ['<all_urls>']
  };
  if (earlyOn) {
    wr.onBeforeRequest.addListener(onEarlyRequest, filter);
    wr.onCompleted.addListener(onEarlyDone, filter, ['responseHeaders']);
    wr.onErrorOccurred.addListener(onEarlyFailed, filter);
  } else {
    wr.onBeforeRequest.removeListener(onEarlyRequest);
    wr.onCompleted.removeListener(onEarlyDone);
    wr.onErrorOccurred.removeListener(onEarlyFailed);
    early.clear();
    earlyIds.clear();
  }
}
chrome.tabs.onCreated?.addListener(tab => {
  if (Number.isInteger(tab?.openerTabId) && recordings.has(tab.openerTabId)) join(tab.openerTabId, tab.id, tab.pendingUrl || tab.url);
});
chrome.webNavigation?.onCreatedNavigationTarget?.addListener(d => {
  if (recordings.has(d.sourceTabId)) join(d.sourceTabId, d.tabId, d.url);
});
// Actions of tcli commands in a recording ("Recording" in docs/design/browser-extension.md): one item per command, source 'agent',
// emitted before the action so the requests it causes come after it. The page recorder leaves out the events the command causes:
// agentWindow marks the tab's isolated world for `ms` milliseconds (page.js installRecorder reads __tagentAgentUntil).
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'warning', 'error', 'debug', 'dialog'];
const AGENT_KINDS = {
  'input.click': 'click',
  'input.type': 'input',
  'input.press': 'key',
  'input.select': 'change',
  'input.hover': 'hover',
  'input.scroll': 'scroll'
};
function agentWindow(ms) {
  globalThis.__tagentAgentUntil = Date.now() + ms;
}
async function markAgent(id, ms) {
  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: id
      },
      func: agentWindow,
      args: [ms]
    });
  } catch {/* A new document is loading. */}
}
const brief = d => d ? d.recorded || {
  tag: d.tag,
  role: d.role,
  name: d.name,
  selector: d.selector,
  rect: d.rect,
  ...(d.type ? {
    type: d.type
  } : {}),
  ...(d.sensitive ? {
    sensitive: true
  } : {})
} : undefined;
const hidden = target => !!(target && (target.sensitive || String(target.type || '').toLowerCase() === 'password'));
function agentItem(id, method, p, target) {
  if (!recordings.has(id) || !AGENT_KINDS[method]) return;
  const data = {
    source: 'agent',
    command: method,
    ...(target ? {
      target
    } : {})
  };
  if (method === 'input.click') Object.assign(data, {
    button: p.button || 'left',
    count: p.count ?? 1
  });
  if (method === 'input.type') Object.assign(data, {
    value: hidden(target) ? `<redacted:${p.text.length}>` : p.text,
    ...(p.clear ? {
      clear: true
    } : {}),
    ...(p.submit ? {
      submit: true
    } : {})
  });
  // A printable key without Control or Meta may be a character of a password: kept as its length only, like typed text in a secret field.
  if (method === 'input.press') data.key = p.key.length === 1 && !(p.modifiers || []).some(m => m === 'Control' || m === 'Meta') ? '<redacted:1>' : p.key;
  if (method === 'input.select') data.values = hidden(target) ? p.values.map(v => `<redacted:${String(v).length}>`) : p.values;
  if (method === 'input.scroll') Object.assign(data, {
    dx: p.dx ?? 0,
    dy: p.dy ?? 600
  });
  if (p.modifiers?.length) data.modifiers = p.modifiers;
  item(id, AGENT_KINDS[method], data);
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
// Back and forward. Chrome's own back skips history entries that were left without a user gesture (its history
// manipulation intervention), and every navigation the extension starts (a click, a submit, tabs.navigate) is one, so
// chrome.tabs.goBack often answers "Cannot find a next page in history" while the page's own history still has the
// page. Then the step is taken inside the page with history.back() / history.forward(), which does not skip, and it
// counts once the tab starts loading or its URL changes. Nothing within HISTORY_STEP_MS: there is no such page.
const HISTORY_STEP_MS = 3000;
async function historyStep(id, action) {
  try {
    if (action === 'back') await chrome.tabs.goBack(id);else await chrome.tabs.goForward(id);
    return;
  } catch {}
  const { url } = await chrome.tabs.get(id);
  await chrome.scripting.executeScript({
    target: {
      tabId: id
    },
    world: 'MAIN',
    func: step => {
      if (step === 'back') history.back();else history.forward();
    },
    args: [action]
  });
  const start = Date.now();
  while (Date.now() - start < HISTORY_STEP_MS) {
    const t = await chrome.tabs.get(id);
    if (t.status === 'loading' || t.url !== url) return;
    await new Promise(r => setTimeout(r, 50));
  }
  fail('BAD_PARAMS', action === 'back' ? 'There is no earlier page in this tab' : 'There is no later page in this tab');
}
const modifiers = p => (p.modifiers || []).reduce((n, m) => n | ({
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8
}[m] || 0), 0);
// The tab of a command that opened a page with a recording, while it still shows about:blank: tabInfo needs a scriptable page.
async function waitCommitted(id, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = await chrome.tabs.get(id);
    if (scriptable(t.url)) return t;
    await new Promise(r => setTimeout(r, 50));
  }
  return chrome.tabs.get(id);
}
// T-Agent's own window for the tabs it opens: one normal window, created behind the person's windows without the focus (never minimized, so its
// pages are drawn), reused while it holds a tab T-Agent owns. Chrome closes it when its last tab closes; T-Agent never closes a window itself.
async function reusableWindow() {
  if (!Number.isInteger(agentWindowId)) return null;
  try {
    const w = await chrome.windows.get(agentWindowId, {
      populate: true
    });
    if (w.type === 'normal' && (w.tabs || []).some(t => owned.has(t.id))) return w.id;
  } catch {/* Closed. */}
  return null;
}
// A new tab of T-Agent in that window (owned at once, so a second open waiting on the lock reuses the window). Never active, never focused.
// `own` ('front' or 'back', tabs.open with `window`): a new window just for this tab, a recording's own window ("The recording's own
// window" in docs/design/browser-extension.md), focused for 'front'. It is never T-Agent's shared window, so no later open reuses it, and
// Chrome closes it with its last tab.
function agentTab(url, own = null) {
  const run = async () => {
    const windowId = own ? null : await reusableWindow();
    let t;
    if (own) {
      const w = await chrome.windows.create({
        url,
        focused: own === 'front',
        state: 'normal'
      });
      t = w.tabs?.[0] || (await chrome.tabs.query({
        windowId: w.id
      }))[0];
      if (!t) fail('INTERNAL', 'The new window has no tab');
    } else if (windowId !== null) t = await chrome.tabs.create({
      windowId,
      url,
      active: false
    });else {
      const w = await chrome.windows.create({
        url,
        focused: false,
        state: 'normal'
      });
      agentWindowId = w.id;
      t = w.tabs?.[0] || (await chrome.tabs.query({
        windowId: w.id
      }))[0];
      if (!t) fail('INTERNAL', 'The new window has no tab');
    }
    quiet(t.id);
    owned.add(t.id);
    await persist();
    return t;
  };
  const next = (windowLock || Promise.resolve()).then(run, run);
  windowLock = next.catch(() => {});
  return next;
}
// Brings a tab to the front: only for a command that asks for it (tabs.activate, tabs.open with `active`).
async function show(id, windowId) {
  quiet(id);
  await chrome.tabs.update(id, {
    active: true
  });
  await chrome.windows.update(windowId, {
    focused: true
  });
}
// The person used a T-Agent tab (activated it in a window they are in, clicked or typed in it): it leaves T-Agent's care. It is ungrouped and
// no longer owned, and stays where it is; the bridge forgets it, so it is never closed. A recorded tab stays owned (the person's actions are what
// a recording is for) but is kept: never closed automatically. Inside a command's own input (CDP events are trusted too) nothing happens.
export async function userUsed(id, how) {
  await ready;
  if (!owned.has(id) || handed.has(id) || grouping.has(id)) return false;
  if (busy.get(id) || Date.now() < (calmUntil.get(id) || 0)) return false;
  if (recordings.has(id)) {
    if (kept.has(id)) return false;
    kept.add(id);
    await persist();
    event('tab.used', {
      tab_id: id,
      how,
      kept: true
    });
    return true;
  }
  owned.delete(id);
  joined.delete(id);
  kept.delete(id);
  await persist();
  await detach(id);
  if (lastTab === id) lastTab = undefined;
  try {
    await chrome.tabs.ungroup(id);
  } catch {/* Closed or already outside the group. */}
  event('tab.used', {
    tab_id: id,
    how
  });
  return true;
}
// Watches an owned tab's page for the person's own input (trusted pointer and key events), in the extension's isolated world, once per document.
function userWatch() {
  if (globalThis.__tagentUserWatch) return;
  globalThis.__tagentUserWatch = true;
  let sent = 0;
  const on = e => {
    if (!e.isTrusted || Date.now() - sent < 500) return;
    sent = Date.now();
    try {
      chrome.runtime.sendMessage({
        type: 'user.input',
        kind: e.type
      }).catch(() => {});
    } catch {/* The extension reloaded. */}
  };
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, on, true);
}
async function watchUser(id) {
  if (!owned.has(id) || handed.has(id)) return;
  try {
    await chrome.scripting.executeScript({
      target: {
        tabId: id
      },
      func: userWatch
    });
  } catch {/* Not scriptable yet. */}
}
const newer = (a, b) => {
  const x = String(a || '').split('.').map(Number),
    y = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};
// The bridge's `reload` request ("The extension updates itself" in docs/design/browser-extension.md): T-Agent's folder holds a newer version.
// Chrome does not reload an unpacked extension when its files change, but it serves them from disk: the folder's manifest.json is read here,
// and only when it is newer than the running one, and not already tried for that version in the last 10 minutes, does the extension reload,
// once no command and no recording runs. The tabs it owns and its window are kept across the reload (storage.session is cleared by it).
export async function reloadRequest() {
  const running = chrome.runtime.getManifest?.().version;
  let disk;
  try {
    disk = (await (await fetch(chrome.runtime.getURL('manifest.json'), {
      cache: 'no-store'
    })).json()).version;
  } catch {
    return {
      reload: false,
      reason: 'manifest not readable'
    };
  }
  if (!newer(disk, running)) return {
    reload: false,
    reason: 'not newer',
    version: disk
  };
  const last = (await chrome.storage.local.get(['last_reload'])).last_reload;
  if (last && last.version === disk && Date.now() - last.at < 10 * 60000) return {
    reload: false,
    reason: 'tried recently',
    version: disk
  };
  await chrome.storage.local.set({
    last_reload: {
      version: disk,
      at: Date.now()
    }
  });
  reloadWanted = true;
  await maybeReload();
  return {
    reload: true,
    version: disk
  };
}
async function maybeReload() {
  if (!reloadWanted || recordings.size || inflight) return;
  reloadWanted = false;
  await chrome.storage.local.set({
    reload_state: {
      at: Date.now(),
      handed: [...handed],
      owned: [...owned],
      kept: [...kept],
      joined: [...joined],
      agent_window: agentWindowId
    }
  });
  chrome.runtime.reload();
}
// One command. `meta.tab` gets { tab_id, how, keep } of the tab it used, which the result message carries to the bridge (its per-terminal tab
// care, "Closing T-Agent's tabs" in docs/design/browser-extension.md); a result gets the page dialogs answered since the tab's last command.
export async function dispatch(method, p = {}, meta = {}) {
  try {
    const result = await run(method, p, meta);
    const id = meta.tab?.tab_id;
    if (Number.isInteger(id) && result && typeof result === 'object') {
      const answered = takeDialogs(id);
      if (answered.length) result.dialogs = answered;
    }
    return result;
  } finally {
    const id = meta.tab?.tab_id;
    if (Number.isInteger(id)) {
      const n = (busy.get(id) || 1) - 1;
      if (n > 0) busy.set(id, n);else busy.delete(id);
      calmUntil.set(id, Date.now() + 1000);
    }
  }
}
function using(meta, t) {
  meta.tab = {
    tab_id: t.id,
    how: handed.has(t.id) ? 'handed' : 'group',
    ...(kept.has(t.id) ? {
      keep: true
    } : {})
  };
  busy.set(t.id, (busy.get(t.id) || 0) + 1);
}
async function run(method, p, meta) {
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
  if (method === 'page.snapshot') {
    if (p.filter !== undefined && p.filter !== 'interactive') fail('BAD_PARAMS', 'filter must be interactive');
    if (p.diff !== undefined && typeof p.diff !== 'boolean') fail('BAD_PARAMS', 'diff must be true or false');
  }
  if (method === 'page.console') {
    if (p.levels !== undefined && (!Array.isArray(p.levels) || !p.levels.length || p.levels.some(l => !CONSOLE_LEVELS.includes(l)))) fail('BAD_PARAMS', `levels must be a list of ${CONSOLE_LEVELS.join(', ')}`);
    if (p.pattern !== undefined) {
      if (typeof p.pattern !== 'string' || !p.pattern || p.pattern.length > 500) fail('BAD_PARAMS', 'pattern must be a regular expression of at most 500 characters');
      try {
        new RegExp(p.pattern, 'i');
      } catch (e) {
        fail('BAD_PARAMS', `pattern is not a regular expression: ${e.message}`);
      }
    }
  }
  if (method === 'page.screenshot') {
    if (p.zoom !== undefined) {
      const z = p.zoom;
      if (!z || typeof z !== 'object' || !['x', 'y', 'w', 'h'].every(k => Number.isFinite(z[k])) || z.w <= 0 || z.h <= 0) fail('BAD_PARAMS', 'zoom must be { x, y, w, h } with a positive w and h');
      if (p.full_page || p.target) fail('BAD_PARAMS', 'zoom takes neither full_page nor target');
    }
    if (p.scale !== undefined && (!Number.isFinite(p.scale) || p.scale < 0.1 || p.scale > 4)) fail('BAD_PARAMS', 'scale must be 0.1 to 4');
    if (p.scale !== undefined && !p.zoom && !p.target) fail('BAD_PARAMS', 'scale needs zoom or target');
    if (p.annotate !== undefined && typeof p.annotate !== 'boolean') fail('BAD_PARAMS', 'annotate must be true or false');
  }
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
    if (p.record !== undefined && (!p.record || typeof p.record !== 'object' || Array.isArray(p.record))) fail('BAD_PARAMS', 'record must be an object');
    if (p.record) recordOptions(p.record);
    for (const key of ['active', 'keep']) if (p[key] !== undefined && typeof p[key] !== 'boolean') fail('BAD_PARAMS', `${key} must be true or false`);
    if (p.window !== undefined && !['front', 'back'].includes(p.window)) fail('BAD_PARAMS', 'window must be front or back');
    if (p.window !== undefined && !p.record) fail('BAD_PARAMS', 'window is for a recording: it needs record');
    // With `record`, the tab starts on about:blank, the debugger and the recording attach there, and only then does the tab load the
    // address: the first load's requests are recorded once, with no reload ("Recording from the first load" in docs/design/browser-extension.md).
    // The tab goes into T-Agent's own window, in the background ("Focus and closing"); `active` brings it to the front afterwards. With
    // `window` it gets a new window of its own instead, in front ('front', tcli browser open --record) or behind ('back', --background).
    const t = await agentTab(p.record ? 'about:blank' : p.url, p.window || null);
    const ownWindow = p.window ? {
      window: {
        window_id: t.windowId,
        focused: p.window === 'front',
        own: true
      }
    } : {};
    if (p.keep) kept.add(t.id);
    grouping.add(t.id);
    using(meta, t);
    try {
      const groups = await chrome.tabGroups.query({
        title: 'T-Agent',
        windowId: t.windowId
      });
      // A new group needs its window named: without createProperties.windowId Chrome makes it in the "current" window and moves the tab
      // there, out of T-Agent's window into the person's.
      const gid = await chrome.tabs.group({
        tabIds: [t.id],
        ...(groups[0] ? {
          groupId: groups[0].id
        } : {
          createProperties: {
            windowId: t.windowId
          }
        })
      });
      await chrome.tabGroups.update(gid, {
        title: 'T-Agent',
        color: 'blue'
      });
      await persist();
      lastTab = t.id;
      if (p.active) await show(t.id, t.windowId);
      if (!p.record) return {
        tab: await tabInfo(await chrome.tabs.get(t.id))
      };
      const r = await startRecording(t.id, p.record, p.url, {
        inject: false
      });
      // Changes of the tab's address to about:blank that Chrome reports late must not end the recording.
      r.openingUntil = Date.now() + 15000;
      item(t.id, 'nav', {
        source: 'agent',
        action: 'open',
        from: 'about:blank',
        to: p.url,
        transition: 'navigation'
      });
      await chrome.tabs.update(t.id, {
        url: p.url
      });
      const now = await waitCommitted(t.id);
      setUrl(r, t.id, now.url || p.url);
      r.openingUntil = Date.now() + 3000;
      let tab;
      try {
        tab = await tabInfo(now);
      } catch {
        tab = {
          tab_id: now.id,
          window_id: now.windowId,
          url: now.pendingUrl || now.url || p.url,
          title: now.title,
          active: now.active,
          how: 'group',
          capturing: captures.has(now.id),
          recording_id: r.id
        };
      }
      return {
        tab,
        recording_id: r.id,
        options: r.options,
        ...ownWindow
      };
    } catch (e) {
      if (recordings.has(t.id)) await stopRecord(t.id);
      owned.delete(t.id);
      joined.delete(t.id);
      kept.delete(t.id);
      await persist();
      await closeTab(t.id).catch(() => {});
      throw e;
    } finally {
      grouping.delete(t.id);
      void chrome.tabs.get(t.id).then(x => x.status === 'complete' && watchUser(t.id)).catch(() => {});
      // The tab may have finished loading while onUpdated ignored it (grouping): the recorder goes in now (a no-op when it already runs).
      if (recordings.has(t.id)) void chrome.tabs.get(t.id).then(x => x.status === 'complete' && install(t.id)).catch(() => {});
    }
  }
  // Brings the tab of a T-Agent page to the front (the desktop window's Open session): the tab whose address has this origin and is a top-level page
  // (no `pane` parameter, so not a column of the multi-column view). It reads nothing of any page, so it needs no handed tab. The active tab of the
  // last focused window when it is one, else the one used last.
  if (method === 'tabs.reveal') {
    let origin = null;
    try {
      const u = new URL(p.origin);
      if (/^https?:$/.test(u.protocol) && u.origin === p.origin) origin = u.origin;
    } catch {/* Not a URL. */}
    if (!origin) fail('BAD_PARAMS', 'origin must be an http or https origin');
    const page = t => {
      try {
        const u = new URL(t.url || t.pendingUrl || '');
        return u.origin === origin && !u.searchParams.has('pane');
      } catch {
        return false;
      }
    };
    const candidates = (await chrome.tabs.query({})).filter(page);
    if (!candidates.length) return {
      focused: false
    };
    const front = (await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    })).find(page);
    const chosen = front || candidates.reduce((a, b) => (b.lastAccessed || 0) > (a.lastAccessed || 0) || (b.lastAccessed || 0) === (a.lastAccessed || 0) && b.id > a.id ? b : a);
    await chrome.tabs.update(chosen.id, {
      active: true
    });
    await chrome.windows.update(chosen.windowId, {
      focused: true
    });
    return {
      focused: true,
      tab_id: chosen.id
    };
  }
  if (method === 'record.stop' && p.recording_id) {
    const r = [...recordings.values()].find(v => v.id === p.recording_id);
    if (!r) fail('NOT_CAPTURING', 'Recording not found');
    p = {
      ...p,
      tab_id: r.main
    };
  }
  const before = lastTab;
  const t = await getTab(p.tab_id),
    id = t.id;
  using(meta, t);
  if (ACTION_METHODS.includes(method)) return runAction(method, id, p, {
    page: (m, q) => page(id, m, q),
    recording: recordings.has(id),
    item: (kind, data) => item(id, kind, data),
    brief,
    markAgent: ms => markAgent(id, ms),
    held: () => recordings.has(id) || !!captures.get(id)?.manual
  });
  if (method === 'tabs.close') {
    // T-Agent's own closing (the bridge, when the agent's turn ended or the terminal closed): only an owned tab that is not kept, never a
    // handed one (which a person's `close` would release). It leaves the command's last tab as it was.
    if (p.auto === true) {
      lastTab = before === id ? undefined : before;
      if (handed.has(id) || kept.has(id) || !owned.has(id)) fail('TAB_NOT_ALLOWED', 'This tab is not closed automatically');
    }
    removedAt.set(t.windowId, Date.now());
    if (handed.has(id)) {
      await release(id);
      return {
        released: true
      };
    }
    await closeTab(id);
    return {};
  }
  if (method === 'tabs.activate') {
    await show(id, t.windowId);
    return {
      tab: await tabInfo(await chrome.tabs.get(id))
    };
  }
  if (method === 'tabs.navigate') {
    if (p.url && !scriptable(p.url)) fail('TAB_NOT_SCRIPTABLE', 'Use an HTTP or HTTPS page');
    const action = ['back', 'forward', 'reload'].includes(p.action) ? p.action : 'go';
    if (action === 'go' && !p.url) fail('BAD_PARAMS', 'Supply url or action');
    // In a recording, the address changes this command causes are nav items with source 'agent' (onUpdated reads r.agentNav); a reload
    // (the address stays) is one item here, and its own address change, if Chrome reports one, is left out.
    const r = recordings.get(id);
    if (r) {
      r.agentNav = {
        action,
        until: Infinity,
        seen: false,
        quiet: action === 'reload'
      };
      if (action === 'reload') item(id, 'nav', {
        source: 'agent',
        action,
        from: t.url,
        to: t.url,
        transition: 'reload'
      });
    }
    try {
      if (action === 'back' || action === 'forward') await historyStep(id, action);else if (action === 'reload') await chrome.tabs.reload(id);else await chrome.tabs.update(id, {
        url: p.url
      });
      const now = p.wait === 'none' ? await chrome.tabs.get(id) : await waitLoaded(id);
      if (r && recordings.get(id) === r && !r.agentNav.quiet && !r.agentNav.seen && p.wait !== 'none') {
        if (now.url !== t.url) await new Promise(done => setTimeout(done, 150));
        // The address did not change (go to the same page): still one item for the command.
        if (!r.agentNav.seen) item(id, 'nav', {
          source: 'agent',
          action,
          from: t.url,
          to: now.url,
          transition: 'navigation'
        });
      }
      return {
        tab: await tabInfo(now)
      };
    } finally {
      if (r) r.agentNav.until = Date.now() + (p.wait === 'none' ? 5000 : 300);
    }
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
    const s = await attach(id, {
      ...p,
      body_types: null
    });
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
    if (method === 'page.console') {
      // --level and --pattern (case-insensitive) filter before the limit; `warn` is CDP's `warning`.
      const levels = p.levels ? new Set(p.levels.map(l => l === 'warn' ? 'warning' : l)) : null;
      const re = p.pattern ? new RegExp(p.pattern, 'i') : null;
      return {
        entries: s.console.filter(e => (!p.since || e.at >= p.since) && (!levels || levels.has(e.level)) && (!re || re.test(String(e.text)))).slice(-Math.max(1, Math.min(p.limit ?? 200, 2000)))
      };
    }
    if (method === 'net.list') return {
      requests: [...s.requests.values()].filter(r => matches(r, p)).slice(-Math.max(1, Math.min(p.limit ?? 200, 2000))).map(summary)
    };
    const r = s.requests.get(p.req_id);
    if (!r) fail('REQUEST_NOT_FOUND', 'Request not found');
    return p.raw ? detail(r, p.body !== false, true) : redact(detail(r, p.body !== false));
  }
  if (method === 'record.start') {
    const r = await startRecording(id, p, t.url);
    return {
      recording_id: r.id,
      tab_id: id,
      url: t.url,
      options: r.options
    };
  }
  if (method === 'record.stop') {
    // In any tab of the recording (one the recorded page opened too) it stops the whole recording.
    const r = await stopRecord(id, 'stopped', {
      all: true
    });
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
    // shot --annotate: the refs of the last snapshot are drawn on the page for the moment of the picture.
    const marks = p.annotate ? await page(id, 'annotate') : null;
    try {
      const r = await screenshot(id, t, p);
      return marks ? {
        ...r,
        annotated: marks.annotated
      } : r;
    } finally {
      if (marks) await page(id, 'annotate.clear').catch(() => {});
    }
  }
  if (captures.has(id) && ['input.click', 'input.hover', 'input.type', 'input.press', 'input.scroll'].includes(method)) {
    const rec = recordings.has(id);
    if (!rec) return cdpInput(id, method, p);
    await markAgent(id, 10000);
    try {
      return await cdpInput(id, method, p, true);
    } finally {
      await markAgent(id, 150);
    }
  }
  // The page path (input.select, and input without a debugger). In a recording the target is resolved first, so the agent item comes
  // before the events of the action; pageAction itself keeps the recorder from recording those events (__tagentAgentBusy).
  if (recordings.has(id) && AGENT_KINDS[method]) {
    const d = p.target ? await page(id, 'resolve', {
      target: p.target,
      focus: false,
      record_target: true
    }) : null;
    agentItem(id, method, p, brief(d));
  }
  return page(id, method, p);
}
// page.screenshot: the viewport, the whole page, an element (`target`) or a part of the viewport (`zoom`).
async function screenshot(id, t, p) {
  const format = p.format || 'png';
  if (!['png', 'jpeg'].includes(format)) fail('BAD_PARAMS', 'Unsupported screenshot format');
  if (!p.full_page && !p.target && !p.zoom) {
    // The visible area through the debugger, so the tab need not be active or its window in front (nothing is brought forward). Only when the
    // debugger cannot attach (DevTools is open on the tab) and the tab is the active one of its window does captureVisibleTab take it.
    const v = await page(id, 'viewport');
    const size = {
      mime: `image/${format}`,
      width: Math.round(v.width * v.device_scale_factor),
      height: Math.round(v.height * v.device_scale_factor)
    };
    let temporary = false;
    try {
      temporary = !captures.has(id);
      if (temporary) await attach(id, {
        bodies: false
      });
    } catch (e) {
      if (!/DEBUGGER_BUSY/.test(e.message) || !(await chrome.tabs.get(id)).active) throw e;
      const data = await chrome.tabs.captureVisibleTab(t.windowId, {
        format,
        ...(p.quality !== undefined ? {
          quality: p.quality
        } : {})
      });
      return {
        data_base64: data.split(',')[1],
        ...size
      };
    }
    try {
      let timer;
      const r = await Promise.race([cdp(id, 'Page.captureScreenshot', {
        format,
        ...(p.quality !== undefined ? {
          quality: p.quality
        } : {})
      }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT: The tab did not draw a picture in time; activate it (tcli browser activate) and try again')), 15000);
      })]).finally(() => clearTimeout(timer));
      return {
        data_base64: r.data,
        ...size
      };
    } finally {
      if (temporary && !recordings.has(id) && !captures.get(id)?.manual) await detach(id);
    }
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
        scale: p.scale ?? 1
      };
    } else if (p.zoom) {
      // shot --zoom x,y,w,h: that part of the viewport (CSS pixels, like x,y targets) at `scale` (2 by default).
      const m = await cdp(id, 'Page.getLayoutMetrics');
      clip = {
        x: p.zoom.x + m.cssLayoutViewport.pageX,
        y: p.zoom.y + m.cssLayoutViewport.pageY,
        width: p.zoom.w,
        height: p.zoom.h,
        scale: p.scale ?? 2
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
      width: Math.round(clip.width * clip.scale),
      height: Math.round(clip.height * clip.scale)
    };
  } finally {
    if (temporary && !recordings.has(id) && !captures.get(id)?.manual) await detach(id);
  }
}
// Mouse and keyboard through the debugger (trusted events). `rec`: the tab is recording, so the agent item is written before the input.
async function cdpInput(id, method, p, rec = false) {
  if (method === 'input.press') {
    if (rec) agentItem(id, method, p);
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
    record_target: rec || undefined,
    target: p.target || {
      x: 10,
      y: 10
    }
  });
  if (rec) agentItem(id, method, p, p.target ? brief(d) : undefined);
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
    if (p.submit) await cdpInput(id, 'input.press', {
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
// How this extension was installed: 'development' when it is loaded unpacked (T-Agent's folder), for the bridge's reload rule.
async function installType() {
  try {
    return (await chrome.management?.getSelf?.())?.installType || null;
  } catch {
    return null;
  }
}
async function connect() {
  await ready;
  if (blocked || socket?.readyState === 0 || socket?.readyState === 1) return;
  const config = await chrome.storage.local.get(['server_url', 'token', 'name']);
  const install = await installType();
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
      version: chrome.runtime.getManifest?.().version || null, // the version in manifest.json
      protocol: 1,
      browser: {
        name: config.name || `Chrome on ${navigator.platform}`,
        user_agent: navigator.userAgent
      },
      methods,
      features,
      install_type: install,
      // The tabs T-Agent owns now, so a T-Agent server that restarted still closes them in time (its tab care adopts them).
      owned_tabs: [...owned].slice(0, 500).map(id => ({
        tab_id: id,
        ...(kept.has(id) ? {
          keep: true
        } : {})
      }))
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
    if (m.type === 'reload') {
      void reloadRequest().catch(() => {});
      return;
    }
    if (m.type !== 'cmd') return;
    let timer;
    const meta = {};
    inflight++;
    try {
      const result = await Promise.race([dispatch(m.method, m.params || {}, meta), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT: Command timed out')), Math.max(1, Math.min(m.timeout_ms ?? 30000, 120000)));
      })]);
      send({
        type: 'result',
        id: m.id,
        ok: true,
        result,
        ...(meta.tab ? {
          tab: meta.tab
        } : {})
      }, m.method === 'net.get' && m.params?.raw === true);
    } catch (e) {
      const match = e.message.match(/(TAB_NOT_ALLOWED|TAB_NOT_FOUND|TAB_NOT_SCRIPTABLE|REF_NOT_FOUND|ELEMENT_NOT_FOUND|ELEMENT_NOT_INTERACTABLE|TIMEOUT|EVAL_FAILED|DEBUGGER_BUSY|NOT_CAPTURING|NO_DIALOG|REQUEST_NOT_FOUND|BAD_PARAMS|UNKNOWN_METHOD|INTERNAL):\s*(.*)/s);
      send({
        type: 'result',
        id: m.id,
        ok: false,
        error: {
          code: match?.[1] || 'INTERNAL',
          message: match?.[2] || e.message
        },
        ...(meta.tab ? {
          tab: meta.tab
        } : {})
      });
    } finally {
      clearTimeout(timer);
      inflight--;
      void maybeReload().catch(() => {});
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
    if (m.type === 'user.input') {
      if (Number.isInteger(sender.tab?.id)) await userUsed(sender.tab.id, 'input');
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
chrome.tabs.onRemoved.addListener((id, info) => {
  if (info?.windowId !== undefined) removedAt.set(info.windowId, Date.now());
  void (async () => {
    await ready;
    const was = owned.has(id) || handed.has(id);
    await stopRecord(id, 'tab closed');
    await detach(id);
    owned.delete(id);
    joined.delete(id);
    handed.delete(id);
    kept.delete(id);
    quietUntil.delete(id);
    calmUntil.delete(id);
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
      // The person took the tab out of the group (or out of T-Agent's window): theirs from now on, like a tab they used.
      await stopRecord(id, 'tab released');
      await detach(id);
      owned.delete(id);
      joined.delete(id);
      kept.delete(id);
      await persist();
      event('tab.used', {
        tab_id: id,
        how: 'ungrouped'
      });
    }
    if (change.url) {
      const r = recordings.get(id);
      // tabs.open with `record`: Chrome may still report the about:blank the tab started on.
      // A tab the recorded page opened may start on about:blank too (window.open() and then a new address).
      if (r && change.url === 'about:blank' && (id !== r.main || Date.now() < (r.openingUntil || 0))) return;
      if (r) {
        // Inside a tcli go / back / forward: the item has source 'agent'. Other address changes (a followed link, a redirect, the
        // person typing an address) have no source: they are what happened, not an action.
        const agent = r.agentNav && Date.now() < r.agentNav.until ? r.agentNav : null;
        // An opened tab's first address is in its `tab` item already.
        if (!agent?.quiet && !(id !== r.main && change.url === urlOf(r, id))) item(id, 'nav', {
          from: urlOf(r, id),
          to: change.url,
          transition: change.status === 'loading' ? 'navigation' : 'history',
          ...(agent ? {
            source: 'agent',
            action: agent.action
          } : {})
        });
        if (agent) agent.seen = true;
        setUrl(r, id, change.url);
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
      await watchUser(id);
    } catch {/* Protected page or released. */}
  })();
});
chrome.tabs.onDetached?.addListener((id, info) => removedAt.set(info.oldWindowId, Date.now()));
// The person activated a T-Agent tab: it counts only in a window that has the focus (the person is there), not for T-Agent's own activations
// (quietUntil) and not when Chrome picked it because a tab of that window closed or moved out a moment ago.
const ACTIVATION_SETTLE_MS = 300;
chrome.tabs.onActivated?.addListener(({
  tabId,
  windowId
}) => {
  void (async () => {
    await ready;
    if (!owned.has(tabId) || handed.has(tabId)) return;
    await new Promise(r => setTimeout(r, ACTIVATION_SETTLE_MS));
    if (Date.now() < (quietUntil.get(tabId) || 0) || Date.now() - (removedAt.get(windowId) || 0) < 1500) return;
    let w;
    try {
      w = await chrome.windows.get(windowId);
    } catch {
      return;
    }
    if (w.focused) await userUsed(tabId, 'activated');
  })().catch(() => {});
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const s = captures.get(source.tabId);
  captures.delete(source.tabId);
  if (s) void stopRecord(source.tabId, reason === 'target_closed' ? 'tab closed' : 'debugger detached');
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
      joined.delete(t.id);
      kept.delete(t.id);
      event('tab.used', {
        tab_id: t.id,
        how: 'ungrouped'
      });
    }
    await persist();
  })();
});
