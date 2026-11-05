import { useLayoutEffect, useSyncExternalStore } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { CopyDialog, Notice, RetainDialog, UploadDialog } from './Dialogs.jsx';
import { DesignSheet } from './Design.jsx';
import { Header } from './Header.jsx';
import { SettingsDrawer } from './Settings.jsx';
import { TaskDrawer } from './TaskDrawer.jsx';
import { BottomArea, TerminalArea } from './Terminal.jsx';
import { TermMenu } from './TermMenu.jsx';
import { theme } from './theme.mjs';

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
  // The wide layout's folded sidebar and the right side panel (the design document / file preview) change the page's side offsets in h5.css.
  const folded = state.wide && state.sidebarCollapsed;
  const sidePanel = state.wide && Boolean(state.design && state.design.open);
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
      <SettingsDrawer state={state} ui={ui} />
      <TermMenu state={state} ui={ui} />
      <CopyDialog state={state} ui={ui} />
      <DesignSheet state={state} ui={ui} />
      <UploadDialog state={state} ui={ui} />
      <RetainDialog state={state} ui={ui} />
      <Notice state={state} ui={ui} />
    </ThemeProvider>
  );
}
