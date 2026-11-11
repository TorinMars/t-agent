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
import { folderFollowsTitle, folderNameProblem, folderParts, joinFolder, titleToSlug } from './task-rename.mjs';

// The Rename dialog of the task "⋯" menu (h5.js `askTaskRename`): the title and, where the task's service can (`folderSupported`), "Also rename the folder"
// (off by default) with the old path, the new name (the slug of the new title, as a new task gets, until the person edits it) and the new path. The checkbox is
// shown at once when the folder still has its title's name; otherwise one tap on "Rename the folder too" shows it. A task with open terminals (`blocked`, the
// server's TASK_BUSY) offers to close them and try again; a running chat turn has to be stopped first.
function RenameTaskDialog({ dialog, ui, service, close }) {
  const [title, setTitle] = useState(dialog.title);
  const [also, setAlso] = useState(false);
  const [shown, setShown] = useState(() => folderFollowsTitle(dialog.workDir, dialog.title));
  const [name, setName] = useState(() => titleToSlug(dialog.title.trim()));
  const [named, setNamed] = useState(false); // the person edited the name: it no longer follows the title
  const parts = folderParts(dialog.workDir);
  const offer = Boolean(parts) && dialog.folderSupported === true;
  const folder = offer && also ? name : null;
  const problem = folder !== null ? folderNameProblem(folder) : '';
  const changeTitle = value => { setTitle(value); if (!named) setName(titleToSlug(value.trim())); };
  const submit = event => {
    event.preventDefault();
    if (problem) return;
    void ui.actions.taskRenameSave({ title, folder });
  };
  const blocked = dialog.blocked;
  const count = blocked ? blocked.terminals.length : 0;
  return (
    <Dialog id="h5-task-dialog" open onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-task-dialog-title">
      <Box component="form" autoComplete="off" onSubmit={submit}>
        <DialogTitle id="h5-task-dialog-title">{t('Rename task')}</DialogTitle>
        <DialogContent>
          {service}
          <TextField
            id="h5-task-rename-title" autoFocus fullWidth size="small" label={t('Title')} value={title} onChange={event => changeTitle(event.target.value)} sx={{ mt: 1 }}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { maxLength: 200, enterKeyHint: 'done' } }}
          />
          {offer && !shown ? (
            <Button id="h5-task-rename-folder-show" size="small" sx={{ mt: 1, px: 0, minHeight: 36 }} onClick={() => { setShown(true); setAlso(true); }}>{t('Rename the folder too')}</Button>
          ) : null}
          {offer && shown ? (
            <FormControlLabel sx={{ mt: 1, display: 'flex' }} control={<Checkbox checked={also} disabled={dialog.busy} onChange={event => setAlso(event.target.checked)} slotProps={{ input: { id: 'h5-task-rename-folder' } }} />} label={t('Also rename the folder')} />
          ) : null}
          {dialog.folderSupported === null && parts ? <Typography id="h5-task-rename-checking" variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>{t('Checking what this server can do…')}</Typography> : null}
          {folder !== null ? (
            <Box id="h5-task-rename-folder-box" sx={{ mt: 1 }}>
              <Typography variant="caption" component="p" color="text.secondary">{t('Folder')}</Typography>
              <Typography id="h5-task-rename-old" variant="body2" translate="no" sx={{ mb: 1.5, overflowWrap: 'anywhere' }}><code>{dialog.workDir}</code></Typography>
              <TextField
                id="h5-task-rename-name" fullWidth size="small" label={t('New folder name')} value={name}
                onChange={event => { setName(event.target.value); setNamed(true); }} error={Boolean(problem)} helperText={problem ? t(problem) : null}
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { autoCapitalize: 'off', spellCheck: false } }}
              />
              <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>{t('New folder')}</Typography>
              <Typography id="h5-task-rename-new" variant="body2" translate="no" sx={{ overflowWrap: 'anywhere' }}><code>{joinFolder(parts, name)}</code></Typography>
              <Typography id="h5-task-rename-note" variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>{t('The Claude Code and Codex sessions of this folder move with it and still resume. Its terminals must be closed.')}</Typography>
            </Box>
          ) : null}
          {blocked ? (
            <Box id="h5-task-rename-busy" role="alert" sx={{ mt: 1.5 }}>
              <Typography variant="body2" color="warning.main" sx={{ fontWeight: 700 }}>
                {blocked.chat ? t('A chat turn of this task is running. Stop it, then try again.')
                  : count === 1 ? t('1 terminal of this task is open. It must be closed before the folder can be renamed.')
                    : t(`${count} terminals of this task are open. They must be closed before the folder can be renamed.`)}
              </Typography>
              {!blocked.chat && count ? (
                <Button id="h5-task-rename-close" variant="outlined" color="warning" size="small" sx={{ mt: 1 }} disabled={dialog.busy} onClick={() => void ui.actions.taskRenameCloseRetry({ title, folder })}>
                  {t('Close terminals and rename')}
                </Button>
              ) : null}
            </Box>
          ) : null}
          {dialog.error ? <Typography id="h5-task-dialog-error" role="alert" variant="body2" color="error" sx={{ mt: 1, overflowWrap: 'anywhere' }}>{dialog.error}</Typography> : null}
        </DialogContent>
        <DialogActions>
          <Button id="h5-task-dialog-cancel" color="inherit" onClick={close} disabled={dialog.busy}>{t('Cancel')}</Button>
          <Button id="h5-task-dialog-ok" type="submit" variant="contained" disabled={dialog.busy || Boolean(problem) || !title.trim()}>{t('Save')}</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

