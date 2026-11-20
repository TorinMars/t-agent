// "Move to another machine…" of a task's menu (h5.js `askTaskMove`; "The dialogs" in docs/design/task-move.md): the Move task dialog (where to, the
// tick between a normal machine and a company computer, what will be closed and how much moves) and, once started, the progress dialog, which can be
// closed while the move goes on. Part of the task dialogs chunk (TaskDialogs.jsx), so the first screen does not carry it.
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import { DialogError, Pill, t } from './common.jsx';
import { orderDevices } from './device-order.mjs';

// The sentence of each refusal and failure the server gives (services/task-move.js).
const TEXTS = {
  MOVE_TIER_CONFIRMATION_REQUIRED: 'Tick "I understand, move it anyway" to move between a company computer and a normal machine',
  MOVE_TOO_LARGE: 'This task is too large to move (the limit is 2 GB)',
  MOVE_TOO_MANY_FILES: 'This task has too many files to move',
  MOVE_NO_SPACE: 'Not enough free space there',
  MOVE_FOLDER_NOT_MOVABLE: 'The folder cannot be moved',
  MOVE_FOLDER_MISSING: 'The working directory does not exist',
  MOVE_TASK_HIDDEN: 'This task is hidden from that machine',
  MOVE_TARGET_OFFLINE: 'Offline',
  MOVE_TARGET_UNSUPPORTED: 'Update it first',
  MOVE_TARGET_UNKNOWN: 'That machine is no longer linked',
  MOVE_IN_PROGRESS: 'This task is already being moved',
  MOVE_FINISHING: 'The copy was verified; the move can no longer be stopped',
  MOVE_VERIFY_FAILED: 'The copy did not match the original',
  MOVE_HASH_MISMATCH: 'The copy did not match the original',
  MOVE_FILE_CHANGED: 'A file changed while it was being copied',
  MOVE_TARGET_SILENT: 'The other machine stopped answering',
  MOVE_INTERRUPTED: 'A restart interrupted the move',
  MOVE_UNSUPPORTED: 'This server is too old to move tasks. Update it first',
  TASK_ARCHIVED: 'Restore the task first',
  TASK_MOVING: 'This task is already being moved',
};
const text = code => t(TEXTS[code] || code || '');
const english = code => TEXTS[code] || code || '';

// Sizes as people read them: 3.2 MB.
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

function phaseLine(progress) {
  const total = progress.files_total;
  switch (progress.phase) {
    case 'closing': return t('Closing terminals');
    case 'scanning': return t('Checking the files');
    case 'copying': return t(`Copying files · ${progress.files_done || 0} of ${total || 0}`);
    case 'verifying': return t('Verifying the copy');
    case 'creating': case 'finishing': return t('Creating the task there');
    default: return '';
  }
}

