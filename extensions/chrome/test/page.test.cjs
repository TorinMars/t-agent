const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
test('isolated page actions: refs, controlled inputs, targets and passwords', async t => {
  const globals = ['document', 'location', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'CSS', 'getComputedStyle', 'HTMLInputElement', 'HTMLTextAreaElement', 'MouseEvent', 'KeyboardEvent', 'InputEvent', '__tagentPage'];
  const saved = new Map(globals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  t.after(() => {
    for (const [k, d] of saved) if (d) Object.defineProperty(globalThis, k, d);else delete globalThis[k];
  });
  class Input {
    constructor(id, type = 'text', value = '') {
      this.id = id;
      this.name = id;
      this.type = type;
      this._value = value;
      this.localName = 'input';
      this.isConnected = true;
      this.nodeType = 1;
      this.innerText = '';
      this.childNodes = [];
      this.children = [];
      this.events = [];
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
    get value() {
      return this._value;
    }
    set value(v) {
      this._value = v;
      this.nativeWrites = (this.nativeWrites || 0) + 1;
    }
    getAttribute(k) {
      return {
        id: this.id,
        name: this.name,
        type: this.type
      }[k] || null;
    }
    getBoundingClientRect() {
      return {
        x: 10,
        y: 20,
        width: 120,
        height: 30,
        bottom: 50,
        right: 130,
        top: 20,
        left: 10
      };
    }
    getClientRects() {
      return [{}];
    }
    scrollIntoView() {
      this.scrolled = true;
    }
    focus() {
      document.activeElement = this;
    }
    dispatchEvent(e) {
      this.events.push(e);
      if (e.type === 'input') this.controlled = this.value;
      return true;
    }
    matches() {
      return true;
    }
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
    select() {
      this.setSelectionRange(0, this.value.length);
    }
  }
  class TextArea extends Input {}
  class BrowserEvent {
    constructor(type, opts) {
      this.type = type;
      Object.assign(this, opts);
    }
  }
  const input = new Input('name'),
    password = new Input('password', 'password', 'private-password'),
    secret = new Input('csrf', 'text', 'private-csrf');
  const nodes = [input, password, secret];
  Object.assign(globalThis, {
    HTMLInputElement: Input,
    HTMLTextAreaElement: TextArea,
    MouseEvent: BrowserEvent,
    KeyboardEvent: BrowserEvent,
    InputEvent: BrowserEvent,
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    CSS: {
      escape: s => s
    },
    getComputedStyle: () => ({
      visibility: 'visible',
      display: 'block'
    }),
    location: {
      href: 'http://localhost/form'
    },
    document: {
      title: 'Form',
      activeElement: input,
      querySelector: s => nodes.find(n => `#${n.id}` === s) || null,
      querySelectorAll: s => s === '*' ? nodes : s.startsWith('#') ? nodes.filter(n => `#${n.id}` === s) : nodes,
      elementFromPoint: () => input
    }
  });
  const {
    pageAction
  } = await import('../page.js');
  const run = async (method, p = {}) => {
    const r = await pageAction(method, p);
    assert(r.ok, r.error);
    return r.result;
  };
  await t.test('snapshots omit passwords and redact sensitive field values', async () => {
    const s = await run('page.snapshot');
    assert.equal(s.elements.length, 3);
    assert(!JSON.stringify(s).includes('private-password'));
    assert(!JSON.stringify(s).includes('private-csrf'));
    assert.equal(s.elements[2].value, '<redacted:12>');
    assert.equal(s.elements[0].selector, '#name');
    const ref = s.elements[0].ref;
    await run('input.type', {
      target: {
        ref
      },
      text: 'hello',
      clear: true
    });
    assert.equal(input.controlled, 'hello');
    assert(input.nativeWrites > 0);
    assert(input.events.some(e => e.type === 'change'));
  });
  await t.test('keyboard fallback updates native values and click has real coordinates', async () => {
    await run('input.press', {
      key: 'a',
      modifiers: ['Control']
    });
    await run('input.press', {
      key: 'x'
    });
    assert.equal(input.controlled, 'x');
    await run('input.click', {
      target: {
        selector: '#name'
      }
    });
    const click = input.events.find(e => e.type === 'click');
    assert.equal(click.clientX, 70);
    assert.equal(click.clientY, 35);
    input.readOnly = true;
    assert.equal((await pageAction('input.type', {
      target: {
        selector: '#name'
      },
      text: 'bad'
    })).ok, false);
    input.readOnly = false;
  });
  await t.test('stale refs and missing targets return explicit errors', async () => {
    await run('invalidate');
    assert.match((await pageAction('input.click', {
      target: {
        ref: 'e1'
      }
    })).error, /REF_NOT_FOUND/);
    assert.match((await pageAction('input.click', {
      target: {
        selector: '#missing'
      }
    })).error, /ELEMENT_NOT_FOUND/);
  });
});
