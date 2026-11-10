import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';

// The dialogs of the task "⋯" menu (h5.js `ui.actions.taskMore`): the delete confirmation, with "Also delete the directory" (off by default;
// the server refuses a protected or shared directory), and the working directory of an existing task (the saved path is shown).
export function TaskDialog({ state, ui }) {
  const dialog = state.taskDialog;
  const [alsoDir, setAlsoDir] = useState(false);
  const [dir, setDir] = useState('');
  const key = dialog ? `${dialog.kind}:${dialog.sourceKey}:${dialog.id}` : '';
  // Tasks of two services can have the same title: the name of a service that is not this machine is shown with it.
  const service = dialog && dialog.service ? <Typography id="h5-task-dialog-service" variant="caption" component="p" color="text.secondary" translate="no" sx={{ mb: 1, overflowWrap: 'anywhere' }}>{dialog.service}</Typography> : null;
  useEffect(() => { setAlsoDir(false); setDir(dialog ? dialog.workDir : ''); }, [key]);
  const close = () => ui.actions.taskDialogClose();
  const open = Boolean(dialog);
  if (dialog && dialog.kind === 'workdir') {
    return (
      <Dialog id="h5-task-dialog" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-task-dialog-title">
        <Box component="form" autoComplete="off" onSubmit={event => { event.preventDefault(); void ui.actions.taskWorkdirSave(dir); }}>
          <DialogTitle id="h5-task-dialog-title" sx={{ overflowWrap: 'anywhere' }}>{t('Edit working directory')}</DialogTitle>
          <DialogContent>
            {service}
            <DialogContentText variant="body2" sx={{ mb: 1.5, overflowWrap: 'anywhere' }}>{dialog.title}</DialogContentText>
            <TextField
              id="h5-task-workdir" autoFocus fullWidth size="small" label={t('Working directory')} value={dir} onChange={event => setDir(event.target.value)}
              error={Boolean(dialog.error)} helperText={dialog.error ? t(dialog.error) : t('Docs and the terminal use this directory; existing DESIGN.md, README.md and AGENTS.md are used first and created if missing')}
              slotProps={{ htmlInput: { autoCapitalize: 'off', spellCheck: false } }}
            />
            {dir.trim() && dir.trim() !== (dialog.workDir || '') ? (
              <Typography id="h5-task-workdir-note" variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>
                {t('Existing sessions keep their directory; new sessions start in the new one.')}
              </Typography>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button id="h5-task-dialog-cancel" color="inherit" onClick={close} disabled={dialog.busy}>{t('Cancel')}</Button>
            <Button id="h5-task-dialog-ok" type="submit" variant="contained" disabled={dialog.busy}>{t('Save')}</Button>
          </DialogActions>
        </Box>
      </Dialog>
    );
  }
  if (dialog && dialog.kind === 'archive') {
    return (
      <Dialog id="h5-task-dialog" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-task-dialog-title">
        <DialogTitle id="h5-task-dialog-title">{t('Archive this task?')}</DialogTitle>
        <DialogContent>
          {service}
          <DialogContentText id="h5-task-archive-name" translate="no" sx={{ mb: 1, overflowWrap: 'anywhere' }}>{dialog.title}</DialogContentText>
          {dialog.running > 0 ? (
            <Typography id="h5-task-archive-running" role="alert" variant="body2" color="warning.main" sx={{ mb: 1, fontWeight: 700 }}>
              {dialog.running === 1 ? t('1 terminal is still running and will be stopped') : t(`${dialog.running} terminals are still running and will be stopped`)}
            </Typography>
          ) : null}
          <Typography id="h5-task-archive-text" variant="body2" color="text.secondary">{t('Files, documents and terminal records are kept. Its terminals will be closed.')}</Typography>
          {dialog.checking ? <Typography id="h5-task-archive-checking" variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>{t('Checking for running terminals…')}</Typography> : null}
          {dialog.error ? <Typography id="h5-task-dialog-error" role="alert" variant="body2" color="error" sx={{ mt: 1, overflowWrap: 'anywhere' }}>{dialog.error}</Typography> : null}
        </DialogContent>
        <DialogActions>
          <Button id="h5-task-dialog-cancel" color="inherit" onClick={close} disabled={dialog.busy}>{t('Cancel')}</Button>
          <Button id="h5-task-dialog-ok" variant="contained" disabled={dialog.busy || dialog.checking} onClick={() => void ui.actions.taskArchive()}>{t('Archive')}</Button>
        </DialogActions>
      </Dialog>
    );
  }
  return (
    <Dialog id="h5-task-dialog" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-task-dialog-title">
      {dialog ? (
        <>
          <DialogTitle id="h5-task-dialog-title">{t('Delete task')}</DialogTitle>
          <DialogContent>
            {service}
            <DialogContentText id="h5-task-delete-text" sx={{ overflowWrap: 'anywhere' }}>{`${t('Delete task')} “${dialog.title}”? ${t('The task record and its to-dos will be deleted.')}`}</DialogContentText>
            {dialog.workDir ? (
              <>
                <FormControlLabel control={<Checkbox checked={alsoDir} onChange={event => setAlsoDir(event.target.checked)} slotProps={{ input: { id: 'h5-task-delete-dir' } }} />} label={t('Also delete the directory')} />
                {alsoDir ? (
                  <Typography id="h5-task-delete-dir-path" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>
                    <code>{dialog.workDir}</code><br />{t('The directory and everything in it will be permanently deleted and cannot be recovered.')}
                  </Typography>
                ) : null}
              </>
            ) : <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('This task has no working directory, so no directory will be deleted.')}</Typography>}
            {dialog.error ? <Typography id="h5-task-dialog-error" role="alert" variant="body2" color="error" sx={{ mt: 1, overflowWrap: 'anywhere' }}>{dialog.error}</Typography> : null}
          </DialogContent>
          <DialogActions>
            <Button id="h5-task-dialog-cancel" color="inherit" onClick={close} disabled={dialog.busy}>{t('Cancel')}</Button>
            <Button id="h5-task-dialog-ok" variant="contained" color="error" disabled={dialog.busy} onClick={() => void ui.actions.taskDelete(alsoDir)}>{t('Delete')}</Button>
          </DialogActions>
        </>
      ) : null}
    </Dialog>
  );
}
