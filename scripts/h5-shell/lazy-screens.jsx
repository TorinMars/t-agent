// The screens that open on demand: Settings (with the plugin market, engines, pairing, remote access, rule sync and the notifiers inside it), the
// T-Attention panel, the design document and file tree sheets, the session switcher, the Learn page, the task dialogs (delete, working directory, archive,
// visibility), the Update dialog and the terminal's dialogs (copy view, upload progress, Paste sheet, uploaded link). They are not in
// public/js/h5-shell.js: each is a chunk of its own (scripts/build-page-bundles.js) that is imported the first time it opens, so the first screen
// downloads and parses only what it draws.
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

// `load`: imports the chunk; `name`: its export to draw; `isOpen(state, props)`: whether the screen is open; `close(ui, props)`: closes it after a
// failed load. (`props` serves a screen whose open state is its owner's, not the store's: the Update dialog.)
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
    // A failed load of a screen that `close` cannot close (the upload progress, the Recent tab) is not asked for again until it has closed and opens
    // again: a browser that remembers the failure would otherwise answer at once, over and over.
    const [gaveUp, setGaveUp] = useState(false);
    const open = isOpen(props.state, props);
    if (gaveUp && !open) setGaveUp(false);
    if (!ready && !open) return null; // closed after a failed load: nothing is asked for until it opens again
    if (gaveUp) return null;
    const failed = () => {
      Loaded = make(); // React.lazy remembers a failure for good: the next opening gets a new one
      setAttempt(value => value + 1);
      setGaveUp(true);
      close(props.ui, props);
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
export const SwitcherScreen = screen(() => import('./screen-switcher.jsx'), 'Switcher', state => Boolean(state.switcher), ui => ui.actions.closeSwitcher && ui.actions.closeSwitcher());
// The Recent tab of the task list (TaskDrawer.jsx draws it only while the tab is chosen); nothing to close after a failed load.
export const RecentScreen = screen(() => import('./screen-recent.jsx'), 'RecentList', () => true, () => {});
export const LearnScreen = screen(() => import('./screen-learn.jsx'), 'LearnPage', state => Boolean(state.learnOpen), ui => ui.actions.closeLearn && ui.actions.closeLearn());
export const TaskDialogScreen = screen(() => import('./screen-task-dialog.jsx'), 'TaskDialog', state => Boolean(state.taskDialog), ui => ui.set && ui.set({ taskDialog: null }));
// The Update dialog of UpdateButton (Update.jsx), which keeps its open state and passes `open` / `onClose`.
export const UpdateDialogScreen = screen(() => import('./screen-update.jsx'), 'UpdateDialog', (state, props) => Boolean(props.open), (ui, props) => props.onClose());
// "Run a command when it starts" of the New session dialog (TaskDrawer.jsx `NewSessionDialog`), drawn on its first list; nothing to close.
const startCommand = () => import('./screen-start-command.jsx');
export const StartCommand = screen(startCommand, 'StartCommand', () => true, () => {});
export const StartCommandDialog = screen(startCommand, 'StartCommandDialog', state => Boolean(state.startCommandDialog), ui => ui.set({ startCommandDialog: null }));
// The banner of an engine on an older version (VersionSkew.jsx): TaskDrawer.jsx draws it only while the update status names one; nothing to close.
export const VersionSkewBanner = screen(() => import('./screen-skew.jsx'), 'VersionSkewBanner', () => true, () => {});
// The terminal's dialogs (Dialogs.jsx), one chunk. An upload that cannot show its progress goes on (h5.js unlocks the page when it ends).
const dialogs = () => import('./screen-dialogs.jsx');
export const CopyScreen = screen(dialogs, 'CopyDialog', state => state.copyText !== null, ui => ui.actions.copyClose && ui.actions.copyClose());
export const UploadScreen = screen(dialogs, 'UploadDialog', state => Boolean(state.upload), () => {});
export const PasteScreen = screen(dialogs, 'PasteDialog', state => Boolean(state.pasteSheet && state.pasteSheet.open), ui => ui.actions.pasteSheetClose && ui.actions.pasteSheetClose());
export const RetainScreen = screen(dialogs, 'RetainDialog', state => state.retainUrl !== null, ui => ui.actions.retainClose && ui.actions.retainClose());
// The mouse ball over the phone terminal (MouseBall.jsx), drawn while it is on for this device in touch input on a phone; off, it is never loaded.
// Nothing to close after a failed load (it is not asked for again until it is turned off and on).
export const MouseBallScreen = screen(() => import('./screen-mouse-ball.jsx'), 'MouseBall', state => Boolean(state.mouseBall) && state.input === 'touch' && !state.wide && !state.pane, () => {});

// "Updated to v…" (UpdatedNotice.jsx): no button opens it. The updater calls this when the update status says the person has a notice to see; the
// chunk asks for the notice, waits until the page is free and draws the dialog in a root of its own. A chunk that cannot be loaded shows nothing.
export const showUpdatedNotice = ui => import('./screen-updated.jsx').then(module => module.showUpdatedNotice(ui), () => {});

// The buttons that open each screen (by id, so their components need not know about chunks). `pointerover` covers a mouse resting on it,
// `pointerdown` a finger (about 100 ms before the click), `focusin` the keyboard. The terminal's dialogs open from the terminal itself (a long press
// opens the copy view, a pasted or dropped file the upload), the image button, the saved commands (Paste text) and the session menus (Copy text).
const OPENERS = [
  ['#h5-tasks-settings, #h5-nav-settings, #h5-bnav-settings', SettingsDrawer],
  ['#h5-attention, #h5-nav-attention, #h5-bnav-attention', AttentionPanel],
  ['#h5-design, #h5-commands-docs, #h5-files-design', DesignSheet],
  ['#h5-design-files', FileTreeSheet],
  ['#h5-cycle', SwitcherScreen],
  ['#h5-tab-recent', RecentScreen],
  ['#h5-nav-learn, #h5-bnav-learn', LearnScreen],
  ['#h5-update, #h5-header-update', UpdateDialogScreen],
  ['.h5-xterm, #h5-image, #h5-commands, #h5-more-commands, #h5-session-menu, #h5-term-menu', CopyScreen, UploadScreen, PasteScreen, RetainScreen],
];
export function preloadOnIntent(root = document) {
  const handle = event => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    for (const [selector, ...screens] of OPENERS) {
      if (target.closest(selector)) for (const Screen of screens) Screen.preload().catch(() => { /* tried again on open */ });
    }
  };
  for (const type of ['pointerover', 'pointerdown', 'focusin']) root.addEventListener(type, handle, { capture: true, passive: true });
}
