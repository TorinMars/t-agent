// Pictures of a recording (`record.start` / `tabs.open` `record` with `frames: true`; "Pictures of a recording" in
// docs/design/browser-extension.md). background.js decides when (after each agent action, and after each click, submit and address change of
// the person); this module takes one picture of a tab: the secret parts of the page are found, the viewport is captured through the debugger,
// and the picture is scaled to at most FRAME.width pixels wide with those parts painted over before it is encoded as a JPEG. Nothing on the page
// is changed. When the parts cannot be found for sure the picture is skipped, never sent unmasked.

export const FRAME = {
  width: 640, // the widest picture, in pixels
  quality: 0.5, // JPEG quality of the stored picture
  defaultFrames: 200, // pictures per recording unless max_frames says otherwise
  maxFrames: 500,
  maxBytes: 512 * 1024, // one picture (the server refuses larger ones)
  totalBytes: 50 * 1024 * 1024, // all pictures of a recording
  delayMs: 400, // after an action, for the page to react
  navDelayMs: 700, // after an address change
  settleMs: 5000, // waiting at most this long for the command to end and the page to load
  timeoutMs: 3000, // a tab that draws no picture in this time is skipped
  pad: 4, // CSS pixels around each masked part
};

// Whether an item gets a picture after it: every action of a tcli command (source 'agent'), every address change, and the person's clicks and
// form submits (their typing would make far too many pictures; the click or submit after it shows the result).
export const frameWorthy = (kind, data) => kind !== 'frame' && kind !== 'tab' && (data?.source === 'agent' || kind === 'nav' || data?.source === 'user' && (kind === 'click' || kind === 'submit'));

// Runs in every frame of the tab (chrome.scripting, isolated world; self-contained because it is serialised). The viewport rectangles of what
// the redaction treats as secret: password fields, fields whose name, id or autocomplete names a secret (the key rule of redact.js), payment
// and one-time-code autofill fields, fields whose value holds a JWT or a bearer token, and page text that holds one. Open shadow roots are
// searched too. `complete: false` when the page was too large to search whole; the top frame also lists its frames' rectangles.
export function sensitiveRects() {
  const SECRET = /(token|secret|session|passw|pwd|api[-_]?key|auth|signature|csrf|xsrf|cookie|ticket|code_verifier)/i;
  const AUTOFILL = /(password|one-time-code|cc-number|cc-csc|cc-exp)/i;
  const IN_TEXT = /eyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]{2,}|\bbearer\s+[\w\-.~+/]{8,}/i;
  const LIMIT = 50000;
  const W = innerWidth,
    H = innerHeight;
  const rects = [];
  const add = r => {
    if (r && r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H) rects.push({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height
    });
  };
  const roots = [document];
  let checked = 0,
    complete = true;
  for (let i = 0; i < roots.length && complete; i++) {
    for (const e of roots[i].querySelectorAll('*')) {
      if (++checked > LIMIT) {
        complete = false;
        break;
      }
      if (e.shadowRoot) roots.push(e.shadowRoot);
      if (e.localName !== 'input' && e.localName !== 'textarea' && e.localName !== 'select') continue;
      const auto = e.getAttribute('autocomplete') || '';
      const value = typeof e.value === 'string' ? e.value : '';
      if (String(e.type || '').toLowerCase() === 'password' || SECRET.test(`${e.name || ''} ${e.id || ''} ${auto}`) || AUTOFILL.test(auto) || IN_TEXT.test(value)) add(e.getBoundingClientRect());
    }
  }
  let texts = 0;
  for (const root of roots) {
    if (!complete) break;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (++texts > LIMIT) {
        complete = false;
        break;
      }
      const t = walker.currentNode.nodeValue;
      if (!t || t.length < 12 || !IN_TEXT.test(t)) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const r of range.getClientRects()) add(r);
    }
  }
  const top = window === window.top;
  const frames = top ? [...document.querySelectorAll('iframe,frame,embed,object')] : [];
  return {
    top,
    w: W,
    h: H,
    rects,
    complete,
    frame_count: frames.length,
    frames: frames.map(f => f.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0).map(r => ({
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height
    }))
  };
}

