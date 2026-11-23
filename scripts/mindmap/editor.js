// One open map: the mind-elixir instance, the keyboard shortcuts and the actions shared by the keys and the bottom bar.
import MindElixir from 'mind-elixir';
import { actionFor } from './keys.mjs';
import { pickDirectional } from './nav.mjs';
import { attachTouch } from './touch.js';
import { RIGHT_ONLY, escapeHtml, plainDoc, safeLink, sanitizeDoc } from './doc.mjs';
import { CLIPBOARD_TYPE, clipboardPayload, topicsFromClipboard } from './clipboard.mjs';

const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const TEXT_FIELD = 'input, textarea, select, [contenteditable]';
const parseHtml = text => new DOMParser().parseFromString(text, 'text/html'); // an inert document: no script runs and nothing is loaded

// Dark colours of the app (Material UI dark palette, as in h5.css).
const THEME = {
  name: 'tagent-dark',
  type: 'dark',
  palette: ['#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#e57373', '#f06292', '#aed581'],
  cssVar: {
    '--node-gap-x': '30px', '--node-gap-y': '10px', '--main-gap-x': '65px', '--main-gap-y': '26px',
    '--root-radius': '14px', '--main-radius': '10px', '--topic-padding': '4px 8px',
    '--root-color': '#fff', '--root-bgcolor': '#1976d2', '--root-border-color': 'transparent',
    '--main-color': '#fff', '--main-bgcolor': '#2c2c2c', '--main-bgcolor-transparent': 'rgba(44, 44, 44, .8)',
    '--color': 'rgba(255, 255, 255, .87)', '--bgcolor': '#121212', '--selected': '#90caf9', '--accent-color': '#90caf9',
    '--panel-color': '#fff', '--panel-bgcolor': '#1e1e1e', '--panel-border-color': 'rgba(255, 255, 255, .12)',
    '--map-padding': matchMedia('(pointer: coarse)').matches ? '20px 16px' : '50px 80px', // on a phone the padding would only shrink the fitted map
  },
};

