import { useLayoutEffect, useSyncExternalStore } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { CopyDialog, Notice, RetainDialog, UploadDialog } from './Dialogs.jsx';
import { Header } from './Header.jsx';
import { SettingsDrawer } from './Settings.jsx';
import { TaskDrawer } from './TaskDrawer.jsx';
import { KeyBar, TerminalArea, TranslateBar } from './Terminal.jsx';
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
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <div className="h5-app" id="h5-app" inert={tasksModal}>
        <Header state={state} ui={ui} />
        <TerminalArea state={state} ui={ui} />
        <TranslateBar state={state} ui={ui} />
        <KeyBar state={state} ui={ui} />
      </div>
      <TaskDrawer state={state} ui={ui} />
      <SettingsDrawer state={state} ui={ui} />
      <TermMenu state={state} ui={ui} />
      <CopyDialog state={state} ui={ui} />
      <UploadDialog state={state} ui={ui} />
      <RetainDialog state={state} ui={ui} />
      <Notice state={state} ui={ui} />
    </ThemeProvider>
  );
}
