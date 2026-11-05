// The back button of Android (and the back gesture, the browser's back) closes what is open on the page instead of leaving it: a sheet (task sheet on a
// phone, settings, the file sheet, the terminal menu), a dialog or a menu. Every open layer has one history entry of its own, pushed when it opens with
// the same address (so `?openChat=` and the Home Screen app's address stay as they are); a back press pops that entry and the page closes the top layer.
// A layer closed another way (its close button, a tap beside it, Escape) takes its entry back off with history.go, so the history never fills up.
//
// Layers are found in the page itself, so every sheet and dialog takes part without telling anyone: the open Material UI modals (each one is a
// `.MuiModal-root` straight under <body>; a kept-mounted closed one has `.MuiModal-hidden`), plus `extra()` for a layer that is not a modal (the file
// sheet beside the terminal on a wide screen). The top modal is closed the way Escape closes it (a modal that ignores Escape, the upload overlay, stays).
export function createBackLayers({ win = window, doc = document, extra = () => [], closeTimeoutMs = 600 } = {}) {
  const history = win.history;
  let depth = 0; // the entries this page pushed that are still on the history
  let goes = 0; // history.go calls whose popstate has not arrived yet
  const closing = new Set(); // modals asked to close by a back press; they still exist during their exit animation
  let scheduled = false;

  const isOpenModal = el => el.classList && el.classList.contains('MuiModal-root') && !el.classList.contains('MuiModal-hidden') && !closing.has(el);
  function layers() {
    for (const el of [...closing]) if (!el.isConnected || el.classList.contains('MuiModal-hidden')) closing.delete(el);
    const modals = [...doc.body.children].filter(isOpenModal).map(el => ({ el, close: () => closeModal(el) }));
    return [...(extra() || []), ...modals];
  }
  function closeModal(el) {
    closing.add(el);
    const KeyboardEventImpl = win.KeyboardEvent || win.Event;
    el.dispatchEvent(new KeyboardEventImpl('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    // A modal that does not close on Escape is a layer again (it gets a new entry, so the next back press does not leave the page).
    win.setTimeout(() => { if (closing.has(el) && el.isConnected && !el.classList.contains('MuiModal-hidden')) { closing.delete(el); sync(); } }, closeTimeoutMs);
  }

  function sync() {
    scheduled = false;
    if (goes) return; // wait for the pending history.go: pushing now would land on the wrong entry
    const open = layers().length;
    if (open > depth) {
      for (let i = depth; i < open; i += 1) history.pushState({ ...(history.state || {}), h5Layer: i + 1 }, '');
      depth = open;
    } else if (open < depth) {
      const back = depth - open;
      depth = open;
      goes += 1;
      history.go(-back);
    }
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    win.setTimeout(sync, 0);
  }

  function onPop() {
    if (goes) { goes -= 1; schedule(); return; } // our own history.go
    if (!depth) return; // not one of our entries: the page's normal history
    depth -= 1;
    const top = layers().at(-1);
    if (top) top.close();
    schedule();
  }
  win.addEventListener('popstate', onPop);

  // New modals appear as children of <body>; a kept-mounted one opens and closes by its class.
  const watched = new WeakSet();
  const classes = new win.MutationObserver(schedule);
  const children = new win.MutationObserver(() => {
    for (const el of doc.body.children) {
      if (!watched.has(el) && el.classList && el.classList.contains('MuiModal-root')) { watched.add(el); classes.observe(el, { attributes: true, attributeFilter: ['class'] }); }
    }
    schedule();
  });
  children.observe(doc.body, { childList: true });
  schedule();

  return {
    sync: schedule,
    get depth() { return depth; },
    dispose() { win.removeEventListener('popstate', onPop); children.disconnect(); classes.disconnect(); },
  };
}
