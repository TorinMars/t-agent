// The page actions of extension 1.0.8 ("Actions: drag, upload, fill, check, dialogs" in docs/design/browser-extension.md): input.drag,
// input.upload, input.fill, input.check and page.dialog. background.js calls runAction once it has the tab (allowed, `using` done) and hands
// over what it owns: the page script call, the recording's item writer and the agent marks.
import { redact, cut } from './redact.js';
import { captures, cdp, attach, detach } from './capture.js';
export const ACTION_METHODS = ['input.drag', 'input.upload', 'input.fill', 'input.check', 'page.dialog'];
// The most files one upload sets, and the most fields one fill sets.
export const UPLOAD_MAX_FILES = 20;
export const FILL_MAX_FIELDS = 100;
const fail = (code, message) => {
  throw new Error(`${code}: ${message}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isTarget = t => !!t && typeof t === 'object' && !Array.isArray(t) && (typeof t.ref === 'string' || typeof t.selector === 'string' || typeof t.text === 'string' || Number.isFinite(t.x) && Number.isFinite(t.y));
const basename = file => String(file).split(/[\\/]/).pop();

// ctx: { page(method, params), recording: bool, item(kind, data) (a recording's agent item), markAgent(ms), held() (net capture or a
// recording keeps the debugger, so a short attach must not detach it) }.
export async function runAction(method, id, p, ctx) {
  if (method === 'page.dialog') return dialog(id, p);
  if (method !== 'input.fill' && !isTarget(p.target)) fail('BAD_PARAMS', 'target is required');
  // The debugger for the moment of the command, as page.screenshot does (Chrome's yellow bar shows briefly).
  const briefly = async fn => {
    const temporary = !captures.has(id);
    if (temporary) await attach(id, {
      bodies: false
    });
    try {
      return await fn();
    } finally {
      if (temporary && !ctx.held()) await detach(id);
    }
  };
  if (method === 'input.check') {
    if (p.checked !== undefined && typeof p.checked !== 'boolean') fail('BAD_PARAMS', 'checked must be true or false');
    if (ctx.recording) {
      const d = await ctx.page('resolve', { target: p.target, focus: false, record_target: true });
      ctx.item('change', { source: 'agent', command: method, target: ctx.brief(d), checked: p.checked !== false });
    }
    return ctx.page('input.check', p);
  }
  if (method === 'input.fill') {
    if (!Array.isArray(p.fields) || !p.fields.length || p.fields.length > FILL_MAX_FIELDS) fail('BAD_PARAMS', `fields must be a list of 1 to ${FILL_MAX_FIELDS} { target, value }`);
    for (const f of p.fields) {
      if (!f || typeof f !== 'object' || !isTarget(f.target)) fail('BAD_PARAMS', 'Each field needs a target');
      const v = f.value;
      if (!(typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' || Array.isArray(v) && v.every(x => typeof x === 'string'))) fail('BAD_PARAMS', 'A field value is a string, true / false, or a list of strings (a multiple select)');
    }
    const fields = p.fields.map((f, i) => ({ target: f.target, value: f.value, label: typeof f.label === 'string' ? f.label.slice(0, 200) : `field ${i + 1}` }));
    if (ctx.recording) {
      // One agent item for the command, written before the values are set; the value of a secret field is its length only.
      const recorded = [];
      for (const f of fields) {
        let d = null;
        try {
          d = await ctx.page('resolve', { target: f.target, focus: false, record_target: true });
        } catch {/* Reported by the fill itself. */}
        const hidden = d && (d.sensitive || String(d.type || '').toLowerCase() === 'password');
        recorded.push({ target: d ? ctx.brief(d) : undefined, value: hidden && typeof f.value === 'string' ? `<redacted:${f.value.length}>` : f.value });
      }
      ctx.item('input', { source: 'agent', command: method, fields: recorded });
    }
    return ctx.page('input.fill', { fields });
  }
  if (method === 'input.drag') {
    if (!isTarget(p.to)) fail('BAD_PARAMS', 'to is required (a target, or x and y)');
    if (p.steps !== undefined && (!Number.isInteger(p.steps) || p.steps < 1 || p.steps > 100)) fail('BAD_PARAMS', 'steps must be 1 to 100');
    if (p.mode !== undefined && !['auto', 'mouse', 'html5'].includes(p.mode)) fail('BAD_PARAMS', 'mode must be auto, mouse or html5');
    const pts = await ctx.page('drag.resolve', p);
    const html5 = p.mode === 'html5' || (p.mode || 'auto') === 'auto' && pts.html5;
    if (ctx.recording) ctx.item('drag', { source: 'agent', command: method, target: pts.source, to: pts.target || { x: pts.to.x, y: pts.to.y }, how: html5 ? 'html5' : 'mouse' });
    const answer = { dragged: { from: pts.source, to: pts.target || { x: Math.round(pts.to.x), y: Math.round(pts.to.y) } } };
    if (html5) return { ...answer, how: 'html5', ...await ctx.page('drag.html5', { from: pts.from, to: pts.to }) };
    const steps = p.steps ?? 10;
    try {
      return await briefly(async () => {
        const mouse = (type, q, buttons) => cdp(id, 'Input.dispatchMouseEvent', { type, x: q.x, y: q.y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
        if (ctx.recording) await ctx.markAgent(10000);
        try {
          await mouse('mouseMoved', pts.from, 0);
          await mouse('mousePressed', pts.from, 1);
          for (let i = 1; i <= steps; i++) {
            await mouse('mouseMoved', { x: pts.from.x + (pts.to.x - pts.from.x) * i / steps, y: pts.from.y + (pts.to.y - pts.from.y) * i / steps }, 1);
            await sleep(16);
          }
          await mouse('mouseReleased', pts.to, 0);
        } finally {
          if (ctx.recording) await ctx.markAgent(150);
        }
        return { ...answer, how: 'mouse' };
      });
    } catch (e) {
      // DevTools holds the debugger: dispatched pointer and mouse events instead (not trusted; most drag code accepts them).
      if (!/DEBUGGER_BUSY/.test(e.message)) throw e;
      await ctx.page('drag.events', { from: pts.from, to: pts.to, steps });
      return { ...answer, how: 'events' };
    }
  }
  if (method === 'input.upload') {
    // The paths come from tcli, which takes only the files named on its command line; the bridge checked that each is a regular file
    // within the size limit and not a credential (services/browser-upload.js). Chrome reads the files itself: no bytes pass here.
    if (!Array.isArray(p.files) || !p.files.length || p.files.length > UPLOAD_MAX_FILES) fail('BAD_PARAMS', `files must be a list of 1 to ${UPLOAD_MAX_FILES} paths`);
    if (p.files.some(f => typeof f !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(f) || f.includes('\u0000') || f.length > 4096)) fail('BAD_PARAMS', 'files must be absolute paths');
    const marker = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const d = await ctx.page('upload.mark', { target: p.target, marker, count: p.files.length });
    const names = p.files.map(basename);
    if (ctx.recording) ctx.item('change', { source: 'agent', command: method, target: ctx.brief(d), files: names });
    try {
      await briefly(async () => {
        // The marked input, found in the page's own world (open shadow roots and same-origin iframes included).
        const found = await cdp(id, 'Runtime.evaluate', {
          expression: `(() => { const s = '[data-tagent-upload="${marker}"]'; const walk = r => { const hit = r.querySelector(s); if (hit) return hit; for (const e of r.querySelectorAll('*')) { if (e.shadowRoot) { const h = walk(e.shadowRoot); if (h) return h; } if (e.localName === 'iframe' || e.localName === 'frame') { try { const doc = e.contentDocument; const h = doc && walk(doc); if (h) return h; } catch {} } } return null; }; return walk(document); })()`,
          returnByValue: false
        });
        if (!found?.result?.objectId) fail('ELEMENT_NOT_FOUND', 'The file input left the page');
        // Chrome fires the input's input and change events itself (trusted): in a recording they are the command's, not the person's.
        if (ctx.recording) await ctx.markAgent(10000);
        try {
          await cdp(id, 'DOM.setFileInputFiles', { objectId: found.result.objectId, files: p.files });
        } finally {
          if (ctx.recording) await ctx.markAgent(300);
        }
      });
    } finally {
      await ctx.page('upload.unmark', { marker }).catch(() => {});
    }
    return { uploaded: { ref: d.ref, tag: d.tag, name: d.name }, files: names };
  }
  fail('UNKNOWN_METHOD', method);
}

// page.dialog ("Dialogs" in docs/design/browser-extension.md): is a JavaScript dialog (alert, confirm, prompt, beforeunload) open on the tab,
// and answer it. Without the debugger a dialog blocks the page, so no page script is used: the debugger attaches for the moment, outside
// capture.js (so its automatic answer does not run). Chrome tells a debugger about a dialog only when it opens, and a blocked page does not
// answer Page.enable, so: a dialog reported in the short wait gives its type and text; a page that does not answer within DIALOG_PROBE_MS is
// blocked (by a dialog, or by a long script) and is reported as `open: true, known: false`; accept / dismiss send
// Page.handleJavaScriptDialog in any case, which Chrome answers "No dialog is showing" (NO_DIALOG) when there is none. While net capture or a
// recording holds the debugger, capture.js answers every dialog at once, so none can be waiting.
const DIALOG_PROBE_MS = 600;
const listening = new Map();
chrome.debugger?.onEvent?.addListener((source, method, params) => listening.get(source.tabId)?.(method, params));
async function dialog(id, p) {
  const action = p.action ?? 'status';
  if (!['status', 'accept', 'dismiss'].includes(action)) fail('BAD_PARAMS', 'action must be status, accept or dismiss');
  if (p.text !== undefined && (typeof p.text !== 'string' || action !== 'accept')) fail('BAD_PARAMS', 'text is a string, only with accept');
  if (captures.has(id)) {
    if (action === 'status') return { open: false, automatic: true };
    fail('NO_DIALOG', 'No dialog is waiting: while net capture or a recording runs, dialogs are answered at once (alert accepted, confirm and prompt dismissed)');
  }
  let open = null;
  listening.set(id, (method, q) => {
    if (method === 'Page.javascriptDialogOpening') open = q;
    if (method === 'Page.javascriptDialogClosed') open = null;
  });
  const target = { tabId: id };
  try {
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch {
      fail('DEBUGGER_BUSY', 'DevTools or another debugger is attached');
    }
    try {
      let answered = false;
      const enabled = Promise.resolve(chrome.debugger.sendCommand(target, 'Page.enable')).then(() => { answered = true; }, () => { answered = true; });
      const end = Date.now() + DIALOG_PROBE_MS;
      while (Date.now() < end && !open && !answered) await sleep(25);
      if (answered && !open) await Promise.race([enabled, sleep(50)]);
      const info = open ? { type: String(open.type || 'alert'), message: redact(cut(String(open.message || ''), 500).text), url: redact(String(open.url || '')), ...(open.type === 'prompt' ? { default_prompt: redact(cut(String(open.defaultPrompt || ''), 500).text) } : {}) } : null;
      const blocked = !info && !answered;
      if (action === 'status') return info ? { open: true, known: true, ...info } : blocked ? { open: true, known: false } : { open: false };
      if (!info && !blocked) fail('NO_DIALOG', 'No dialog is open on this tab');
      const accept = action === 'accept';
      try {
        await chrome.debugger.sendCommand(target, 'Page.handleJavaScriptDialog', { accept, ...(accept && p.text !== undefined ? { promptText: p.text } : {}) });
      } catch (e) {
        if (/no dialog/i.test(e.message)) fail('NO_DIALOG', blocked ? 'The page is blocked, but not by a dialog T-Agent can answer (a long script, or a dialog another debugger holds)' : 'No dialog is open on this tab');
        throw e;
      }
      return { handled: accept ? 'accepted' : 'dismissed', known: !!info, ...(info || {}) };
    } finally {
      try {
        await chrome.debugger.detach(target);
      } catch {/* Already detached. */}
    }
  } finally {
    listening.delete(id);
  }
}
