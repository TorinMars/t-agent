// This self-contained function executes in the isolated world, only on allowed tabs.
export async function pageAction(method, p) {
  // The events an input command dispatches here are the command's own: a running page recorder (installRecorder) leaves them out, because
  // background.js records the command once, with source 'agent'.
  const acting = typeof method === 'string' && (method.startsWith('input.') || method.startsWith('drag.'));
  if (acting) globalThis.__tagentAgentBusy = (globalThis.__tagentAgentBusy || 0) + 1;
  try {
    return {
      ok: true,
      result: await run()
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  } finally {
    if (acting) globalThis.__tagentAgentBusy = Math.max(0, (globalThis.__tagentAgentBusy || 1) - 1);
  }
  async function run() {
    const fail = (code, message) => {
      throw new Error(`${code}: ${message}`);
    };
    // Refs ("Snapshot" in docs/design/browser-extension.md): `refs` maps a ref to its element, `ids` (a WeakMap) the element to its ref, so
    // the same DOM node keeps the same ref in every snapshot of the document until the address changes (`invalidate`). `last`: the refs of
    // the last snapshot (shot --annotate draws them); `prev`: the last snapshot of each --selector / --filter in short, for snapshot --diff.
    const state = globalThis.__tagentPage ||= {
      refs: new Map(),
      next: 1
    };
    state.ids ||= new WeakMap();
    state.last ||= [];
    // The window of an element (an element of a same-origin iframe has its own), its root (a document or an open shadow root), and where
    // the frames it is in put it in the top viewport.
    const style = e => (e.ownerDocument?.defaultView || globalThis).getComputedStyle(e);
    const rootOf = e => e.getRootNode?.() || document;
    const inShadow = e => !!rootOf(e).host;
    const frameDepth = e => {
      let n = 0;
      for (let d = e.ownerDocument; d && d !== document && n < 10; n++) d = d.defaultView?.frameElement?.ownerDocument;
      return n;
    };
    const offset = e => {
      let x = 0,
        y = 0;
      for (let d = e.ownerDocument, n = 0; d && d !== document && n < 10; n++) {
        const f = d.defaultView?.frameElement;
        if (!f) break;
        const r = f.getBoundingClientRect();
        x += r.left + (f.clientLeft || 0);
        y += r.top + (f.clientTop || 0);
        d = f.ownerDocument;
      }
      return {
        x,
        y
      };
    };
    const rectOf = e => {
      const r = e.getBoundingClientRect(),
        o = offset(e);
      return {
        x: r.x + o.x,
        y: r.y + o.y,
        w: r.width,
        h: r.height
      };
    };
    // Every element under a root, with what is inside open shadow roots and same-origin iframes (a cross-origin frame cannot be read; a
    // closed shadow root neither). The inner elements follow their host or frame.
    const deep = (root, out = [], depth = 0) => {
      for (const e of root.querySelectorAll('*')) {
        if (out.length >= 50000) break;
        out.push(e);
        if (depth >= 8) continue;
        if (e.shadowRoot) deep(e.shadowRoot, out, depth + 1);
        if (e.localName === 'iframe' || e.localName === 'frame') {
          let d = null;
          try {
            d = e.contentDocument;
          } catch {/* Cross-origin. */}
          if (d?.documentElement) deep(d, out, depth + 1);
        }
      }
      return out;
    };
    // css: targets look into open shadow roots and same-origin iframes when the document itself has no match.
    const deepQuery = s => {
      const hit = document.querySelector(s);
      if (hit) return hit;
      for (const e of deep(document)) {
        const inner = e.shadowRoot?.querySelector(s) || ((e.localName === 'iframe' || e.localName === 'frame') && (() => {
          try {
            return e.contentDocument?.querySelector(s);
          } catch {
            return null;
          }
        })());
        if (inner) return inner;
      }
      return null;
    };
    // The element at a point of the top viewport, inside shadow roots and same-origin iframes.
    const elementAt = (x, y) => {
      let e = document.elementFromPoint(x, y);
      for (let n = 0; e && n < 10; n++) {
        const inner = e.shadowRoot?.elementFromPoint?.(x - offset(e).x, y - offset(e).y);
        if (inner && inner !== e) {
          e = inner;
          continue;
        }
        if (e.localName === 'iframe' || e.localName === 'frame') {
          let d = null;
          try {
            d = e.contentDocument;
          } catch {/* Cross-origin. */}
          const r = e.getBoundingClientRect();
          const o = offset(e);
          const hit = d?.elementFromPoint(x - o.x - r.left - (e.clientLeft || 0), y - o.y - r.top - (e.clientTop || 0));
          if (hit) {
            e = hit;
            continue;
          }
        }
        break;
      }
      return e;
    };
    const visible = e => !!(e.getClientRects().length && style(e).visibility !== 'hidden' && style(e).display !== 'none');
    const selector = e => {
      const root = rootOf(e);
      if (e.id) return `#${CSS.escape(e.id)}`;
      for (const k of ['data-testid', 'data-test', 'aria-label', 'name']) if (e.getAttribute(k)) {
        const s = `${e.localName}[${k}=${JSON.stringify(e.getAttribute(k))}]`;
        if (root.querySelectorAll(s).length === 1) return s;
      }
      const path = [];
      for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
        path.unshift(`${n.localName}:nth-of-type(${[...(n.parentElement?.children || [n])].filter(x => x.localName === n.localName).indexOf(n) + 1})`);
        if (root.querySelectorAll(path.join(' > ')).length === 1) break;
      }
      return path.join(' > ');
    };
    // The native value setter (React and other frameworks track the value through it). By tag, not instanceof: an element of an iframe has
    // the classes of its own window.
    const valueSetter = e => Object.getOwnPropertyDescriptor(e.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    const refOf = e => {
      let ref = state.ids.get(e);
      if (!ref || state.refs.get(ref) !== e) {
        ref = `e${state.next++}`;
        state.ids.set(e, ref);
        state.refs.set(ref, e);
      }
      return ref;
    };
    const secret = e => /(token|secret|session|passw|pwd|api[-_]?key|auth|signature|csrf|xsrf|cookie|ticket|code_verifier)/i.test(`${e.name || ''} ${e.id || ''} ${e.autocomplete || ''}`);
    const safeValue = e => secret(e) ? `<redacted:${String(e.value ?? '').length}>` : e.value;
    const describe = e => {
      const ref = refOf(e);
      const r = rectOf(e);
      const d = {
        ref,
        tag: e.localName,
        role: e.getAttribute('role') || {
          button: 'button',
          a: 'link',
          textarea: 'textbox',
          select: 'combobox',
          main: 'main',
          nav: 'navigation',
          form: 'form',
          dialog: 'dialog',
          h1: 'heading',
          h2: 'heading',
          h3: 'heading'
        }[e.localName] || (e.localName === 'input' ? {
          checkbox: 'checkbox',
          radio: 'radio',
          range: 'slider',
          button: 'button',
          submit: 'button'
        }[e.type] || 'textbox' : ''),
        name: e.getAttribute('aria-label') || e.getAttribute('alt') || e.labels?.[0]?.innerText || e.getAttribute('name') || (e.innerText || '').slice(0, 300),
        text: (e.innerText || '').slice(0, 2000),
        selector: selector(e),
        rect: r,
        in_viewport: r.y + r.h > 0 && r.x + r.w > 0 && r.y < innerHeight && r.x < innerWidth
      };
      if ('value' in e && e.type !== 'password') d.value = safeValue(e);
      for (const k of ['href', 'type', 'checked', 'disabled']) if (k in e) d[k] = e[k];
      const frame = frameDepth(e);
      if (frame) d.frame = frame;
      if (inShadow(e)) d.shadow = true;
      return d;
    };
    const target = (t, {
      scroll = true
    } = {}) => {
      let e;
      if (t?.ref) {
        e = state.refs.get(t.ref);
        if (!e?.isConnected) fail('REF_NOT_FOUND', 'Unknown or stale ref');
      } else if (t?.selector) e = deepQuery(t.selector);else if (t?.text) e = deep(document).filter(n => n.localName !== 'head' && visible(n)).find(n => (n.innerText || '').trim() === t.text && ![...n.children].some(c => (c.innerText || '').trim() === t.text));else if (Number.isFinite(t?.x) && Number.isFinite(t?.y)) e = elementAt(t.x, t.y);
      if (!e) fail('ELEMENT_NOT_FOUND', 'No matching element');
      if (!visible(e) || e.disabled) fail('ELEMENT_NOT_INTERACTABLE', 'Element is hidden or disabled');
      if (scroll) e.scrollIntoView({
        block: 'center',
        inline: 'nearest'
      });
      return e;
    };
    const fire = (e, ...types) => {
      for (const type of types) e.dispatchEvent(new Event(type, {
        bubbles: true
      }));
    };
    // A checkbox, a radio, a label of one, or an ARIA checkbox / switch / radio: its state, and a click when it must change (the page's own
    // handlers run as for a person's click). A radio is turned off directly (a click cannot do that).
    const checkable = e => {
      const box = e.localName === 'label' && e.control ? e.control : e;
      if (box.localName === 'input' && ['checkbox', 'radio'].includes(box.type)) return box;
      if (['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'].includes(box.getAttribute?.('role'))) return box;
      return null;
    };
    const isChecked = box => box.localName === 'input' ? box.checked : box.getAttribute('aria-checked') === 'true';
    const setChecked = (e, on) => {
      const box = checkable(e);
      if (!box) fail('ELEMENT_NOT_INTERACTABLE', 'Not a checkbox or radio');
      if (isChecked(box) !== on) {
        if (!on && box.localName === 'input' && box.type === 'radio') {
          box.checked = false;
          fire(box, 'input', 'change');
        } else e.click();
      }
      if (isChecked(box) !== on) fail('ELEMENT_NOT_INTERACTABLE', 'The page did not change it');
      return on;
    };
    const asBool = v => v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
    // One field of input.fill: text inputs and textareas (the native setter, input and change events, as `type` does), a select by value or
    // label, a checkbox or radio by true / false, date / time / number inputs by their string value, contenteditable text.
    const VALUE_TYPES = ['date', 'time', 'datetime-local', 'month', 'week', 'number', 'range', 'color'];
    const setField = (e, v) => {
      const type = String(e.type || '').toLowerCase();
      if (e.localName === 'select') {
        const wanted = (Array.isArray(v) ? v : [v]).map(String);
        if (!e.multiple && wanted.length !== 1) fail('BAD_PARAMS', 'This select takes one value');
        const options = [...e.options];
        const chosen = wanted.map(w => options.find(o => o.value === w) || options.find(o => (o.label || o.text || '').trim() === w.trim()));
        const missing = wanted.find((w, i) => !chosen[i]);
        if (missing !== undefined) fail('BAD_PARAMS', `No option with the value or label ${JSON.stringify(missing.slice(0, 80))}`);
        for (const o of options) o.selected = chosen.includes(o);
        fire(e, 'input', 'change');
        return {
          kind: 'select',
          value: secret(e) ? `<redacted:${String(e.value).length}>` : e.multiple ? chosen.map(o => o.value) : e.value
        };
      }
      if (checkable(e)) {
        const on = asBool(v);
        if (on === null) fail('BAD_PARAMS', 'A checkbox or radio takes true or false');
        return {
          kind: checkable(e).type || checkable(e).getAttribute('role'),
          checked: setChecked(e, on)
        };
      }
      if (type === 'file') fail('ELEMENT_NOT_INTERACTABLE', 'A file input: use upload');
      if (v !== null && typeof v === 'object') fail('BAD_PARAMS', 'A text field takes a string');
      const text = String(v ?? '');
      if (e.isContentEditable) {
        e.focus();
        e.textContent = text;
        e.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        }));
        return {
          kind: 'contenteditable'
        };
      }
      if (!['input', 'textarea'].includes(e.localName) || e.readOnly) fail('ELEMENT_NOT_INTERACTABLE', 'Not an editable form field');
      e.focus();
      valueSetter(e).call(e, text);
      if (text && !e.value && VALUE_TYPES.includes(type)) fail('BAD_PARAMS', `Not a valid ${type} value (the browser cleared it; a date is YYYY-MM-DD, a time HH:MM)`);
      e.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: type === 'password' ? null : text
      }));
      fire(e, 'change');
      return {
        kind: e.localName === 'textarea' ? 'textarea' : type || 'text'
      };
    };
    if (method === 'viewport') return {
      width: innerWidth,
      height: innerHeight,
      device_scale_factor: devicePixelRatio
    };
    if (method === 'invalidate') {
      state.refs.clear();
      state.ids = new WeakMap();
      state.next = 1;
      state.last = [];
      state.prev = new Map();
      return;
    }
    if (method === 'page.snapshot' || method === 'page.query') {
      // Refs stay: an element that is still in the document keeps its ref; the refs of elements that left it are dropped.
      if (method === 'page.snapshot') for (const [ref, e] of state.refs) if (!e.isConnected) state.refs.delete(ref);
      const root = p.selector && method === 'page.snapshot' ? deepQuery(p.selector) : document;
      if (!root) fail('ELEMENT_NOT_FOUND', 'Snapshot root missing');
      const base = {
        url: location.href,
        title: document.title
      };
      const limit = Math.min(p.max_bytes ?? 200000, 1048576);
      const cut = s => {
        const b = new TextEncoder().encode(s);
        return {
          text: new TextDecoder().decode(b.slice(0, limit), {
            stream: true
          }),
          truncated: b.length > limit
        };
      };
      if (p.mode === 'html') {
        const copy = (root === document ? document.documentElement : root).cloneNode(true);
        for (const e of [copy, ...copy.querySelectorAll('input,textarea,select')]) {
          if (e.type === 'password') {
            e.removeAttribute('value');
            e.textContent = '';
          } else if (secret(e)) {
            if (e.hasAttribute('value')) e.setAttribute('value', safeValue(e));
            if (e.localName === 'textarea') e.textContent = safeValue(e);
            if (e.localName === 'select') for (const option of e.options) {
              option.value = `<redacted:${option.value.length}>`;
              option.textContent = `<redacted:${option.textContent.length}>`;
            }
          }
        }
        const c = cut(copy.outerHTML);
        return {
          ...base,
          html: c.text,
          truncated: c.truncated
        };
      }
      if (p.mode === 'text') {
        const c = cut((root === document ? document.body : root).innerText);
        return {
          ...base,
          text: c.text,
          truncated: c.truncated
        };
      }
      // --filter interactive: only what can be clicked or typed in (links, buttons, form fields, ARIA widgets, contenteditable, tabindex,
      // onclick, draggable).
      const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[role=treeitem],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[onclick],[draggable="true"]';
      const nodes = method === 'page.query' ? [...document.querySelectorAll(p.selector)].slice(0, p.all ? Math.min(p.limit ?? 50, 1000) : 1) : deep(root).filter(p.filter === 'interactive' ? e => e.matches(INTERACTIVE) : e => e.matches('a,button,input,textarea,select,[role],main,nav,header,footer,section,article,h1,h2,h3,p,li,label,summary,dialog,form,[contenteditable]') || [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
      if (method === 'page.snapshot' && root !== document) nodes.unshift(root);
      const elements = [];
      let size = 0,
        truncated = false;
      for (const e of nodes.filter(visible)) {
        const d = describe(e);
        size += new TextEncoder().encode(JSON.stringify(d)).length;
        if (size > limit) {
          truncated = true;
          break;
        }
        elements.push(d);
      }
      if (method === 'page.query') return {
        elements
      };
      // snapshot --diff: what was added, removed or changed since the last snapshot of this document with the same --selector and --filter
      // (same ref = same node, so a changed element is one whose name, text, value or state changed). Without one, the whole snapshot.
      const FIELDS = ['tag', 'role', 'name', 'text', 'value', 'checked', 'disabled', 'href'];
      const short = d => Object.fromEntries(FIELDS.filter(k => d[k] !== undefined).map(k => [k, k === 'text' ? String(d.text).slice(0, 300) : d[k]]));
      const key = `${p.selector || ''}|${p.filter || ''}`;
      if (!(state.prev instanceof Map)) state.prev = new Map();
      const before = p.diff ? state.prev.get(key) : null;
      const now = new Map(elements.map(d => [d.ref, short(d)]));
      // The last snapshot of each --selector / --filter pair, at most 5.
      state.prev.delete(key);
      state.prev.set(key, now);
      if (state.prev.size > 5) state.prev.delete(state.prev.keys().next().value);
      state.last = elements.map(d => d.ref);
      const out = {
        ...base,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          device_scale_factor: devicePixelRatio
        },
        truncated
      };
      if (!p.diff) return {
        ...out,
        elements
      };
      if (!before) return {
        ...out,
        elements,
        diff: {
          base: false
        }
      };
      const added = [],
        changed = [];
      let same = 0;
      for (const d of elements) {
        const old = before.get(d.ref);
        if (!old) {
          added.push(d);
          continue;
        }
        const current = short(d),
          was = {};
        for (const k of FIELDS) if (JSON.stringify(old[k]) !== JSON.stringify(current[k])) was[k] = old[k] ?? null;
        if (Object.keys(was).length) changed.push({
          ...d,
          was
        });else same++;
      }
      const removed = [...before].filter(([ref]) => !now.has(ref)).map(([ref, d]) => ({
        ref,
        ...d
      }));
      return {
        ...out,
        diff: {
          base: true,
          added,
          removed,
          changed,
          same
        }
      };
    }
    // shot --annotate: the refs of the last snapshot drawn on the page as numbered boxes for the moment of the screenshot (an overlay that
    // takes no clicks; `annotate.clear` removes it). The recorder leaves the overlay out of its DOM items.
    if (method === 'annotate' || method === 'annotate.clear') {
      document.querySelectorAll('[data-tagent-overlay]').forEach(n => n.remove());
      if (method === 'annotate.clear') return {};
      const box = document.createElement('div');
      box.setAttribute('data-tagent-overlay', '');
      box.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;';
      let annotated = 0;
      for (const ref of state.last) {
        const e = state.refs.get(ref);
        if (!e?.isConnected || !visible(e)) continue;
        const r = rectOf(e);
        if (r.w <= 0 || r.h <= 0) continue;
        const x = r.x + scrollX,
          y = r.y + scrollY;
        const frame = document.createElement('div');
        frame.style.cssText = `position:absolute;box-sizing:border-box;left:${x}px;top:${y}px;width:${r.w}px;height:${r.h}px;border:2px solid #e91e63;border-radius:2px;`;
        const label = document.createElement('div');
        label.textContent = ref;
        label.style.cssText = `position:absolute;left:${x}px;top:${Math.max(0, y - 16)}px;font:bold 11px/16px monospace;color:#fff;background:#e91e63;padding:0 4px;border-radius:2px;white-space:nowrap;`;
        box.append(frame, label);
        if (++annotated >= 500) break;
      }
      document.documentElement.appendChild(box);
      return {
        annotated
      };
    }
    // upload: the file input is marked so the worker finds it through the debugger (DOM.setFileInputFiles needs the node in the page's world).
    if (method === 'upload.mark') {
      const e = target(p.target);
      if (e.localName !== 'input' || e.type !== 'file') fail('ELEMENT_NOT_INTERACTABLE', 'Not a file input (input type=file)');
      if (p.count > 1 && !e.multiple) fail('BAD_PARAMS', 'This file input takes one file');
      e.setAttribute('data-tagent-upload', p.marker);
      return describe(e);
    }
    if (method === 'upload.unmark') {
      for (const e of deep(document)) if (e.getAttribute?.('data-tagent-upload') === p.marker) e.removeAttribute('data-tagent-upload');
      return {};
    }
    if (method === 'input.fill') {
      const fields = [];
      for (const f of p.fields) {
        try {
          fields.push({
            target: f.label,
            ok: true,
            ...setField(target(f.target), f.value)
          });
        } catch (error) {
          const m = /^([A-Z_]+): (.*)$/s.exec(error.message);
          fields.push({
            target: f.label,
            ok: false,
            code: m ? m[1] : 'BAD_PARAMS',
            error: m ? m[2] : error.message
          });
        }
      }
      return {
        fields,
        filled: fields.filter(f => f.ok).length
      };
    }
    if (method === 'input.check') {
      const e = target(p.target);
      const d = describe(e);
      return {
        checked: setChecked(e, p.checked !== false),
        target: {
          ref: d.ref,
          tag: d.tag,
          name: d.name
        }
      };
    }
    // drag: the points of the source and the target in the top viewport (the source scrolled into view, the target not, unless it is off
    // screen), and whether the source is an HTML5 draggable (draggable="true").
    if (method === 'drag.resolve') {
      const from = target(p.target);
      const point = (e, t) => {
        if (!e) return {
          x: t.x,
          y: t.y
        };
        const r = rectOf(e);
        return {
          x: r.x + r.w / 2,
          y: r.y + r.h / 2
        };
      };
      const pointTarget = Number.isFinite(p.to?.x) && Number.isFinite(p.to?.y) && !p.to.ref && !p.to.selector && !p.to.text;
      let to = pointTarget ? null : target(p.to, {
        scroll: false
      });
      let a = point(from),
        b = point(to, p.to);
      const inside = q => q.x >= 0 && q.y >= 0 && q.x < innerWidth && q.y < innerHeight;
      if (!inside(b) && to) {
        to.scrollIntoView({
          block: 'nearest',
          inline: 'nearest'
        });
        a = point(from);
        b = point(to);
      }
      if (!inside(a) || !inside(b)) fail('ELEMENT_NOT_INTERACTABLE', 'The source and the target do not fit in the viewport together; scroll, or drag in steps');
      const d = describe(from);
      return {
        from: a,
        to: b,
        html5: !!from.closest?.('[draggable="true"]'),
        source: {
          ref: d.ref,
          tag: d.tag,
          name: d.name
        },
        target: to ? (({
          ref,
          tag,
          name
        }) => ({
          ref,
          tag,
          name
        }))(describe(to)) : null
      };
    }
    // An HTML5 drag and drop (dragstart, dragenter, dragover, drop, dragend with one DataTransfer): Chrome starts no native drag for input
    // the debugger sends, so the page's drag handlers get these events instead.
    if (method === 'drag.html5') {
      const src = elementAt(p.from.x, p.from.y)?.closest?.('[draggable="true"]') || elementAt(p.from.x, p.from.y);
      const dt = new DataTransfer();
      const send = (type, el, q) => {
        const o = offset(el);
        return el.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: q.x - o.x,
          clientY: q.y - o.y,
          dataTransfer: dt
        }));
      };
      if (!src) fail('ELEMENT_NOT_FOUND', 'No element at the source point');
      if (!send('dragstart', src, p.from)) return {
        dropped: false,
        reason: 'the page cancelled dragstart'
      };
      send('drag', src, p.from);
      const over = elementAt(p.to.x, p.to.y);
      if (!over) fail('ELEMENT_NOT_FOUND', 'No element at the target point');
      send('dragenter', over, p.to);
      const accepted = !send('dragover', over, p.to);
      if (accepted) send('drop', over, p.to);
      send('dragend', src, p.to);
      return {
        dropped: accepted,
        ...(accepted ? {} : {
          reason: 'the target did not accept the drop (no dragover handler called preventDefault)'
        })
      };
    }
    // A drag with dispatched pointer and mouse events, when the debugger cannot attach (DevTools is open on the tab).
    if (method === 'drag.events') {
      const steps = p.steps ?? 10;
      const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      const at = (type, q, buttons) => {
        const el = elementAt(q.x, q.y);
        if (!el) return;
        const o = offset(el);
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: q.x - o.x,
          clientY: q.y - o.y,
          button: 0,
          buttons,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true
        };
        el.dispatchEvent(new P(`pointer${type}`, init));
        el.dispatchEvent(new MouseEvent(`mouse${type}`, init));
      };
      at('down', p.from, 1);
      for (let i = 1; i <= steps; i++) at('move', {
        x: p.from.x + (p.to.x - p.from.x) * i / steps,
        y: p.from.y + (p.to.y - p.from.y) * i / steps
      }, 1);
      at('up', p.to, 0);
      return {};
    }
    if (method === 'resolve') {
      const e = target(p.target);
      if (p.focus !== false) e.focus();
      if (p.editable && (e.readOnly || !('value' in e) && !e.isContentEditable)) fail('ELEMENT_NOT_INTERACTABLE', 'Element is not editable');
      const d = describe(e);
      if (e.type === 'password' || secret(e)) d.sensitive = true;
      // For the agent item of a recording: the recorder's description (with the nearest meaningful element), else this one.
      if (p.record_target) d.recorded = globalThis.__tagentRecorder?.info?.(e) || undefined;
      return d;
    }
    if (method === 'page.wait.check') {
      if (p.selector && [...document.querySelectorAll(p.selector)].some(visible)) return 'selector';
      if (p.text && document.body.innerText.includes(p.text)) return 'text';
      if (p.url_includes && location.href.includes(p.url_includes)) return 'url';
      return null;
    }
    if (method === 'input.press') {
      // The focused element, inside shadow roots and same-origin iframes.
      let e = document.activeElement;
      for (let n = 0; e && n < 10; n++) {
        let inner = e.shadowRoot?.activeElement;
        if (!inner && (e.localName === 'iframe' || e.localName === 'frame')) try {
          inner = e.contentDocument?.activeElement;
        } catch {/* Cross-origin. */}
        if (!inner || inner === e) break;
        e = inner;
      }
      const opts = {
        key: p.key,
        bubbles: true,
        cancelable: true,
        ctrlKey: p.modifiers?.includes('Control'),
        metaKey: p.modifiers?.includes('Meta'),
        shiftKey: p.modifiers?.includes('Shift'),
        altKey: p.modifiers?.includes('Alt')
      };
      const proceed = e.dispatchEvent(new KeyboardEvent('keydown', opts));
      if (proceed && !e.disabled && !e.readOnly && 'value' in e) {
        const shortcut = opts.ctrlKey || opts.metaKey;
        if (shortcut && p.key.toLowerCase() === 'a') e.select?.();else if (!shortcut && !opts.altKey && (p.key.length === 1 || ['Backspace', 'Delete'].includes(p.key))) {
          let start = e.selectionStart ?? e.value.length,
            end = e.selectionEnd ?? start;
          if (p.key === 'Backspace' && start === end) start = Math.max(0, start - 1);
          if (p.key === 'Delete' && start === end) end = Math.min(e.value.length, end + 1);
          const text = p.key.length === 1 ? p.key : '';
          const setter = valueSetter(e);
          if (setter) {
            setter.call(e, e.value.slice(0, start) + text + e.value.slice(end));
            e.setSelectionRange?.(start + text.length, start + text.length);
            e.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              inputType: text ? 'insertText' : 'deleteContentBackward',
              data: e.type === 'password' ? null : text
            }));
          }
        } else if (!shortcut && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(p.key) && e.selectionStart !== null) {
          const pos = p.key === 'Home' ? 0 : p.key === 'End' ? e.value.length : Math.max(0, Math.min(e.value.length, (e.selectionStart ?? 0) + (p.key === 'ArrowLeft' ? -1 : 1)));
          e.setSelectionRange?.(pos, pos);
        }
      }
      e.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (proceed && p.key === 'Enter') e.form?.requestSubmit();
      if (proceed && p.key === 'Tab') {
        const list = [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')].filter(visible);
        list[(list.indexOf(e) + (opts.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
      }
      return {};
    }
    if (method === 'input.scroll') {
      const e = p.target ? target(p.target) : window;
      e.scrollBy(p.dx ?? 0, p.dy ?? 600);
      return {};
    }
    const e = target(p.target);
    if (method !== 'input.hover') e.focus();
    const d = describe(e),
      r = e.getBoundingClientRect(),
      o = offset(e);
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: (p.target?.x ?? r.x + r.width / 2 + o.x) - o.x,
      clientY: (p.target?.y ?? r.y + r.height / 2 + o.y) - o.y,
      button: {
        left: 0,
        middle: 1,
        right: 2
      }[p.button || 'left'],
      detail: p.count ?? 1,
      ctrlKey: p.modifiers?.includes('Control'),
      metaKey: p.modifiers?.includes('Meta'),
      shiftKey: p.modifiers?.includes('Shift'),
      altKey: p.modifiers?.includes('Alt')
    };
    if (method === 'input.click') {
      for (let i = 0; i < (p.count ?? 1); i++) {
        e.dispatchEvent(new MouseEvent('mousedown', opts));
        e.dispatchEvent(new MouseEvent('mouseup', opts));
        e.dispatchEvent(new MouseEvent(p.button === 'right' ? 'contextmenu' : p.button === 'middle' ? 'auxclick' : 'click', opts));
      }
      if (p.count === 2) e.dispatchEvent(new MouseEvent('dblclick', opts));
      return {
        clicked: {
          ref: d.ref,
          tag: d.tag,
          name: d.name
        }
      };
    }
    if (method === 'input.hover') {
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) e.dispatchEvent(new MouseEvent(type, opts));
      return {};
    }
    if (method === 'input.type') {
      if (e.readOnly || !('value' in e) && !e.isContentEditable) fail('ELEMENT_NOT_INTERACTABLE', 'Element is not editable');
      if (e.isContentEditable) e.textContent = (p.clear ? '' : e.textContent) + p.text;else {
        const setter = valueSetter(e);
        if (!setter) fail('ELEMENT_NOT_INTERACTABLE', 'Element is not a text input');
        setter.call(e, (p.clear ? '' : e.value) + p.text);
      }
      e.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: e.type === 'password' ? null : p.text
      }));
      e.dispatchEvent(new Event('change', {
        bubbles: true
      }));
      if (p.submit) e.form?.requestSubmit();
      return {};
    }
    if (method === 'input.select') {
      if (!e.options) fail('ELEMENT_NOT_INTERACTABLE', 'Element is not a select');
      for (const o of e.options || []) o.selected = p.values.includes(o.value);
      e.dispatchEvent(new Event('input', {
        bubbles: true
      }));
      e.dispatchEvent(new Event('change', {
        bubbles: true
      }));
      return {};
    }
    fail('UNKNOWN_METHOD', method);
  }
}
// The page recorder of a recording ("Recording" in docs/design/browser-extension.md), in the isolated world of the tab's top document. It is
// self-contained (executeScript serialises it) and runs once per document and recording: background.js injects it when a document commits
// (as early as it can, so the first load is recorded) and again when the page has loaded, and the second call does nothing.
export function installRecorder(recordingId, options = {}) {
  if (globalThis.__tagentRecorder?.id === recordingId) return;
  globalThis.__tagentRecorder?.stop();
  const listeners = [];
  let seq = 0,
    lastURL = location.href,
    added = 0,
    removed = 0,
    attrs = 0;
  const secret = /(token|secret|session|passw|pwd|api[-_]?key|auth|signature|csrf|xsrf|cookie|ticket|code_verifier)/i;
  const safe = e => e.type === 'password';
  const sensitive = e => safe(e) || secret.test(`${e.name || ''} ${e.id || ''} ${e.autocomplete || ''}`);
  const flat = (text, max) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) : t;
  };
  // innerText is undefined on SVG elements; textContent then.
  const textOf = (e, max = 2000) => safe(e) ? '' : flat(e.innerText ?? e.textContent, max);
  const selector = e => {
    if (e.id) return `#${CSS.escape(e.id)}`;
    for (const k of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'title']) if (e.getAttribute(k)) {
      const s = `${e.localName}[${k}=${JSON.stringify(e.getAttribute(k))}]`;
      try {
        if (document.querySelectorAll(s).length === 1) return s;
      } catch {/* Not a valid selector. */}
    }
    const parts = [];
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      parts.unshift(`${n.localName}:nth-of-type(${[...(n.parentElement?.children || [n])].filter(x => x.localName === n.localName).indexOf(n) + 1})`);
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
    }
    return parts.join(' > ');
  };
  const labelledBy = e => (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
  const svgTitle = e => e.localName === 'svg' ? [...e.children].find(c => c.localName === 'title')?.textContent || '' : '';
  const IMPLICIT = {
    button: 'button',
    select: 'combobox',
    textarea: 'textbox',
    summary: 'button',
    dialog: 'dialog',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    form: 'form',
    option: 'option',
    h1: 'heading',
    h2: 'heading',
    h3: 'heading',
    h4: 'heading',
    h5: 'heading',
    h6: 'heading'
  };
  const roleOf = e => e.getAttribute('role') || (e.localName === 'a' && e.hasAttribute('href') ? 'link' : IMPLICIT[e.localName]) || (e.localName === 'input' ? {
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button'
  }[e.type] || 'textbox' : '');
  // The accessible name, roughly: aria-label, aria-labelledby, a <label>, alt, title, an SVG <title>, a placeholder, a button's value, the text.
  const nameOf = e => flat(e.getAttribute('aria-label') || labelledBy(e) || (e.labels?.[0] ? e.labels[0].innerText ?? e.labels[0].textContent : '') || e.getAttribute('alt') || e.getAttribute('title') || svgTitle(e) || e.getAttribute('placeholder') || (['submit', 'button', 'reset'].includes(e.type) && e.localName === 'input' ? e.value : '') || textOf(e, 80), 80);
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,option,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[role=treeitem],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[onclick]';
  const labelled = e => !!(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title') || e.getAttribute('alt') || svgTitle(e));
  const pointer = e => {
    try {
      return getComputedStyle(e).cursor === 'pointer';
    } catch {
      return false;
    }
  };
  const near = (n, depth) => {
    const d = {
      tag: n.localName,
      depth
    };
    const role = roleOf(n);
    if (role) d.role = role;
    for (const [key, attr] of [['aria_label', 'aria-label'], ['title', 'title'], ['alt', 'alt']]) if (n.getAttribute(attr)) d[key] = flat(n.getAttribute(attr), 80);
    d.name = nameOf(n);
    d.text = textOf(n, 80);
    d.selector = selector(n);
    return d;
  };
  // The nearest meaningful element going up from the target (itself included): the first that is interactive (a link, a button, a form
  // field, an ARIA widget role, tabindex, onclick) or labelled (aria-label, aria-labelledby, title, alt, an SVG <title>). When the walk has
  // left a run of cursor:pointer elements that started at the target, the top of that run is closer to what was clicked. Else the first
  // element with a short visible text. At most 10 levels, never <body>.
  function nearest(e) {
    let run = null,
      inRun = pointer(e),
      short = null;
    for (let n = e, depth = 0; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && depth <= 10; n = n.parentElement, depth++) {
      const isPointer = inRun && pointer(n);
      if (!isPointer) inRun = false;
      if (n.matches(INTERACTIVE) || labelled(n)) return run && !isPointer ? near(...run) : near(n, depth);
      if (isPointer) run = [n, depth];
      if (!short) {
        const t = textOf(n, 81);
        if (t && t.length <= 80) short = [n, depth];
      }
    }
    return run ? near(...run) : short ? near(...short) : null;
  }
  const info = e => {
    const r = e.getBoundingClientRect();
    const d = {
      tag: e.localName,
      role: e.getAttribute('role') || '',
      name: e.getAttribute('aria-label') || e.name || '',
      text: textOf(e, 300),
      selector: selector(e),
      rect: {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height
      }
    };
    if (e.localName === 'input' && e.type) d.type = e.type;
    if (sensitive(e)) d.sensitive = true;
    const n = nearest(e);
    if (n) d.nearest = n;
    return d;
  };
  const send = (kind, data) => chrome.runtime.sendMessage({
    type: 'record.item',
    recording_id: recordingId,
    item: {
      seq: ++seq,
      at: Date.now(),
      kind,
      url: location.href,
      ...data
    }
  }).catch(() => {});
  // A tcli command is acting on the page (pageAction, or the debugger's input between background.js's agentWindow marks): its events are
  // recorded by background.js with source 'agent', so they are left out here.
  const agentActing = () => (globalThis.__tagentAgentBusy || 0) > 0 || Date.now() < (globalThis.__tagentAgentUntil || 0);
  for (const type of ['click', 'input', 'change', 'submit', 'keydown']) {
    const fn = event => {
      const e = event.target;
      if (!(e instanceof Element) || safe(e) || agentActing()) return;
      const source = {
        source: 'user',
        ...(event.isTrusted ? {} : {
          synthetic: true
        })
      };
      if (type === 'keydown') {
        if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.ctrlKey && !event.metaKey) return;
        send('key', {
          ...source,
          key: event.key,
          modifiers: ['Control', 'Meta', 'Shift', 'Alt'].filter((_, i) => [event.ctrlKey, event.metaKey, event.shiftKey, event.altKey][i])
        });
        return;
      }
      const data = {
        ...source,
        target: info(e)
      };
      if (type === 'click') data.button = ['left', 'middle', 'right'][event.button];
      if (type === 'input') data.value = secret.test(`${e.name} ${e.id} ${e.autocomplete}`) ? `<redacted:${String(e.value ?? '').length}>` : e.value ?? e.textContent;
      if (type === 'submit' || type === 'change') {
        data.fields = {};
        for (const f of e.elements || [e]) if (f.name && !safe(f)) data.fields[f.name] = secret.test(`${f.name} ${f.id} ${f.autocomplete}`) ? `<redacted:${String(f.value ?? '').length}>` : f.value;
      }
      send(type, data);
    };
    document.addEventListener(type, fn, true);
    listeners.push([type, fn]);
  }
  // What appeared, for the DOM change items: dialogs, alerts and live regions, toast-like notices, headings, buttons and links among the
  // added nodes, a dialog or notice that was shown (an attribute change), and text put into a live region or alert. At most PER_KIND
  // candidates of each kind and SCAN_BUDGET checked nodes per item; MAX_ENTRIES entries of MAX_TEXT characters each (the rest is counted in
  // `appeared_more`). The texts are redacted by background.js like every other item.
  const DIALOG = 'dialog,[role=dialog],[role=alertdialog]';
  const ALERT = '[role=alert],[role=status],[aria-live]:not([aria-live="off"]),output';
  const NOTICE = '[class*=toast i],[class*=snackbar i],[class*=notification i],[class*=notice i],[class*=message i],[class*=alert i],[class*=error i],[class*=modal i]';
  const KINDS = [['dialog', DIALOG], ['alert', ALERT], ['notice', NOTICE], ['heading', 'h1,h2,h3,h4,h5,h6,[role=heading]'], ['button', 'button,[role=button],input[type=button],input[type=submit]'], ['link', 'a[href],[role=link]']];
  const ANY = KINDS.map(k => k[1]).join(',');
  const SHOWN = `${DIALOG},${ALERT},${NOTICE}`;
  const MAX_ENTRIES = 20,
    MAX_TEXT = 120,
    PER_KIND = 20,
    SCAN_BUDGET = 3000;
  let found = new Map(),
    perKind = {},
    budget = SCAN_BUDGET;
  const shown = new WeakMap();
  const consider = n => {
    if (found.has(n) || budget <= 0) return;
    budget--;
    for (const [kind, sel] of KINDS) if (n.matches(sel)) {
      if ((perKind[kind] || 0) < PER_KIND) {
        found.set(n, kind);
        perKind[kind] = (perKind[kind] || 0) + 1;
      }
      return;
    }
  };
  const scan = n => {
    if (n.nodeType !== 1 || budget <= 0) return;
    consider(n);
    if (n.firstElementChild) for (const c of n.querySelectorAll(ANY)) {
      if (budget <= 0) break;
      consider(c);
    }
  };
  const visibleNow = n => {
    try {
      return n.checkVisibility ? n.checkVisibility() : !!n.getClientRects().length;
    } catch {
      return false;
    }
  };
  function appeared() {
    const out = [],
      keys = new Set();
    let more = 0;
    for (const [kind] of KINDS) for (const [n, k] of found) {
      if (k !== kind) continue;
      if (!n.isConnected || !visibleNow(n)) {
        shown.delete(n);
        continue;
      }
      const text = flat(n.getAttribute('aria-label') || labelledBy(n) || textOf(n, MAX_TEXT + 1) || n.getAttribute('title') || (n.localName === 'input' ? n.value : ''), MAX_TEXT);
      if (!text || shown.get(n) === text || keys.has(`${kind} ${text}`)) continue;
      shown.set(n, text);
      keys.add(`${kind} ${text}`);
      if (out.length >= MAX_ENTRIES) {
        more++;
        continue;
      }
      const role = n.getAttribute('role');
      out.push({
        type: kind,
        tag: n.localName,
        ...(role ? {
          role
        } : {}),
        text
      });
    }
    found = new Map();
    perKind = {};
    budget = SCAN_BUDGET;
    return {
      out,
      more
    };
  }
  // The overlay of shot --annotate is T-Agent's own, not the page's.
  const overlay = n => n?.nodeType === 1 && !!(n.hasAttribute?.('data-tagent-overlay') || n.closest?.('[data-tagent-overlay]'));
  const observer = options.dom === false ? null : new MutationObserver(records => {
    for (const r of records) {
      if (overlay(r.target) || r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].some(overlay)) continue;
      if (r.type === 'childList') {
        added += r.addedNodes.length;
        removed += r.removedNodes.length;
        for (const n of r.addedNodes) scan(n);
        const host = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        const live = host?.closest?.(`${ALERT},${DIALOG}`);
        if (live) consider(live);
      } else if (r.type === 'characterData') {
        const live = r.target.parentElement?.closest?.(ALERT);
        if (live) consider(live);
      } else if (r.type === 'attributes') {
        attrs++;
        if (r.target.matches?.(SHOWN)) consider(r.target);
      }
    }
  });
  // The document itself, not documentElement: at document start there may be no <html> element yet.
  observer?.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  });
  // What the document already shows when the recorder starts (on a fast page the HTML is parsed before it gets in): the first DOM item
  // lists it too, with `initial: true`.
  let initial = !!observer;
  if (observer && document.documentElement) scan(document.documentElement);
  const timer = setInterval(() => {
    if (location.href !== lastURL) {
      send('nav', {
        from: lastURL,
        to: location.href,
        transition: 'history'
      });
      lastURL = location.href;
      globalThis.__tagentPage?.refs.clear();
    }
    if (!observer) return;
    const { out, more } = appeared();
    if (added || removed || attrs || out.length) {
      send('dom', {
        summary: {
          added,
          removed,
          attrs
        },
        appeared: out,
        ...(more ? {
          appeared_more: more
        } : {}),
        ...(initial ? {
          initial: true
        } : {})
      });
      added = removed = attrs = 0;
      initial = false;
    }
  }, 500);
  globalThis.__tagentRecorder = {
    id: recordingId,
    info,
    stop() {
      observer?.disconnect();
      clearInterval(timer);
      for (const [t, f] of listeners) document.removeEventListener(t, f, true);
      delete globalThis.__tagentRecorder;
    }
  };
}
