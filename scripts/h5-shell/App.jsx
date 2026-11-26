import { useLayoutEffect, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { Notice } from './Notice.jsx';
import { Header } from './Header.jsx';
import { NewSessionDialog, NewTaskDialog, TaskDrawer } from './TaskDrawer.jsx';
import { BottomArea, TerminalArea } from './Terminal.jsx';
import { ColumnStrip, NavRail } from './Columns.jsx';
import { BottomNav } from './BottomNav.jsx';
import { measureTerminalBox, trackTerminalBox } from './terminal-box.mjs';
import { TermMenu } from './TermMenu.jsx';
import { theme } from './theme.mjs';
import { countRender, useStore, useStoreKeys } from './use-store.mjs';
import { shallowEqual } from './store.mjs';
// Drawn from chunks that are loaded when first opened (lazy-screens.jsx).
import {
  AttentionPanel, CopyScreen, DesignSheet, MouseBallScreen, FileTreeSheet, LearnScreen, PasteScreen, RetainScreen, SettingsDrawer, SwitcherScreen, TaskDialogScreen, UploadScreen, StartCommandDialog,
} from './lazy-screens.jsx';

// A sheet or dialog that is closed when the page starts is not drawn at all until it is opened the first time (the first render of the page is
// shorter); from then on it stays mounted, so MUI runs its closing animation and gives the focus back as usual.
function Lazy({ open, children }) {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return seen || open ? children : null;
}

// A part of the page drawn from the named keys of the state (use-store.mjs `useStoreKeys`): a change of another key does not draw it again.
function Part({ ui, keys, part: Component }) {
  const state = useStoreKeys(ui, keys);
  return <Component state={state} ui={ui} />;
}
// A part that reads keys all over its tree (the settings sheet): the whole state. Closed, it draws only its empty sheet.
const WHOLE = state => state;
function Whole({ ui, part: Component }) {
  const state = useStore(ui, WHOLE);
  return <Component state={state} ui={ui} />;
}
// The popup of a session row closes when its row goes away: it looks again whenever the list or the sidebar changes (TermMenu.jsx).
const TERM_MENU_KEYS = ['menu', 'wide', 'taskList', 'sidebarCollapsed', 'tasksOpen'];
const COPY_KEYS = ['copyText', 'copyStale', 'terminalWidth'];
const SHEET_KEYS = ['files', 'design', 'wide'];
const ATTENTION_KEYS = ['attention', 'taskList', 'wide', 'shownTarget']; // shownTarget: the row of the shown session is marked (Attention.jsx)
const UPLOAD_KEYS = ['upload'];
const RETAIN_KEYS = ['retainUrl'];
const PASTE_KEYS = ['pasteSheet'];
const TASK_DIALOG_KEYS = ['taskDialog'];
const NEW_SESSION_KEYS = ['menu'];
const START_COMMAND_KEYS = ['startCommandDialog'];
const NEW_TASK_KEYS = ['newTaskOpen', 'sources', 'creatingTask'];
const NOTICE_KEYS = ['notice'];
const LEARN_KEYS = ['learnOpen', 'learnTarget', 'wide', 'pane', 'input', 'hasKeyboard'];
// The mouse ball (MouseBall.jsx): whether it is on here, and what covers or replaces the terminal.
const BALL_KEYS = ['mouseBall', 'input', 'wide', 'pane', 'empty', 'notebook', 'copyText', 'mindmapOpen', 'learnOpen'];
const SWITCHER_KEYS = ['switcher']; // the open switcher reads the rest itself (Switcher.jsx), so closed it draws nothing on an activity push
// What the page itself needs: the layout flags and which sheets and dialogs are open.
const OPEN = state => ({
  tasksModal: state.tasksOpen && !state.wide,
  folded: state.wide && state.sidebarCollapsed,
  settings: state.settingsOpen,
  learn: state.learnOpen,
  menu: Boolean(state.menu),
  copy: state.copyText !== null,
  files: Boolean(state.files && state.files.open),
  design: Boolean(state.design && state.design.open),
  attention: Boolean(state.attention && state.attention.open),
  upload: Boolean(state.upload),
  retain: state.retainUrl !== null,
  paste: Boolean(state.pasteSheet),
  taskDialog: Boolean(state.taskDialog),
  naming: Boolean(state.menu && state.menu.naming),
  newTask: state.newTaskOpen,
  startCommand: Boolean(state.startCommandDialog),
  switcher: Boolean(state.switcher),
});

// The whole phone page. Every part subscribes to the slice of the store it draws (the header, the terminal area, the bottom rows, the task list and its
// rows, the column strip read theirs themselves; the sheets and dialogs through `Part`), so a change is drawn only where it shows (see "Page store" in
// docs/design/page-shell-and-columns.md). The chat (#h5-agent) and the image picker are plain elements of h5.html, outside of React.
export function App({ ui }) {
  const open = useStore(ui, OPEN, shallowEqual);
  countRender('App');
  const { tasksModal, folded } = open;
  useLayoutEffect(() => {
    document.body.classList.toggle('h5-tasks-open', tasksModal);
    const chat = document.getElementById('h5-agent');
    if (chat) chat.inert = tasksModal;
    return () => {
      document.body.classList.remove('h5-tasks-open');
      if (chat) chat.inert = false;
    };
  }, [tasksModal]);
  // The wide layout's folded sidebar changes the page's left offset in h5.css (with the navigation rail, which sets `data-nav-rail` itself: left to
  // right, the rail, the task list, then the header, terminal and bottom row; "Page layout" in docs/design/page-navigation.md). The T-Attention side
  // sheet floats over the page and changes no offset.
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-sidebar-collapsed', folded);
    measureTerminalBox(); // in the same frame as the new layout
  }, [folded]);
  // The top sheets line up with the terminal area on a wide screen (terminal-box.mjs). It always runs, so a sheet has the right place from its first frame.
  useLayoutEffect(() => trackTerminalBox(), []);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div className="h5-app" id="h5-app" inert={tasksModal}>
        <Header ui={ui} />
        <TerminalArea ui={ui} />
        <BottomArea ui={ui} />
      </div>
      <TaskDrawer ui={ui} />
      {/* The navigation rail of the wide layout, in the single view and above the columns view (Columns.jsx). */}
      <NavRail ui={ui} />
      {/* Its phone counterpart: the bottom navigation of the narrow layout (BottomNav.jsx). */}
      <BottomNav ui={ui} />
      <Lazy open={open.settings}><Whole ui={ui} part={SettingsDrawer} /></Lazy>
      {/* The Learn page (Learn.jsx): beside the rail on a computer, above the bottom navigation on a phone. */}
      <Lazy open={open.learn}><Part ui={ui} keys={LEARN_KEYS} part={LearnScreen} /></Lazy>
      <Lazy open={open.menu}><Part ui={ui} keys={TERM_MENU_KEYS} part={TermMenu} /></Lazy>
      <Lazy open={open.copy}><Part ui={ui} keys={COPY_KEYS} part={CopyScreen} /></Lazy>
      {/* The file tree comes first: a file opened from it lies over it (a modal sheet opened after it). */}
      <Lazy open={open.files}><Part ui={ui} keys={SHEET_KEYS} part={FileTreeSheet} /></Lazy>
      <Lazy open={open.design}><Part ui={ui} keys={SHEET_KEYS} part={DesignSheet} /></Lazy>
      <Lazy open={open.attention}><Part ui={ui} keys={ATTENTION_KEYS} part={AttentionPanel} /></Lazy>
      <Lazy open={open.upload}><Part ui={ui} keys={UPLOAD_KEYS} part={UploadScreen} /></Lazy>
      <Lazy open={open.retain}><Part ui={ui} keys={RETAIN_KEYS} part={RetainScreen} /></Lazy>
      <Lazy open={open.paste}><Part ui={ui} keys={PASTE_KEYS} part={PasteScreen} /></Lazy>
      <Lazy open={open.taskDialog}><Part ui={ui} keys={TASK_DIALOG_KEYS} part={TaskDialogScreen} /></Lazy>
      {/* The two create dialogs: they lie over the task sheet of a phone, outside it, so it closing after a create does not take them away mid-animation. */}
      <Lazy open={open.naming}><Part ui={ui} keys={NEW_SESSION_KEYS} part={NewSessionDialog} /></Lazy>
      <Lazy open={open.startCommand}><Part ui={ui} keys={START_COMMAND_KEYS} part={StartCommandDialog} /></Lazy>
      <Lazy open={open.newTask}><Part ui={ui} keys={NEW_TASK_KEYS} part={NewTaskDialog} /></Lazy>
      {/* The session switcher of the single view, over the terminal (Switcher.jsx; opened by the switch button, `#h5-cycle`). */}
      <Lazy open={open.switcher}><Part ui={ui} keys={SWITCHER_KEYS} part={SwitcherScreen} /></Lazy>
      {/* Over the phone terminal while it is on for this device (lazy-screens.jsx `MouseBallScreen`; nothing is loaded while it is off). */}
      <Part ui={ui} keys={BALL_KEYS} part={MouseBallScreen} />
      <ColumnStrip ui={ui} />
      <Part ui={ui} keys={NOTICE_KEYS} part={Notice} />
    </ThemeProvider>
  );
}
