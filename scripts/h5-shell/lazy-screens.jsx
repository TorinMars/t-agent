// The screens that open on demand: Settings (with the plugin market, engines, pairing, remote access, rule sync and the notifiers inside it), the
// T-Attention panel, and the design document and file tree sheets. They are not in public/js/h5-shell.js: each is a chunk of its own
// (scripts/build-page-bundles.js) that is imported the first time it opens, so the first screen downloads and parses only what it draws.
//
// Each export has the name and the props of the component it stands for, so App.jsx draws it as before. While its chunk loads, nothing is drawn (the
// sheet opens with its own animation once it is there, a few milliseconds on a cached page). The chunk is asked for early when the pointer
// rests on, a finger touches, or the focus reaches the button that opens it (`preloadOnIntent`). A chunk that cannot be loaded (the network is gone)
// closes the screen and says to reload the page: browsers remember a module that failed to load for the life of the page (Chromium answers the same
// import with the same error at once), so only a reload fetches it again. The next opening still tries (a browser that does not remember it loads it).
import { Component, Suspense, lazy, useState } from 'react';
import { t } from './common.jsx';

const FAILED = 'This part of the page could not be loaded. Check the connection and reload the page.';

// Draws nothing for its children's errors and reports each one (`onError`); a new `attempt` starts over.
class LoadBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: null }; }
  static getDerivedStateFromError(error) { return { failed: error }; }
  componentDidCatch(error) { this.props.onError(error); }
  componentDidUpdate(previous) { if (previous.attempt !== this.props.attempt && this.state.failed) this.setState({ failed: null }); }
  render() { return this.state.failed ? null : this.props.children; }
}

// `load`: imports the chunk; `name`: its export to draw; `isOpen(state)`: whether the screen is open; `close(ui)`: closes it after a failed load.
function screen(load, name, isOpen, close) {
  let loading = null;
  let ready = false; // the chunk is there: from then on the screen stays drawn while it is closed (its closing animation, as before)
  const preload = () => {
    if (!loading) {
      loading = load();
      loading.then(() => { ready = true; }, () => { loading = null; }); // after a failure the next opening (or hover) asks again
    }
    return loading;
  };
  const make = () => lazy(() => preload().then(module => ({ default: module[name] })));
  let Loaded = make();
  function Screen(props) {
    const [attempt, setAttempt] = useState(0);
    if (!ready && !isOpen(props.state)) return null; // closed after a failed load: nothing is asked for until it opens again
    const failed = () => {
      Loaded = make(); // React.lazy remembers a failure for good: the next opening gets a new one
      setAttempt(value => value + 1);
      close(props.ui);
      if (props.ui && props.ui.notify) props.ui.notify(t(FAILED), 'error');
    };
    return (
      <LoadBoundary attempt={attempt} onError={failed}>
        <Suspense fallback={null}><Loaded {...props} /></Suspense>
      </LoadBoundary>
    );
  }
  Screen.preload = preload;
  Screen.displayName = `Lazy(${name})`;
  return Screen;
}

export const SettingsDrawer = screen(() => import('./screen-settings.jsx'), 'SettingsDrawer', state => Boolean(state.settingsOpen), ui => ui.actions.closeSettings && ui.actions.closeSettings());
export const AttentionPanel = screen(() => import('./screen-attention.jsx'), 'AttentionPanel', state => Boolean(state.attention && state.attention.open), ui => ui.actions.closeAttention && ui.actions.closeAttention());
export const DesignSheet = screen(() => import('./screen-design.jsx'), 'DesignSheet', state => Boolean(state.design && state.design.open), ui => ui.actions.closeDesign && ui.actions.closeDesign());
export const FileTreeSheet = screen(() => import('./screen-files.jsx'), 'FileTreeSheet', state => Boolean(state.files && state.files.open), ui => ui.actions.closeFiles && ui.actions.closeFiles());

// The buttons that open each screen (by id, so their components need not know about chunks). `pointerover` covers a mouse resting on it,
// `pointerdown` a finger (about 100 ms before the click), `focusin` the keyboard.
const OPENERS = [
  ['#h5-tasks-settings, #h5-nav-settings', SettingsDrawer],
  ['#h5-attention, #h5-nav-attention, #h5-tasks-attention', AttentionPanel],
  ['#h5-design, #h5-commands-docs, #h5-files-design', DesignSheet],
  ['#h5-design-files', FileTreeSheet],
];
export function preloadOnIntent(root = document) {
  const handle = event => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    for (const [selector, Screen] of OPENERS) if (target.closest(selector)) Screen.preload().catch(() => { /* tried again on open */ });
  };
  for (const type of ['pointerover', 'pointerdown', 'focusin']) root.addEventListener(type, handle, { capture: true, passive: true });
}
