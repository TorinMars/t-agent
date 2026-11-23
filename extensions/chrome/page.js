// This self-contained function executes in the isolated world, only on allowed tabs.
export async function pageAction(method, p) {
  // The events an input command dispatches here are the command's own: a running page recorder (installRecorder) leaves them out, because
  // background.js records the command once, with source 'agent'.
  const acting = typeof method === 'string' && method.startsWith('input.');
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
    const state = globalThis.__tagentPage ||= {
      refs: new Map(),
      next: 1
    };
    const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none');
    const selector = e => {
      if (e.id) return `#${CSS.escape(e.id)}`;
      for (const k of ['data-testid', 'data-test', 'aria-label', 'name']) if (e.getAttribute(k)) {
        const s = `${e.localName}[${k}=${JSON.stringify(e.getAttribute(k))}]`;
        if (document.querySelectorAll(s).length === 1) return s;
      }
      const path = [];
      for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
        path.unshift(`${n.localName}:nth-of-type(${[...(n.parentElement?.children || [n])].filter(x => x.localName === n.localName).indexOf(n) + 1})`);
        if (document.querySelectorAll(path.join(' > ')).length === 1) break;
      }
      return path.join(' > ');
    };
    const secret = e => /(token|secret|session|passw|pwd|api[-_]?key|auth|signature|csrf|xsrf|cookie|ticket|code_verifier)/i.test(`${e.name || ''} ${e.id || ''} ${e.autocomplete || ''}`);
    const safeValue = e => secret(e) ? `<redacted:${String(e.value ?? '').length}>` : e.value;
    const describe = e => {
      let ref = [...state.refs].find(([, v]) => v === e)?.[0];
      if (!ref) {
        ref = `e${state.next++}`;
        state.refs.set(ref, e);
      }
      const r = e.getBoundingClientRect();
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
        rect: {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height
        },
        in_viewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
      };
      if ('value' in e && e.type !== 'password') d.value = safeValue(e);
      for (const k of ['href', 'type', 'checked', 'disabled']) if (k in e) d[k] = e[k];
      return d;
    };
    const target = t => {
      let e;
      if (t?.ref) {
        e = state.refs.get(t.ref);
        if (!e?.isConnected) fail('REF_NOT_FOUND', 'Unknown or stale ref');
      } else if (t?.selector) e = document.querySelector(t.selector);else if (t?.text) e = [...document.querySelectorAll('body *')].filter(visible).find(n => (n.innerText || '').trim() === t.text && ![...n.children].some(c => (c.innerText || '').trim() === t.text));else if (Number.isFinite(t?.x) && Number.isFinite(t?.y)) e = document.elementFromPoint(t.x, t.y);
      if (!e) fail('ELEMENT_NOT_FOUND', 'No matching element');
      if (!visible(e) || e.disabled) fail('ELEMENT_NOT_INTERACTABLE', 'Element is hidden or disabled');
      e.scrollIntoView({
        block: 'center',
        inline: 'nearest'
      });
      return e;
    };
    if (method === 'viewport') return {
      width: innerWidth,
      height: innerHeight,
      device_scale_factor: devicePixelRatio
    };
    if (method === 'invalidate') {
      state.refs.clear();
      state.next = 1;
      return;
    }
    if (method === 'page.snapshot' || method === 'page.query') {
      if (method === 'page.snapshot') {
        state.refs.clear();
        state.next = 1;
      }
      const root = p.selector && method === 'page.snapshot' ? document.querySelector(p.selector) : document;
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
      const nodes = method === 'page.query' ? [...document.querySelectorAll(p.selector)].slice(0, p.all ? Math.min(p.limit ?? 50, 1000) : 1) : [...root.querySelectorAll('*')].filter(e => e.matches('a,button,input,textarea,select,[role],main,nav,header,footer,section,article,h1,h2,h3,p,li,label,summary,dialog,form,[contenteditable]') || [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
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
      return method === 'page.query' ? {
        elements
      } : {
        ...base,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          device_scale_factor: devicePixelRatio
        },
        elements,
        truncated
      };
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
      const e = document.activeElement;
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
          const setter = Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
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
      r = e.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: p.target?.x ?? r.x + r.width / 2,
      clientY: p.target?.y ?? r.y + r.height / 2,
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
        const setter = Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
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
  const observer = options.dom === false ? null : new MutationObserver(records => {
    for (const r of records) {
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
