// Tap to translate (an option of the chat, kept on this device): with it on, a tap on an English word in a chat message shows what the word means, right
// beside the word. The meaning comes from the translation service of the Client (POST /api/translate/word, the service set up in the translation settings),
// told the sentence the word stands in so it can pick the meaning that fits. Only text of the chat is looked at: code, buttons, links, the input box and
// the tool cards are left alone. Everything the server sends is put in with textContent.
const WordTranslate = (() => {
  const KEY = 'word-translate';
  const AREA = '.agent-chat';
  // Where a tap is not a lookup: things that have an action of their own, code (identifiers are not words), tool output and the controls of the chat.
  const SKIP = 'a, button, input, textarea, select, summary, label, pre, code, kbd, [contenteditable], .ac-tool, .ac-msg-foot, .ac-composer, .ac-options, .ac-meta, .ac-commands, .wt-popup';
  const TAP_MOVE_PX = 8;
  const TAP_MS = 600; // a longer press is the person selecting text
  const SENTENCE_REACH = 200;
  const CACHE_SIZE = 300;
  const WORD_CHAR = /[A-Za-z'’-]/;
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);

  const listeners = new Set();
  let enabled = false;
  try { enabled = localStorage.getItem(KEY) === '1'; } catch { /* storage blocked: off */ }
  const cache = new Map(); // `${word}|${sentence}` -> entry, or the request that is under way
  let popup = null;
  let current = null; // the word the popup points at
  let shown = 0; // counts the lookups: an answer that comes after the person tapped something else is dropped
  let down = null;

  // The word under a point and the sentence around it: { word, sentence, range }, or null when the point is not on an English word.
  function wordAt(x, y) {
    let node = null;
    let offset = 0;
    try {
      if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(x, y);
        if (position) { node = position.offsetNode; offset = position.offset; }
      } else if (document.caretRangeFromPoint) {
        const caret = document.caretRangeFromPoint(x, y);
        if (caret) { node = caret.startContainer; offset = caret.startOffset; }
      }
    } catch { return null; }
    if (!node || node.nodeType !== 3) return null;
    const data = node.data;
    // The caret can sit on either side of the letter that was tapped.
    let at = offset;
    if (!(at < data.length && WORD_CHAR.test(data[at]))) at -= 1;
    if (at < 0 || at >= data.length || !WORD_CHAR.test(data[at])) return null;
    let start = at;
    let end = at + 1;
    while (start > 0 && WORD_CHAR.test(data[start - 1])) start -= 1;
    while (end < data.length && WORD_CHAR.test(data[end])) end += 1;
    // Apostrophes and hyphens belong to a word only inside it.
    while (start < end && /['’-]/.test(data[start])) start += 1;
    while (end > start && /['’-]/.test(data[end - 1])) end -= 1;
    const word = data.slice(start, end);
    if (!/^[A-Za-z]/.test(word) || word.length > 40) return null;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    // The tap must be on the word itself, not on the empty space that the caret snapped from.
    const inside = [...range.getClientRects()].some(rect => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2);
    if (!inside) return null;
    let from = start;
    let to = end;
    while (from > 0 && start - from < SENTENCE_REACH && !/[.!?\n]/.test(data[from - 1])) from -= 1;
    while (to < data.length && to - end < SENTENCE_REACH && !/[.!?\n]/.test(data[to])) to += 1;
    if (to < data.length && /[.!?]/.test(data[to])) to += 1;
    return { word, sentence: data.slice(from, to).replace(/\s+/g, ' ').trim(), range };
  }

  function lookup(word, sentence) {
    const key = `${word.toLowerCase()}|${sentence}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    const job = (async () => {
      const response = await fetch('/api/translate/word', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ word, context: sentence }) });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error */ }
      if (!response.ok) throw new Error((data && data.error) || text || `HTTP ${response.status}`);
      return data;
    })();
    return job.then(entry => {
      cache.set(key, entry);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      return entry;
    });
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function hide() {
    shown += 1;
    current = null;
    if (popup) { popup.remove(); popup = null; }
    if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('wt-word');
  }

  // Puts the popup beside the word: below it, or above when there is no room, and inside the window sideways.
  function place(range) {
    if (!popup) return;
    const rect = range.getBoundingClientRect();
    // The word is gone (the message was drawn again) or has scrolled out of the window: nothing to point at.
    if (range.collapsed || (!rect.width && !rect.height) || rect.bottom < 0 || rect.top > window.innerHeight) { hide(); return; }
    const box = popup.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + margin;
    if (top + box.height > window.innerHeight - margin && rect.top - margin - box.height >= margin) top = rect.top - margin - box.height;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - box.width - margin));
    popup.style.top = `${Math.max(margin, top)}px`;
    popup.style.left = `${left}px`;
  }

  function render(hit, state) {
    if (!popup) {
      popup = el('div', 'wt-popup');
      popup.setAttribute('role', 'status');
      popup.setAttribute('aria-live', 'polite');
      document.body.append(popup);
    }
    current = hit;
    popup.replaceChildren();
    const head = el('div', 'wt-head');
    head.append(el('strong', 'wt-word', hit.word));
    if (state.entry) {
      if (state.entry.phonetic) head.append(el('span', 'wt-phonetic', state.entry.phonetic));
      if (state.entry.pos) head.append(el('span', 'wt-pos', state.entry.pos));
    }
    popup.append(head);
    if (state.entry) {
      popup.append(el('div', 'wt-meaning', state.entry.meaning));
      if (state.entry.base && state.entry.base.toLowerCase() !== hit.word.toLowerCase()) popup.append(el('div', 'wt-base', `${tr('Base form')}: ${state.entry.base}`));
    } else if (state.error) popup.append(el('div', 'wt-error', tr(state.error)));
    else popup.append(el('div', 'wt-loading', tr('Looking up…')));
    place(hit.range);
  }

  function show(hit) {
    const mine = ++shown;
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') CSS.highlights.set('wt-word', new Highlight(hit.range));
    const key = `${hit.word.toLowerCase()}|${hit.sentence}`;
    if (cache.has(key)) { render(hit, { entry: cache.get(key) }); return; } // nothing to wait for
    render(hit, {});
    lookup(hit.word, hit.sentence).then(
      entry => { if (mine === shown) render(hit, { entry }); },
      error => { if (mine === shown) render(hit, { error: error.message || 'Could not translate the word' }); },
    );
  }

  // A tap is a press and a release that stay in place and are short; a drag or a long press selects text or scrolls and is left alone.
  function onDown(event) {
    if (!enabled) return;
    if (popup && !event.target.closest('.wt-popup')) hide();
    down = event.isPrimary && (event.pointerType !== 'mouse' || event.button === 0) ? { x: event.clientX, y: event.clientY, at: Date.now() } : null;
  }
  function onUp(event) {
    const start = down;
    down = null;
    if (!enabled || !start || !(event.target instanceof Element)) return;
    if (Date.now() - start.at > TAP_MS || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_MOVE_PX) return;
    if (!event.target.closest(AREA) || event.target.closest(SKIP)) return;
    const selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return; // the person is selecting
    const hit = wordAt(event.clientX, event.clientY);
    if (hit) show(hit);
  }

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', () => { down = null; }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && popup) hide(); });
  document.addEventListener('scroll', () => { if (popup && current) place(current.range); }, true); // follows the word while the chat scrolls (it does by itself while the agent writes)
  window.addEventListener('resize', () => { if (popup) hide(); });
  const mark = () => document.body && document.body.classList.toggle('wt-on', enabled);
  if (document.body) mark(); else document.addEventListener('DOMContentLoaded', mark);

  function setEnabled(on) {
    enabled = Boolean(on);
    try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch { /* storage blocked: kept until the page closes */ }
    hide();
    mark();
    for (const listener of listeners) listener(enabled);
  }

  return { get enabled() { return enabled; }, setEnabled, onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }, hide, wordAt };
})();
if (typeof window !== 'undefined') window.WordTranslate = WordTranslate;
