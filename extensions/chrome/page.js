// This self-contained function executes in the isolated world, only on allowed tabs.
export async function pageAction(method, p) {
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
      return describe(e);
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
export function installRecorder(recordingId) {
  globalThis.__tagentRecorder?.stop();
  const listeners = [];
  let seq = 0,
    lastURL = location.href,
    added = 0,
    removed = 0,
    attrs = 0,
    landmarks = [];
  const secret = /(token|secret|session|passw|pwd|api[-_]?key|auth|signature|csrf|xsrf|cookie|ticket|code_verifier)/i;
  const safe = e => e.type === 'password';
  const selector = e => {
    if (e.id) return `#${CSS.escape(e.id)}`;
    for (const k of ['data-testid', 'data-test', 'aria-label', 'name']) if (e.getAttribute(k)) {
      const s = `${e.localName}[${k}=${JSON.stringify(e.getAttribute(k))}]`;
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const parts = [];
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      parts.unshift(`${n.localName}:nth-of-type(${[...(n.parentElement?.children || [n])].filter(x => x.localName === n.localName).indexOf(n) + 1})`);
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
    }
    return parts.join(' > ');
  };
  const info = e => {
    const r = e.getBoundingClientRect();
    return {
      tag: e.localName,
      role: e.getAttribute('role') || '',
      name: e.getAttribute('aria-label') || e.name || '',
      text: safe(e) ? '' : (e.innerText || '').slice(0, 300),
      selector: selector(e),
      rect: {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height
      }
    };
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
  for (const type of ['click', 'input', 'change', 'submit', 'keydown']) {
    const fn = event => {
      const e = event.target;
      if (!(e instanceof Element) || safe(e)) return;
      const target = info(e);
      if (type === 'keydown') {
        if (!['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.ctrlKey && !event.metaKey) return;
        send('key', {
          key: event.key,
          modifiers: ['Control', 'Meta', 'Shift', 'Alt'].filter((_, i) => [event.ctrlKey, event.metaKey, event.shiftKey, event.altKey][i])
        });
        return;
      }
      const data = {
        target
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
  const observer = new MutationObserver(records => {
    for (const r of records) {
      added += r.addedNodes.length;
      removed += r.removedNodes.length;
      if (r.type === 'attributes') attrs++;
      for (const n of r.addedNodes) if (n.nodeType === 1 && n.matches('dialog,form,ul,ol,[role="dialog"]')) landmarks.push(`${n.localName} ${(n.getAttribute('aria-label') || '').slice(0, 100)}`);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true
  });
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
    if (added || removed || attrs) {
      send('dom', {
        summary: {
          added,
          removed,
          attrs
        },
        landmarks: landmarks.slice(0, 20)
      });
      added = removed = attrs = 0;
      landmarks = [];
    }
  }, 500);
  globalThis.__tagentRecorder = {
    stop() {
      observer.disconnect();
      clearInterval(timer);
      for (const [t, f] of listeners) document.removeEventListener(t, f, true);
      delete globalThis.__tagentRecorder;
    }
  };
}