// The dialogs of the task "⋯" menu (h5.js `ui.actions.taskMore`): the delete confirmation, with "Also delete the directory" (off by default;
// the server refuses a protected or shared directory), the working directory of an existing task (the saved path is shown), and which linked machines can see a task.
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
  if (dialog && dialog.kind === 'rename') return <RenameTaskDialog key={key} dialog={dialog} ui={ui} service={service} close={close} />;
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
  if (dialog && dialog.kind === 'visibility') {
    const ready = dialog.status === 'ready';
    const devices = ready ? dialog.devices : [];
    return (
      <Dialog id="h5-task-dialog" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-task-dialog-title">
        <DialogTitle id="h5-task-dialog-title">{t('Visible to')}</DialogTitle>
        <DialogContent>
          <DialogContentText id="h5-task-visibility-name" translate="no" sx={{ mb: 1, overflowWrap: 'anywhere' }}>{dialog.title}</DialogContentText>
          {dialog.status === 'loading' ? <Typography id="h5-task-visibility-loading" role="status" variant="body2" color="text.secondary">{t('Loading…')}</Typography> : null}
          {ready && !devices.length ? <Typography id="h5-task-visibility-empty" variant="body2" color="text.secondary">{t('No linked machines')}</Typography> : null}
          {devices.map(device => (
            <FormControlLabel
              key={device.link_id} className="h5-visibility-row" data-link={device.link_id}
              sx={{ display: 'flex', ml: 0, mr: 0, minHeight: 44, '& .MuiFormControlLabel-label': { flex: '1 1 auto', minWidth: 0 } }}
              control={<Checkbox checked={device.allowed} disabled={dialog.busy} onChange={event => ui.actions.taskVisibilitySet(device.link_id, event.target.checked)} />}
              label={(
                <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 1 }}>
                  <Box component="span" className="h5-visibility-name" translate="no" title={device.name} sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{device.name}</Box>
                  {device.online ? null : <Typography className="h5-visibility-offline" component="span" variant="caption" color="text.secondary">{t('Offline')}</Typography>}
                </Box>
              )}
            />
          ))}
          {devices.some(device => !device.allowed) ? <Typography id="h5-task-visibility-denied" variant="body2" sx={{ mt: 1 }}>{t('Unchecked machines cannot open this task or see its sessions.')}</Typography> : null}
          {devices.length ? <Typography id="h5-task-visibility-honest" variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>{t('Linked machines still have full control of this computer, so this hides the task but is not a security boundary.')}</Typography> : null}
          {dialog.error ? <Typography id="h5-task-dialog-error" role="alert" variant="body2" color="error" sx={{ mt: 1, overflowWrap: 'anywhere' }}>{dialog.error}</Typography> : null}
        </DialogContent>
        <DialogActions>
          <Button id="h5-task-dialog-cancel" color="inherit" onClick={close} disabled={dialog.busy}>{t('Cancel')}</Button>
          {devices.length ? <Button id="h5-task-dialog-ok" variant="contained" disabled={dialog.busy} onClick={() => void ui.actions.taskVisibilitySave()}>{t('Save')}</Button> : null}
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
