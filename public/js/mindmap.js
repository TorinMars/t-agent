// Mind maps, used by the page (public/js/h5.js). This file is small and loaded with every page; the editor (mind-elixir and the view, source in scripts/mindmap/) is the
// bundle mindmap-ui.js, fetched when the view is first opened.
//
//   const view = MindMap.mount(element, { onClose, notify, onLayers, sources, embedded? });  returns { destroy(), flush(options), setSources(list), setActive(on) }
// `onLayers(closers)`: the back gesture's layers, innermost last (scripts/h5-shell/back.mjs).
// `sources`: the services whose maps are listed, in the order of the task list: [{ key, label, base, online }] (`base`: `/api/mindmaps` or
// `/api/remote-servers/:id/mindmaps`). An empty list: not known yet. `setSources` gives the view a new list when the services change.
// `embedded`: the Mind maps tab of the multi-column view. The element is placed by its parent (it fills it) instead of over the whole window, and the
// view shows the list of maps beside the open map (`split` in scripts/mindmap/app.js); `setActive(on)` says whether the tab is shown (its keys are
// taken only then).
const MindMap = (() => {
  // The bundle is asked for by the hash of its own content, which the page carries (window.TAAsset, put there by lib/static-assets.js), so it is
  // cached for a year like the page's other scripts. Without it (a page that was not served that way, as in most browser tests) the plain address is
  // used, which is revalidated each time.
  const BUNDLE_PATH = '/js/mindmap-ui.js';
  const assetUrl = path => (typeof window.TAAsset === 'function' ? window.TAAsset(path) : path);
  let bundle = null;
  function loadBundle() {
    if (typeof MindMapUI !== 'undefined') return Promise.resolve(MindMapUI);
    if (!bundle) {
      bundle = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = assetUrl(BUNDLE_PATH);
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
    let sources = options.sources; // the latest list, also when it changes before the bundle has loaded
    let active = options.embedded ? options.active !== false : true;
    const embedded = Boolean(options.embedded);
    const opener = embedded ? null : document.activeElement;
    // The element itself has only its position here: the styles of the view arrive with the bundle.
    container.style.cssText = embedded
      ? 'position:absolute;inset:0;background:#121212;color:#fff;'
      : 'position:fixed;left:0;right:0;z-index:1250;background:#121212;color:#fff;';
    container.textContent = tr('Loading...');
    if (!embedded) {
      container.setAttribute('role', 'dialog');
      container.setAttribute('aria-modal', 'true');
    }
    container.setAttribute('aria-label', tr('Mind maps'));
    loadBundle().then(ui => {
      if (disposed) return;
      container.textContent = '';
      view = ui.mount(container, { ...options, sources, split: embedded, active });
    }).catch(error => {
      if (disposed) return;
      if (options.notify) options.notify(tr(error.message), 'error');
      if (options.onClose) options.onClose();
    });
    return {
      flush(flushOptions) { return view ? view.flush(flushOptions) : Promise.resolve(); },
      setSources(list) { sources = list; if (view && view.setSources) view.setSources(list); },
      setActive(on) { active = Boolean(on); if (view && view.setActive) view.setActive(active); },
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
