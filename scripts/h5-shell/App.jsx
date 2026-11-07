import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { CopyDialog, Notice, RetainDialog, UploadDialog } from './Dialogs.jsx';
import { AttentionPanel } from './Attention.jsx';
import { DesignSheet } from './Design.jsx';
import { FileTreeSheet } from './FileTree.jsx';
import { Header } from './Header.jsx';
import { SettingsDrawer } from './Settings.jsx';
import { TaskDialog } from './TaskDialogs.jsx';
import { TaskDrawer } from './TaskDrawer.jsx';
import { BottomArea, TerminalArea } from './Terminal.jsx';
import { TermMenu } from './TermMenu.jsx';
import { theme } from './theme.mjs';

// A sheet or dialog that is closed when the page starts is not drawn at all until it is opened the first time (the first render of the page is
// shorter); from then on it stays mounted, so MUI runs its closing animation and gives the focus back as usual.
function Lazy({ open, children }) {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return seen || open ? children : null;
}

// The whole phone page, drawn from the state in the store. The chat (#h5-agent) and the image picker are plain elements of h5.html, outside of React.
export function App({ ui }) {
  const state = useSyncExternalStore(ui.subscribe, ui.get);
  const tasksModal = state.tasksOpen && !state.wide;
  useLayoutEffect(() => {
    document.body.classList.toggle('h5-tasks-open', tasksModal);
    const chat = document.getElementById('h5-agent');
    if (chat) chat.inert = tasksModal;
    return () => {
      document.body.classList.remove('h5-tasks-open');
      if (chat) chat.inert = false;
    };
  }, [tasksModal]);
  // The wide layout's folded sidebar and the right side panel (the design document / file preview, or the file tree) change the page's side offsets in h5.css.
  const folded = state.wide && state.sidebarCollapsed;
  const sidePanel = state.wide && Boolean((state.design && state.design.open) || (state.files && state.files.open) || (state.attention && state.attention.open));
  useLayoutEffect(() => {
    document.documentElement.toggleAttribute('data-sidebar-collapsed', folded);
    document.documentElement.toggleAttribute('data-side-panel', sidePanel);
  }, [folded, sidePanel]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div className="h5-app" id="h5-app" inert={tasksModal}>
        <Header state={state} ui={ui} />
        <TerminalArea state={state} ui={ui} />
        <BottomArea state={state} ui={ui} />
      </div>
      <TaskDrawer state={state} ui={ui} />
      <Lazy open={state.settingsOpen}><SettingsDrawer state={state} ui={ui} /></Lazy>
      <Lazy open={Boolean(state.menu)}><TermMenu state={state} ui={ui} /></Lazy>
      <Lazy open={state.copyText !== null}><CopyDialog state={state} ui={ui} /></Lazy>
      {/* The file tree comes first: a file opened from it lies over it (the file panel, drawn after it, or a modal sheet opened after it). */}
      <Lazy open={Boolean(state.files && state.files.open)}><FileTreeSheet state={state} ui={ui} /></Lazy>
      <Lazy open={Boolean(state.design && state.design.open)}><DesignSheet state={state} ui={ui} /></Lazy>
      <Lazy open={Boolean(state.attention && state.attention.open)}><AttentionPanel state={state} ui={ui} /></Lazy>
      <Lazy open={Boolean(state.upload)}><UploadDialog state={state} ui={ui} /></Lazy>
      <Lazy open={state.retainUrl !== null}><RetainDialog state={state} ui={ui} /></Lazy>
      <Lazy open={Boolean(state.taskDialog)}><TaskDialog state={state} ui={ui} /></Lazy>
      <Notice state={state} ui={ui} />
    </ThemeProvider>
  );
}
