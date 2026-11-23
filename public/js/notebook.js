// Shell notebooks, used by the page (public/js/h5.js) for a session whose row has agent 'notebook'. This file is small and loaded with every page; the
// view itself (source in scripts/notebook/) is the bundle notebook-ui.js (global NotebookUI), fetched the first time a notebook is opened.
//
//   const view = Notebook.mount(element, { api, base, notebookId, title, notify, onTitle, embedded, ... });  returns { destroy(), flush(), setActive(on), action(name) }
// `api`: { get(url), post(url, body) } returning the parsed JSON (throws an Error whose `message` is the error code and `status` the HTTP status).
// `base`: `<tasks base>/<task id>/notebooks/<terminal id>`. See "Mount" in docs/design/shell-notebook-page.md for the other options.
const Notebook = (() => {
  // The bundle is asked for by the hash of its own content, which the page carries (window.TAAsset, put there by lib/static-assets.js), so it is
  // cached for a year like the page's other scripts. Without it (a page that was not served that way, as in most browser tests) the plain address is
  // used, which is revalidated each time.
  const BUNDLE_PATH = '/js/notebook-ui.js';
  const assetUrl = path => (typeof window.TAAsset === 'function' ? window.TAAsset(path) : path);
  let bundle = null;
  function loadBundle() {
    if (typeof NotebookUI !== 'undefined') return Promise.resolve(NotebookUI);
    if (!bundle) {
      bundle = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = assetUrl(BUNDLE_PATH);
        script.onload = () => resolve(NotebookUI);
        script.onerror = () => { bundle = null; reject(new Error('The notebook view could not be loaded')); };
        document.head.append(script);
      });
    }
    return bundle;
  }
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);

  // Returns at once; the view appears when the bundle has loaded. destroy(), flush() and the rest work before that too (a menu action waits for it).
  function mount(container, options) {
    let view = null;
    let disposed = false;
    let active = options.active !== false;
    const waiting = [];
    container.textContent = tr('Loading…');
    container.setAttribute('aria-label', tr('Shell notebook'));
    loadBundle().then(ui => {
      if (disposed) return;
      container.textContent = '';
      view = ui.mount(container, { ...options, active });
      for (const name of waiting.splice(0)) view.action(name);
    }).catch(error => {
      if (disposed) return;
      container.textContent = tr(error.message);
      if (options.notify) options.notify(tr(error.message), 'error');
    });
    return {
      flush() { return view ? view.flush() : Promise.resolve(); },
      setActive(on) { active = Boolean(on); if (view) view.setActive(active); },
      action(name) { if (view) view.action(name); else waiting.push(name); },
      destroy() {
        disposed = true;
        if (view) view.destroy();
        view = null;
        container.textContent = '';
      },
    };
  }
  return { mount };
})();