export async function createEditor(host, doc, handlers) {
  const mind = new MindElixir({
    el: host, direction: RIGHT_ONLY, toolBar: false, contextMenu: false, keypress: true, allowUndo: true, theme: THEME, alignment: 'nodes',
    newTopicName: handlers.t('New topic'), scaleMin: 0.2, scaleMax: 3,
    // A drag with the left button on empty canvas selects the topics it covers (the user's choice, 2026-11-20); the map moves with a scroll or two
    // fingers on a trackpad, Space and a drag, or a drag with the right button (the library pans with the other button). "Mouse" in docs/design/mind-maps.md.
    mouseSelectionButton: 0,
    markdown: text => escapeHtml(text), // every text the library would draw as HTML goes through this
  });
  await mind.init({ nodeData: doc.nodeData, arrows: doc.arrows, summaries: doc.summaries, direction: RIGHT_ONLY, theme: THEME });
  if (!mind.container) throw new Error('The editor could not start');
  // The selection rectangle in the theme's primary colour (the library draws it in its own blue).
  const area = mind.selection && mind.selection.getSelectionArea && mind.selection.getSelectionArea();
  if (area) Object.assign(area.style, { background: 'rgba(144, 202, 249, 0.16)', border: '1px solid #90caf9', borderRadius: '4px' });
  mind.container.onkeydown = null; // the shortcuts are handled below; the library's own handler also blocks keys such as reload
  // The library's scaleFit leaves the map off-centre when it scales down (its transform origin is the canvas, not the nodes), so the centre is put right from what is on the screen.
  function fitMap() {
    mind.scaleFit();
    const c = mind.container.getBoundingClientRect();
    const n = mind.nodes.getBoundingClientRect();
    mind.move((c.left + c.right) / 2 - (n.left + n.right) / 2, (c.top + c.bottom) / 2 - (n.top + n.bottom) / 2);
  }
  fitMap();
  // The root is at the left end of the map, so centring a map wider than the canvas would push it off the screen: such a map starts at the left edge instead.
  function actualSize() {
    mind.scale(1);
    mind.toCenter();
    const c = mind.container.getBoundingClientRect();
    const n = mind.nodes.getBoundingClientRect();
    if (n.width > c.width) mind.move(c.left - n.left, 0);
  }

  let disposed = false;
  const changed = () => { if (!disposed) handlers.onChange(); };
  const selection = () => mind.currentNodes || [];
  const current = () => selection().at(-1) || null;
  const editBox = () => mind.nodes.querySelector('#input-box');
  const isEditing = () => Boolean(editBox());
  const select = tpc => { if (tpc) mind.selectNode(tpc); };
  const root = () => mind.findEle(mind.nodeData.id);
  function ensure() { if (!current()) select(root()); return current(); }
  const finishEdit = () => { const box = editBox(); if (box) box.blur(); };

  // A topic opened for editing is the only place the on-screen keyboard is asked for; this call is synchronous, inside the tap or click that asked for it.
  function editTopic(tpc, { typed = false } = {}) {
    if (!tpc) return;
    finishEdit();
    if (!selection().includes(tpc)) select(tpc);
    mind.editTopic(tpc);
    const box = editBox();
    if (!box) return;
    box.setAttribute('translate', 'no');
    box.focus();
    if (typed) box.textContent = '';
  }

  const actions = {
    addChild() { finishEdit(); ensure(); mind.addChild(); },
    addSibling() { finishEdit(); ensure(); mind.insertSibling('after'); },
    addBefore() { finishEdit(); ensure(); mind.insertSibling('before'); },
    addParent() { finishEdit(); const tpc = ensure(); if (tpc.nodeObj.parent) mind.insertParent(); },
    edit() { editTopic(ensure()); },
    remove() {
      finishEdit();
      const list = selection().filter(tpc => tpc.nodeObj.parent);
      if (list.length) mind.removeNodes(list);
    },
    toggleFold() {
      const tpc = ensure();
      if (tpc.nodeObj.parent && tpc.nodeObj.children && tpc.nodeObj.children.length) mind.expandNode(tpc); // the central topic has no fold
    },
    undo() { finishEdit(); mind.undo(); changed(); mind.container.focus({ preventScroll: true }); },
    redo() { finishEdit(); mind.redo(); changed(); mind.container.focus({ preventScroll: true }); },
    fit() { fitMap(); },
    zoomIn() { mind.scale(mind.scaleVal * 1.2); },
    zoomOut() { mind.scale(mind.scaleVal / 1.2); },
    zoomReset() { actualSize(); },
    goRoot() { select(root()); },
    goParent() { const tpc = current(); if (tpc && tpc.nodeObj.parent) select(mind.findEle(tpc.nodeObj.parent.id)); },
    selectAll() { mind.selectNodes([...mind.nodes.querySelectorAll('.me-tpc')]); },
    selectSiblings() { const tpc = current(); if (tpc && tpc.nodeObj.parent) mind.selectNodes(tpc.nodeObj.parent.children.map(node => mind.findEle(node.id))); },
    selectChildren() {
      const tpc = current();
      const children = tpc && tpc.nodeObj.expanded !== false ? tpc.nodeObj.children || [] : [];
      if (children.length) { mind.clearSelection(); mind.selectNodes(children.map(node => mind.findEle(node.id))); }
    },
    moveUp() { mind.moveUpNode(); },
    moveDown() { mind.moveDownNode(); },
    summary() { if (selection().length) mind.createSummary(); },
    relationship() { const [a, b] = selection().slice(-2); if (a && b && a !== b) mind.createArrow(a, b); },
    up() { move('up'); }, down() { move('down'); }, left() { move('left'); }, right() { move('right'); },
    type() { editTopic(ensure(), { typed: true }); },
    saveNow() { handlers.onSaveNow(); },
    note() { handlers.onOpenInfo('note'); },
    label() { handlers.onOpenInfo('label'); },
    link() { handlers.onOpenInfo('link'); },
    back() { handlers.onBack(); },
    // The More menu (no clipboard event): the topics are kept here for Paste topic, and the other forms go to the system clipboard where the
    // browser allows it, so they can be pasted into another app.
    copyTopics() {
      const list = selection();
      if (!list.length) return;
      buffer = copiedNodes();
      void writeSystemClipboard(buffer);
    },
    cutTopics() { actions.copyTopics(); actions.remove(); },
    pasteTopics() { void pasteFromMenu(); },
  };
  let buffer = null;
  const copiedNodes = () => selection().map(tpc => JSON.parse(mind.stringifyData(tpc.nodeObj)));

  async function writeSystemClipboard(nodes) {
    const payload = clipboardPayload(nodes);
    const clip = navigator.clipboard;
    try {
      if (clip && clip.write && typeof ClipboardItem !== 'undefined') {
        await clip.write([new ClipboardItem({ 'text/plain': new Blob([payload['text/plain']], { type: 'text/plain' }), 'text/html': new Blob([payload['text/html']], { type: 'text/html' }) })]);
      } else if (clip && clip.writeText) await clip.writeText(payload['text/plain']);
    } catch { /* not allowed here: Paste topic still has the copy */ }
  }
  // Paste topic of the More menu: what the system clipboard holds when the browser lets the page read it, the exact copy when that is what is there
  // (or when the clipboard cannot be read).
  async function pasteFromMenu() {
    const read = await readSystemClipboard();
    if (read && buffer && read.text.trim() === clipboardPayload(buffer)['text/plain'].trim()) { pasteNodes(buffer); return; }
    if (read && pasteFound(read)) return;
    if (buffer && buffer.length) pasteNodes(buffer);
  }

  function move(dir) {
    const tpc = current();
    if (!tpc) { select(root()); return; }
    const node = tpc.nodeObj;
    // The tree grows to the right: Left is the parent and Right one of the children, even when a topic of another branch is nearer on the screen.
    if (dir === 'left') { if (node.parent) select(mind.findEle(node.parent.id)); return; }
    const children = dir === 'right' ? new Set((node.expanded === false ? [] : node.children || []).map(child => child.id)) : null;
    const rects = [...mind.nodes.querySelectorAll('.me-tpc')].filter(el => !children || el === tpc || children.has(el.nodeObj.id)).map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.nodeObj.id, el, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    const id = pickDirectional(rects, node.id, dir);
    if (id) select(mind.findEle(id));
  }

  function pasteNodes(nodes) {
    const target = ensure();
    const clean = nodes.map(node => sanitizeDoc({ nodeData: node }).nodeData);
    mind.copyNodes(clean.map(nodeObj => ({ nodeObj })), target);
    return target;
  }
  // `forms`: { custom, html, text } read from the clipboard. Returns whether something was pasted (or refused with a message).
  function pasteFound(forms) {
    let found;
    try { found = topicsFromClipboard(forms, { parseHtml }); } catch (error) { handlers.notify(handlers.t(error.message || 'These topics cannot be pasted')); return true; }
    if (!found) return false;
    let target;
    try { target = pasteNodes(found.nodes); } catch { handlers.notify(handlers.t('These topics cannot be pasted')); return true; }
    // Topics from another app become a branch: say where it went (a copy inside T-Agent pastes as it was, without a message).
    if (!found.exact && handlers.info) {
      const name = String(target && target.nodeObj ? target.nodeObj.topic : '').slice(0, 40);
      handlers.info(handlers.t(found.topics === 1 ? `Pasted 1 topic under \u201c${name}\u201d` : `Pasted ${found.topics} topics under \u201c${name}\u201d`));
    }
    return true;
  }

  // Keys. The listener is on the document, in the capture phase, so that nothing under the view (the terminal) sees them. `handlers.owns(event)`
  // false: the key is not the map's (the Mind maps tab is hidden, or the key is on another part of the page, such as the navigation rail).
  const ownsEvent = event => !handlers.owns || handlers.owns(event);
  function onKeydown(event) {
    if (disposed || handlers.isBlocked() || !ownsEvent(event)) return;
    const target = event.target;
    const box = editBox();
    if (box && (target === box || box.contains(target))) {
      // The library commits on Enter unless event.isComposing; Safari reports the Enter that ends a composition with keyCode 229 and isComposing false.
      if (event.isComposing || event.keyCode === 229) event.stopPropagation();
      return;
    }
    if (target.closest && target.closest('.MuiModal-root')) return;
    if (target.matches && target.matches(TEXT_FIELD) && !target.closest('.xterm')) return;
    if (target.closest && target.closest('button, a') && (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ')) return; // a focused button keeps its own keys
    const action = actionFor(event, APPLE);
    if (!action) return;
    // A character goes on to the topic editor that it opens; everything else is ours alone.
    if (action === 'type') {
      event.stopPropagation();
      if (!document.activeElement || !document.activeElement.closest('.mm-canvas')) mind.container.focus({ preventScroll: true });
      actions.type();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (target.closest && target.closest('.xterm')) mind.container.focus({ preventScroll: true });
    // Space held with a drag moves the map; Space pressed and let go without a drag edits the selected topic, on its release ("Mouse" in
    // docs/design/mind-maps.md). The library's own Space flag is set here, because this handler keeps the key from reaching it.
    if (action === 'edit' && event.key === ' ') {
      if (!space.held) { space.held = true; space.panned = false; mind.spacePressed = true; mind.container.classList.add('space-pressed'); }
      return;
    }
    actions[action]();
  }
  const space = { held: false, panned: false };
  function releaseSpace(edit) {
    if (!space.held) return;
    space.held = false;
    mind.spacePressed = false;
    mind.container.classList.remove('space-pressed');
    if (edit && !space.panned && !disposed && !handlers.isBlocked()) actions.edit();
  }
  function onKeyup(event) { if (event.key === ' ' && space.held) { event.preventDefault(); event.stopPropagation(); releaseSpace(true); } }
  function onSpacePointer(event) { if (space.held && event.button === 0) space.panned = true; }
  function onWindowBlur() { releaseSpace(false); }

  async function readSystemClipboard() {
    const clip = navigator.clipboard;
    try {
      if (clip && clip.read) {
        const forms = { custom: '', html: '', text: '' };
        for (const item of await clip.read()) {
          if (!forms.html && item.types.includes('text/html')) forms.html = await (await item.getType('text/html')).text();
          if (!forms.text && item.types.includes('text/plain')) forms.text = await (await item.getType('text/plain')).text();
        }
        return forms;
      }
      if (clip && clip.readText) return { custom: '', html: '', text: await clip.readText() };
    } catch { /* not allowed, or nothing there */ }
    return null;
  }

  const isTextTarget = event => {
    const t2 = event.target;
    return (t2 && t2.matches && t2.matches(TEXT_FIELD)) || isEditing();
  };
  function onCopy(event) {
    if (disposed || handlers.isBlocked() || !ownsEvent(event) || isTextTarget(event) || !selection().length || !event.clipboardData) return;
    for (const [type, value] of Object.entries(clipboardPayload(copiedNodes()))) {
      try { event.clipboardData.setData(type, value); } catch { /* a browser that refuses our own type still gets text and HTML */ }
    }
    event.preventDefault();
    event.stopPropagation();
    actions.copyTopics();
    if (event.type === 'cut') actions.remove();
  }
  function onPaste(event) {
    if (disposed || handlers.isBlocked() || !ownsEvent(event) || isTextTarget(event) || !event.clipboardData) return;
    const data = event.clipboardData;
    const get = type => { try { return data.getData(type) || ''; } catch { return ''; } };
    const forms = { custom: get(CLIPBOARD_TYPE), html: get('text/html'), text: get('text/plain') };
    if (!forms.custom && !forms.html && !forms.text.trim()) return;
    event.preventDefault();
    event.stopPropagation();
    pasteFound(forms);
  }

  const onOperation = op => { if (op.name !== 'beginEdit') changed(); };
  mind.bus.addListener('operation', onOperation);
  const onSelection = () => { queueMicrotask(() => { if (!disposed) handlers.onSelection(); }); };
  for (const name of ['selectNodes', 'selectNewNode', 'unselectNodes']) mind.bus.addListener(name, onSelection);
  const unhistory = mind.historyStack ? mind.historyStack.subscribe(() => { if (!disposed) handlers.onSelection(); }) : () => {};

  // A small mark on topics with a note; the note itself is opened with the Note action.
  const markNotes = () => {
    for (const el of mind.nodes.querySelectorAll('.me-tpc')) {
      if (el.nodeObj && el.nodeObj.note) { el.dataset.note = '1'; el.title = el.nodeObj.note; }
      else if (el.dataset.note) { delete el.dataset.note; el.removeAttribute('title'); }
    }
  };
  mind.bus.addListener('linkDiv', markNotes);
  markNotes();

  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('keyup', onKeyup, true);
  document.addEventListener('pointerdown', onSpacePointer, true);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('copy', onCopy, true);
  document.addEventListener('cut', onCopy, true);
  document.addEventListener('paste', onPaste, true);
  const detachTouch = attachTouch(mind, { editing: isEditing, finishEdit, requestEdit: tpc => editTopic(tpc), onDragEnd: () => handlers.onSelection() });

  // The on-screen keyboard shrinks the canvas: the topic being edited stays in view.
  const observer = new ResizeObserver(() => {
    const box = editBox();
    if (box && current()) mind.scrollIntoView(current());
  });
  observer.observe(host);

  mind.container.focus({ preventScroll: true });

  return {
    mind,
    actions,
    isEditing,
    finishEdit,
    focus() { mind.container.focus({ preventScroll: true }); },
    getDoc() { return plainDoc(JSON.parse(mind.getDataString())); },
    selected: current,
    canUndo: () => Boolean(mind.historyStack && mind.historyStack.canUndo),
    canRedo: () => Boolean(mind.historyStack && mind.historyStack.canRedo),
    // Sets note, labels or link of the selected topic through the library, so it can be undone.
    async setInfo(tpc, patch) {
      const clean = { ...patch };
      if ('hyperLink' in clean) clean.hyperLink = safeLink(clean.hyperLink);
      await mind.reshapeNode(tpc, clean);
    },
    destroy() {
      disposed = true;
      observer.disconnect();
      detachTouch();
      unhistory();
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('keyup', onKeyup, true);
      document.removeEventListener('pointerdown', onSpacePointer, true);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('copy', onCopy, true);
      document.removeEventListener('cut', onCopy, true);
      document.removeEventListener('paste', onPaste, true);
      mind.bus.removeListener('operation', onOperation);
      try { mind.destroy(); } catch { /* the view is going away */ }
      host.innerHTML = '';
    },
  };
}
