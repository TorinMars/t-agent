import { redact, cut } from './redact.js';
export const captures = new Map();
export const cdp = (id, method, params = {}) => chrome.debugger.sendCommand({
  tabId: id
}, method, params);
let emit = () => {};
export function setCaptureEmitter(fn) {
  emit = fn;
}
export async function attach(id, options = {}) {
  let s = captures.get(id);
  if (s) {
    Object.assign(s.options, options);
    s.options.max_body_bytes = Math.min(s.options.max_body_bytes, 2097152);
    return s;
  }
  try {
    await chrome.debugger.attach({
      tabId: id
    }, '1.3');
  } catch {
    throw new Error('DEBUGGER_BUSY: DevTools or another debugger is attached');
  }
  if (options.max_body_bytes !== undefined) options = {
    ...options,
    max_body_bytes: Math.min(options.max_body_bytes, 2097152)
  };
  s = {
    options: {
      bodies: true,
      max_body_bytes: 2097152,
      ...options
    },
    requests: new Map(),
    console: [],
    lastActivity: Date.now(),
    active: 0,
    inflight: new Set()
  };
  captures.set(id, s);
  try {
    await cdp(id, 'Network.enable');
    await cdp(id, 'Runtime.enable');
    await cdp(id, 'Page.enable');
  } catch (e) {
    await detach(id);
    throw e;
  }
  return s;
}
export async function detach(id) {
  captures.delete(id);
  try {
    await chrome.debugger.detach({
      tabId: id
    });
  } catch {/* Already detached. */}
}
export function summary(r) {
  return {
    req_id: r.req_id,
    at: r.at,
    method: r.method,
    url: r.url,
    type: r.type,
    status: r.status,
    mime: r.response.mime,
    size: r.response.size,
    duration_ms: r.duration_ms,
    from_cache: r.from_cache,
    ...(r.failed ? {
      failed: r.failed
    } : {})
  };
}
export function detail(r, body = true, raw = false) {
  const d = {
    ...r,
    request: {
      ...r.request
    },
    response: {
      ...r.response
    }
  };
  if (!raw) {
    if (r.safe_post !== undefined) d.request.post_data = r.safe_post;
    if (r.safe_body !== undefined) d.response.body = r.safe_body;
  }
  if (r.frames) d.frames = r.frames.map(({
    safe_data,
    ...frame
  }) => ({
    ...frame,
    data: raw ? frame.data : safe_data
  }));
  delete d.safe_post;
  delete d.safe_body;
  delete d.at;
  delete d.duration_ms;
  delete d.from_cache;
  delete d.failed;
  if (!body) {
    d.response = {
      ...d.response
    };
    delete d.response.body;
    delete d.response.body_base64;
  }
  return d;
}
export function matches(r, p = {}) {
  return (!p.url_includes || r.url.includes(p.url_includes)) && (!p.types || p.types.includes(r.type)) && (!p.since || r.at >= p.since);
}
chrome.debugger.onEvent.addListener((source, method, p) => {
  void handle(source.tabId, method, p).catch(() => {});
});
async function handle(id, method, p) {
  const s = captures.get(id);
  if (!s) return;
  const at = Date.now();
  if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown') {
    const entry = {
      at,
      level: p.type || 'error',
      text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || (p.args || []).map(a => a.value === undefined ? a.description : typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value)).join(' ')
    };
    s.console.push(redact(entry));
    if (s.console.length > 2000) s.console.shift();
    emit(id, 'console', entry);
    return;
  }
  if (method === 'Network.requestWillBeSent' || method === 'Network.webSocketCreated') {
    if (method === 'Network.requestWillBeSent') {
      s.inflight.add(p.requestId);
      s.active = s.inflight.size;
      s.lastActivity = at;
    }
    if (p.redirectResponse && s.requests.has(p.requestId)) {
      const old = s.requests.get(p.requestId);
      old.status = p.redirectResponse.status;
      old.response.headers = p.redirectResponse.headers;
      emit(id, 'response', detail(old));
    }
    const q = p.request || {
      url: p.url,
      method: 'GET',
      headers: {}
    };
    const r = {
      req_id: p.requestId,
      at,
      method: q.method,
      url: q.url,
      type: p.type || 'WebSocket',
      status: 0,
      request: {
        headers: q.headers
      },
      response: {
        headers: {},
        mime: '',
        size: 0
      },
      timing: {
        started_at: at
      },
      initiator: p.initiator,
      from_cache: false,
      duration_ms: 0
    };
    if (!matches(r, s.options.filter)) return;
    if (q.postData) {
      const c = cut(q.postData, s.options.max_body_bytes);
      r.request.post_data = c.text;
      r.safe_post = cut(redact(q.postData), s.options.max_body_bytes).text;
      r.request.post_data_truncated = c.truncated || new TextEncoder().encode(redact(q.postData || '')).length > s.options.max_body_bytes;
    }
    s.requests.set(p.requestId, r);
    s.lastActivity = at;
    if (s.requests.size > 2000) s.requests.delete(s.requests.keys().next().value);
    if (q.hasPostData && !q.postData) {
      try {
        const d = await cdp(id, 'Network.getRequestPostData', {
          requestId: p.requestId
        });
        const c = cut(d.postData, s.options.max_body_bytes);
        r.request.post_data = c.text;
        r.safe_post = cut(redact(d.postData), s.options.max_body_bytes).text;
        r.request.post_data_truncated = c.truncated || new TextEncoder().encode(redact(d.postData)).length > s.options.max_body_bytes;
      } catch {/* Not available. */}
    }
    emit(id, 'request', summary(r));
    return;
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    s.inflight.delete(p.requestId);
    s.active = s.inflight.size;
    s.lastActivity = at;
  }
  const r = s.requests.get(p.requestId);
  if (!r) return;
  if (method === 'Network.requestWillBeSentExtraInfo') r.request.headers = {
    ...r.request.headers,
    ...p.headers
  };
  if (method === 'Network.responseReceivedExtraInfo') r.response.headers = {
    ...r.response.headers,
    ...p.headers
  };
  if (method === 'Network.webSocketWillSendHandshakeRequest') r.request.headers = {
    ...r.request.headers,
    ...p.request.headers
  };
  if (method === 'Network.webSocketHandshakeResponseReceived') {
    r.status = p.response.status;
    r.response.headers = p.response.headers;
    r.duration_ms = at - r.at;
    emit(id, 'response', detail(r));
  }
  if (method === 'Network.webSocketFrameError') r.failed = p.errorMessage;
  if (method === 'Network.requestServedFromCache') r.from_cache = true;
  if (method === 'Network.responseReceived') {
    r.status = p.response.status;
    r.response.headers = {
      ...r.response.headers,
      ...p.response.headers
    };
    r.response.mime = p.response.mimeType;
    r.from_cache = !!(p.response.fromDiskCache || p.response.fromServiceWorker);
    r.timing = {
      ...r.timing,
      ...p.response.timing
    };
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    s.lastActivity = at;
    r.duration_ms = at - r.at;
    r.timing.finished_at = at;
    r.response.size = p.encodedDataLength || 0;
    if (p.errorText) r.failed = p.errorText;
    if (s.options.bodies && method === 'Network.loadingFinished') try {
      const b = await cdp(id, 'Network.getResponseBody', {
        requestId: p.requestId
      });
      if (b.base64Encoded) {
        const decoded = Uint8Array.from(atob(b.body), x => x.charCodeAt(0));
        const slice = decoded.slice(0, s.options.max_body_bytes);
        if (/text|json|xml|javascript|form/i.test(r.response.mime)) {
          r.response.body = new TextDecoder().decode(slice);
          r.safe_body = cut(redact(new TextDecoder().decode(decoded)), s.options.max_body_bytes).text;
        } else r.response.body_base64 = btoa(Array.from(slice, x => String.fromCharCode(x)).join(''));
        r.response.body_truncated = decoded.length > slice.length || new TextEncoder().encode(redact(new TextDecoder().decode(decoded))).length > s.options.max_body_bytes;
      } else {
        const c = cut(b.body, s.options.max_body_bytes);
        r.response.body = c.text;
        r.safe_body = cut(redact(b.body), s.options.max_body_bytes).text;
        r.response.body_truncated = c.truncated || new TextEncoder().encode(redact(b.body)).length > s.options.max_body_bytes;
      }
    } catch {/* Body not available (redirect, cache, or closed page). */}
    emit(id, 'response', detail(r));
    let bytes = 0;
    for (const request of [...s.requests.values()].reverse()) {
      bytes += (request.request.post_data?.length || 0) + (request.response.body?.length || 0) + (request.response.body_base64?.length || 0);
      if (bytes > 32 * 1024 * 1024) {
        if (request.request.post_data) {
          delete request.request.post_data;
          delete request.safe_post;
          request.request.post_data_truncated = true;
        }
        if (request.response.body || request.response.body_base64) {
          delete request.response.body;
          delete request.safe_body;
          delete request.response.body_base64;
          request.response.body_truncated = true;
        }
      }
    }
  }
  if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
    const c = cut(p.response.payloadData, 4096),
      safe = cut(redact(p.response.payloadData), 4096),
      dir = method.endsWith('Sent') ? 'sent' : 'recv';
    const frame = {
      at,
      dir,
      opcode: p.response.opcode,
      data: c.text,
      safe_data: safe.text,
      truncated: c.truncated || safe.truncated
    };
    (r.frames ||= []).push(frame);
    if (r.frames.length > 1000) r.frames.shift();
    emit(id, 'ws', {
      url: r.url,
      dir,
      data: safe.text
    });
  }
  if (method === 'Network.webSocketClosed') {
    s.lastActivity = at;
  }
}