// The parts to paint over, from the answers of every frame (chrome.scripting results: [{ frameId, result }]), or null when they are not known
// for sure (no answer from the top frame, or it was too large to search). A frame inside the page cannot be measured from the top, so when one
// holds a secret part, or did not answer (fewer answers than frames), or was too large, every frame of the top document is painted over.
export function maskPlan(results) {
  const list = Array.isArray(results) ? results : [];
  const top = list.find(r => r && r.frameId === 0)?.result;
  if (!top || typeof top !== 'object' || !top.complete || !Array.isArray(top.rects)) return null;
  const subs = list.filter(r => r && r.frameId !== 0);
  const unsure = subs.length < (top.frame_count || 0) || subs.some(r => !r.result || !r.result.complete || !Array.isArray(r.result.rects) || r.result.rects.length > 0);
  return {
    w: top.w,
    h: top.h,
    rects: [...top.rects, ...(unsure ? top.frames || [] : [])]
  };
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

// The captured viewport (base64 JPEG or PNG) scaled to at most FRAME.width wide, the rectangles (viewport CSS pixels, viewW x viewH) painted
// over, encoded as a JPEG. Throws when the worker has no OffscreenCanvas (the picture is then skipped).
export async function encodeFrame(base64, viewW, viewH, rects) {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], {
    type: 'image/jpeg'
  }));
  const sourceW = bitmap.width,
    sourceH = bitmap.height;
  const scale = Math.min(1, FRAME.width / sourceW);
  const width = Math.max(1, Math.round(sourceW * scale)),
    height = Math.max(1, Math.round(sourceH * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const sx = width / (viewW || sourceW),
    sy = height / (viewH || sourceH);
  ctx.fillStyle = '#000';
  for (const r of rects) ctx.fillRect(Math.floor((r.x - FRAME.pad) * sx), Math.floor((r.y - FRAME.pad) * sy), Math.ceil((r.w + 2 * FRAME.pad) * sx), Math.ceil((r.h + 2 * FRAME.pad) * sy));
  const blob = await canvas.convertToBlob({
    type: 'image/jpeg',
    quality: FRAME.quality
  });
  const out = new Uint8Array(await blob.arrayBuffer());
  return {
    mime: 'image/jpeg',
    width,
    height,
    bytes: out.length,
    masked: rects.length,
    data_base64: toBase64(out)
  };
}

// One picture of tab `id`: { mime, width, height, bytes, masked, data_base64 }, or { skipped: 'debugger' | 'mask' | 'timeout' | 'error' |
// 'too large' }. The secret parts are looked up before and after the capture and both sets are painted over, so a page that moved meanwhile
// is still covered. deps: { cdp(id, method, params), executeScript(injection), debuggerOn }.
export async function framePicture(id, {
  cdp,
  executeScript,
  debuggerOn
}) {
  if (!debuggerOn) return {
    skipped: 'debugger'
  };
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return {
    skipped: 'mask'
  };
  const plan = async () => {
    try {
      return maskPlan(await executeScript({
        target: {
          tabId: id,
          allFrames: true
        },
        func: sensitiveRects
      }));
    } catch {
      return null;
    }
  };
  const before = await plan();
  if (!before) return {
    skipped: 'mask'
  };
  let shot, timer;
  try {
    shot = await Promise.race([cdp(id, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80
    }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('TIMEOUT')), FRAME.timeoutMs);
    })]);
  } catch (e) {
    return {
      skipped: /TIMEOUT/.test(e?.message) ? 'timeout' : 'error'
    };
  } finally {
    clearTimeout(timer);
  }
  const after = await plan();
  if (!after || typeof shot?.data !== 'string') return {
    skipped: after ? 'error' : 'mask'
  };
  let picture;
  try {
    const rects = new Map([...before.rects, ...after.rects].map(r => [`${r.x},${r.y},${r.w},${r.h}`, r]));
    picture = await encodeFrame(shot.data, before.w, before.h, [...rects.values()]);
  } catch {
    return {
      skipped: 'mask'
    };
  }
  return picture.bytes > FRAME.maxBytes ? {
    skipped: 'too large'
  } : picture;
}