function ProgressDialog({ dialog, ui, close }) {
  const progress = dialog.progress || {};
  const target = progress.target ? progress.target.name : '';
  const ended = ['done', 'failed', 'cancelled'].includes(progress.phase);
  const value = progress.bytes_total ? Math.min(100, Math.round((100 * (progress.bytes_done || 0)) / progress.bytes_total)) : 0;
  const determinate = progress.phase === 'copying' || ended;
  return (
    <Dialog id="h5-task-dialog" open onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-task-dialog-title">
      <DialogTitle id="h5-task-dialog-title" sx={{ overflowWrap: 'anywhere' }}>{t(`Moving “${dialog.title}” to ${target}`)}</DialogTitle>
      <DialogContent>
        {!ended ? (
          <>
            <LinearProgress id="h5-move-progress" variant={determinate ? 'determinate' : 'indeterminate'} value={value} sx={{ mt: 1, borderRadius: 1 }} />
            <Typography id="h5-move-phase" variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>{phaseLine(progress)}</Typography>
            <Typography id="h5-move-note" variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              {t(`The task stays on ${dialog.from} until everything has arrived and was checked. You can close this; the move goes on.`)}
            </Typography>
          </>
        ) : null}
        {progress.phase === 'cancelled' ? <Typography id="h5-move-cancelled" variant="body2" sx={{ mt: 1 }}>{t('The move was stopped; nothing was changed.')}</Typography> : null}
        {progress.phase === 'failed' ? (
          <DialogError id="h5-task-dialog-error">{`${t(`The task was not moved; nothing was changed: ${english(progress.error)}`)}${progress.reason ? ` (${progress.reason})` : ''}`}</DialogError>
        ) : null}
        {dialog.error && !ended ? <DialogError id="h5-task-dialog-error">{text(dialog.error)}</DialogError> : null}
      </DialogContent>
      <DialogActions>
        {progress.cancellable && !ended ? <Button id="h5-move-stop" disabled={dialog.busy} onClick={() => void ui.actions.taskMoveCancel()}>{t('Stop move')}</Button> : null}
        <Button id="h5-task-dialog-cancel" onClick={close}>{t('Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function MoveTaskDialog({ dialog, ui, close }) {
  const preview = dialog.preview || null;
  const targets = preview ? orderDevices(preview.targets || [], item => ({ name: item.name, instanceId: item.instance_id })) : [];
  const usable = targets.filter(item => !item.refusal);
  const [target, setTarget] = useState('');
  const [ack, setAck] = useState(false);
  useEffect(() => { if (!target && usable.length) setTarget(usable[0].instance_id); }, [preview]);
  if (dialog.stage === 'progress') return <ProgressDialog dialog={dialog} ui={ui} close={close} />;
  const chosen = targets.find(item => item.instance_id === target) || null;
  const self = preview ? preview.self : null;
  const crossTier = Boolean(chosen && self && chosen.company_computer !== null && Boolean(chosen.company_computer) !== Boolean(self.company_computer));
  const refusal = preview && preview.refusal;
  const folder = preview && preview.folder;
  const running = preview ? preview.terminals.running : 0;
  const busy = preview ? preview.terminals.busy : 0;
  const ready = dialog.stage === 'ready' && chosen && !chosen.refusal && !refusal && (!crossTier || ack) && !dialog.busy;
  const counts = [
    running ? (running === 1 ? t('1 running terminal will be closed.') : t(`${running} running terminals will be closed.`)) : null,
    folder ? t(`${folder.files} files, ${formatBytes(folder.bytes)}.`) : null,
  ].filter(Boolean).join(' ');
  return (
    <Dialog id="h5-task-dialog" open onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-task-dialog-title">
      <DialogTitle id="h5-task-dialog-title">{t('Move task')}</DialogTitle>
      <DialogContent>
        <Typography id="h5-move-text" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {t(`“${dialog.title}” moves from ${dialog.from} to another machine with its folder, documents and agent sessions.`)}
        </Typography>
        {dialog.stage === 'loading' ? <Typography id="h5-move-loading" role="status" variant="body2" color="text.secondary" sx={{ mt: 2 }}>{t('Checking the task…')}</Typography> : null}
        {dialog.stage === 'ready' && !targets.length ? <Typography id="h5-move-none" variant="body2" sx={{ mt: 2 }}>{t('No linked machine can take this task.')}</Typography> : null}
        {dialog.stage === 'ready' && targets.length ? (
          <FormControl fullWidth size="small" sx={{ mt: 2.5 }}>
            <InputLabel id="h5-move-target-label">{t('Move to')}</InputLabel>
            <Select
              id="h5-move-target" labelId="h5-move-target-label" label={t('Move to')} value={chosen ? target : ''} disabled={dialog.busy}
              onChange={event => { setTarget(event.target.value); setAck(false); }}
              renderValue={value => {
                const item = targets.find(entry => entry.instance_id === value);
                return item ? (
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                    <span translate="no">{item.name}</span>
                    {item.company_computer ? <Pill label={t('Company computer')} tone="warning" /> : null}
                  </Box>
                ) : '';
              }}
            >
              {targets.map(item => (
                <MenuItem key={item.instance_id || item.name} value={item.instance_id || ''} disabled={Boolean(item.refusal)} className="h5-move-target-option">
                  <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                      <span translate="no">{item.name}</span>
                      {item.company_computer ? <Pill label={t('Company computer')} tone="warning" /> : null}
                    </Box>
                    {item.refusal ? <Typography variant="caption" color="text.secondary">{text(item.refusal.error)}</Typography> : null}
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}
        {crossTier ? (
          <>
            <Alert id="h5-move-tier" severity="warning" icon={false} sx={{ mt: 1.5 }}>
              {chosen.company_computer ? t('This puts personal files on a company computer.') : t('This moves files from a company computer to a personal machine.')}
            </Alert>
            <FormControlLabel
              sx={{ mt: 1, display: 'flex' }}
              control={<Checkbox checked={ack} disabled={dialog.busy} onChange={event => setAck(event.target.checked)} slotProps={{ input: { id: 'h5-move-ack' } }} />}
              label={t('I understand, move it anyway')}
            />
          </>
        ) : null}
        {busy ? <Typography id="h5-move-busy" variant="body2" color="warning.main" sx={{ mt: 1.5 }}>{busy === 1 ? t('An agent is working in 1 terminal; closing it stops its turn.') : t(`Agents are working in ${busy} terminals; closing them stops their turns.`)}</Typography> : null}
        {counts ? <Typography id="h5-move-counts" variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>{counts}</Typography> : null}
        {refusal ? <DialogError id="h5-move-refusal">{`${text(refusal.error)}${refusal.reason ? `: ${t(refusal.reason)}` : ''}`}</DialogError> : null}
        {dialog.error ? <DialogError id="h5-task-dialog-error">{`${text(dialog.error)}${dialog.reason ? `: ${t(dialog.reason)}` : ''}`}</DialogError> : null}
      </DialogContent>
      <DialogActions>
        <Button id="h5-task-dialog-cancel" onClick={close} disabled={dialog.busy}>{t('Cancel')}</Button>
        <Button id="h5-task-dialog-ok" variant="contained" disabled={!ready} onClick={() => void ui.actions.taskMoveStart({ target, tierAck: crossTier && ack })}>{t('Move')}</Button>
      </DialogActions>
    </Dialog>
  );
}
