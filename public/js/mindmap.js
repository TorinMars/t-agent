// Mind maps, used by the page (public/js/h5.js). This file is small and loaded with every page; the editor (mind-elixir and the view, source in scripts/mindmap/) is the
// bundle mindmap-ui.js, fetched when the view is first opened.
//
//   const view = MindMap.mount(element, { onClose, notify, onLayers });  returns { destroy(), flush() }
// `onLayers(closers)`: the back gesture's layers, innermost last (scripts/h5-shell/back.mjs).
const MindMap = (() => {
  // The bundle sits next to this script (same ?v= release query, so it is cached like the other scripts).
  const BUNDLE_URL = (() => {
    const script = document.currentScript;
    return script && script.src ? script.src.replace(/mindmap\.js/, 'mindmap-ui.js') : '/js/mindmap-ui.js';
  })();
  let bundle = null;
  function loadBundle() {
    if (typeof MindMapUI !== 'undefined') return Promise.resolve(MindMapUI);
    if (!bundle) {
      bundle = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = BUNDLE_URL;
        script.onload = () => resolve(MindMapUI);
        script.onerror = () => { bundle = null; reject(new Error('The mind map view could not be loaded')); };
        document.head.append(script);
      });
    }
    return bundle;
  }
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);

  // Returns at once; the view appears when the bundle has loaded. destroy() works before that too.
  function mount(container, options) {
    let view = null;
    let disposed = false;
    const opener = document.activeElement;
    // The element itself has only its position here: the styles of the view arrive with the bundle.
    container.style.cssText = 'position:fixed;left:0;right:0;z-index:1250;background:#121212;color:#fff;';
    container.textContent = tr('Loading...');
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', 'true');
    container.setAttribute('aria-label', tr('Mind maps'));
    loadBundle().then(ui => {
      if (disposed) return;
      container.textContent = '';
      view = ui.mount(container, options);
    }).catch(error => {
      if (disposed) return;
      if (options.notify) options.notify(tr(error.message), 'error');
      if (options.onClose) options.onClose();
    });
    return {
      flush() { return view ? view.flush() : Promise.resolve(); },
      destroy() {
        disposed = true;
        if (view) view.destroy();
        view = null;
        container.textContent = '';
        if (opener && opener.focus && opener.isConnected) opener.focus();
      },
    };
  }
  return { mount };
})();
