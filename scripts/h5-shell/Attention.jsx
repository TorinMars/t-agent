import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemButton from '@mui/material/ListItemButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Pill, errorText, named, t } from './common.jsx';
import { Field } from './Form.jsx';
import TextField from './TextField.jsx';
import { Icon } from './Icons.jsx';
import { PRIORITIES, PRIORITY_LABELS, REMIND_STATUSES, STATUSES, STATUS_LABELS, contextFilePath, contextOf, groupItems, jumpBack, onThisMachine, overdue, patchFor, pendingLine, safeLink, timeline } from './attention-model.mjs';

// T-Attention: the tasks agents and services report (through listener plugins, the `t-attention` CLI) and the user's own, in one list
// ("Attention" in row 2). Phone: a full-screen sheet; wide: the right side panel (like the file viewer and the file tree). The list and the live
// updates are in attention-feed.mjs (`state.attention`); this file only draws them and calls `ui.actions.attention*`. Groups: Needs you, Review,
// Working, To do, Done & failed (folded). A tap on the circle marks a task done (from any status; on a done task it opens it again); a tap on
// the row opens the edit view (a dialog: title, notes, status, priority, due date, link, history, delete).

const MONO = 'ui-monospace, Menlo, monospace';
const REASON_COLOR = { waiting_user: 'warning.light', review: 'info.light', failed: 'error.light' };
const PRIORITY_COLOR = { high: 'error.light', medium: 'warning.light', low: 'text.secondary' };

function Row({ item, ui, onOpen }) {
  const done = item.status === 'done';
  // A row that needs the user shows what is pending (the context), else the reason.
  const reason = REMIND_STATUSES.includes(item.status) && pendingLine(item);
  const late = overdue(item);
  const toggle = async () => {
    try { await ui.actions.attentionUpdate(item.id, { status: done ? 'todo' : 'done' }); }
    catch (error) { ui.notify(`${t('Could not update the task')}: ${error.message}`, 'error'); }
  };
  const mark = done ? 'Mark as not done' : 'Mark as done';
  return (
    <Box className="h5-attention-row" data-id={item.id} data-status={item.status} role="listitem" sx={{ display: 'flex', alignItems: 'flex-start', borderBottom: 1, borderColor: 'divider' }}>
      <IconButton className="h5-attention-check" {...named(t(mark))} aria-pressed={done} onClick={() => void toggle()} sx={{ flex: '0 0 auto', mt: 0.25, ml: 0.5, color: done ? 'success.light' : 'text.secondary' }}>
        <Icon name={done ? 'attentionDone' : 'attentionOpen'} size={22} />
      </IconButton>
      <ListItemButton className="h5-attention-open" onClick={() => onOpen(item.id)} sx={{ flex: '1 1 auto', minWidth: 0, display: 'block', py: 1, pl: 0.5, pr: 2 }}>
        <Box className="h5-attention-title" sx={{ fontSize: 15, lineHeight: 1.35, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', color: done || item.status === 'cancelled' ? 'text.secondary' : 'text.primary', textDecoration: done ? 'line-through' : 'none' }}>{item.title}</Box>
        {reason ? <Box className="h5-attention-reason" sx={{ mt: 0.25, fontSize: 13, lineHeight: 1.35, color: REASON_COLOR[item.status], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reason}</Box> : null}
        {(item.source && item.source !== 'user') || (item.priority && item.priority !== 'none') || item.due_date || item.status === 'failed' || item.status === 'cancelled' ? (
          <Box sx={{ mt: 0.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, fontSize: 12, color: 'text.secondary' }}>
            {item.source && item.source !== 'user' ? <Pill className="h5-attention-source" label={item.source} translate="no" sx={{ height: 20, fontSize: 12, px: 1 }} /> : null}
            {item.status === 'failed' || item.status === 'cancelled' ? <Box component="span" sx={{ color: item.status === 'failed' ? 'error.light' : 'text.secondary' }}>{t(STATUS_LABELS[item.status])}</Box> : null}
            {item.priority && item.priority !== 'none' ? <Box component="span" className="h5-attention-priority" sx={{ color: PRIORITY_COLOR[item.priority] }}>{t(PRIORITY_LABELS[item.priority])}</Box> : null}
            {item.due_date ? <Box component="span" className="h5-attention-due" data-late={late || undefined} sx={{ color: late ? 'error.light' : 'text.secondary' }}>{`${t('Due')} ${item.due_date}`}</Box> : null}
          </Box>
        ) : null}
      </ListItemButton>
    </Box>
  );
}

function QuickAdd({ ui }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    try { await ui.actions.attentionCreate({ title: text }); setTitle(''); }
    catch (error) { ui.notify(`${t('Could not add the task')}: ${error.message}`, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Box component="form" id="h5-attention-add-form" onSubmit={event => void submit(event)} sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <OutlinedInput
        id="h5-attention-add-input" size="small" fullWidth value={title} onChange={event => setTitle(event.target.value)} placeholder={t('Add a task')} disabled={busy}
        inputProps={{ 'aria-label': t('Add a task'), maxLength: 300, enterKeyHint: 'done' }} sx={{ fontSize: 15 }}
      />
      <IconButton id="h5-attention-add" type="submit" {...named(t('Add task'))} disabled={busy || !title.trim()}><Icon name="add" size={22} /></IconButton>
    </Box>
  );
}

const when = value => { const at = Date.parse(value || ''); return Number.isFinite(at) ? new Date(at).toLocaleString() : ''; };
const clock = value => { const at = Date.parse(value || ''); return Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
const dayLabel = day => { const at = Date.parse(`${day}T12:00:00`); return Number.isFinite(at) ? new Date(at).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : day; };
const CODE = { m: 0, p: 1, borderRadius: 1, bgcolor: 'action.hover', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflowY: 'auto' };
const HEAD = { fontSize: 12, fontWeight: 600, color: 'text.secondary', textTransform: 'none', mb: 0.25 };

// THE place that opens a file named by a task's context (a file of this machine: the card checks context.host first). With the preview of any
// path (h5.js `ui.actions.openAnyPath`: GET /api/fs/content of the local Engine) every absolute path opens; without it a file opens in the file
// sheet when it lies inside the working directory of a task of this machine (h5.js `openLocalPath`), else only its path is shown. Returns the
// action, or null when the file cannot be opened here.
export function contextFileAction(ui, absolute) {
  if (!absolute) return null;
  if (typeof ui.actions.openAnyPath === 'function') return () => ui.actions.openAnyPath(absolute);
  if (ui.actions.canOpenLocalPath && ui.actions.canOpenLocalPath(absolute)) return () => ui.actions.openLocalPath(absolute);
  return null;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* plain HTTP: the old way */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

// The context card at the top of the edit view: what the task is, how far it got, what it needs, the AI summary, where it runs, and the way back.
function ContextCard({ item, state, ui, onLeave }) {
  const context = contextOf(item);
  const [asking, setAsking] = useState(false);
  const pending = context.pending && context.pending.text ? context.pending : null;
  const files = Array.isArray(context.files) ? context.files.slice(0, 50) : [];
  const summary = context.summary && context.summary.text ? context.summary : null;
  const localHost = state.attention && state.attention.host;
  const here = onThisMachine(context, localHost);
  const jump = jumpBack(context, { sourceKey: state.sourceKey, groups: state.taskList && state.taskList.groups, localHost });
  const reply = String(context.last_reply || '').trim();
  const turns = Number(context.turns) || 0;
  const place = [context.cwd, context.branch].filter(Boolean);
  if (!context.goal && !reply && !pending && !files.length && !summary && !place.length && !jump) return null;
  const refresh = async () => {
    setAsking(true);
    try { await ui.actions.attentionSummarize(item.id); ui.notify(t('A new summary was asked for')); }
    catch (error) { ui.notify(`${t('Could not ask for a summary')}: ${errorText(error)}`, 'error'); }
    finally { setAsking(false); }
  };
  const go = async () => {
    if (jump.kind === 'terminal') { onLeave(); ui.actions.openRow(jump.taskId, { kind: 'terminal', id: jump.terminalId }); return; }
    ui.notify(t((await copyText(jump.command)) ? 'Resume command copied' : 'Could not copy. Select the text and copy it by hand'), 'success');
  };
  return (
    <Box id="h5-attention-context" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider', bgcolor: 'rgba(255,255,255,.02)' }}>
      {pending ? (
        <Box id="h5-attention-context-pending" sx={{ color: REASON_COLOR.waiting_user }}>
          <Box sx={{ ...HEAD, color: 'warning.light' }}>{t('Needs you')}</Box>
          <Box sx={{ fontSize: 14, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', color: 'text.primary' }}>{pending.text}</Box>
          {pending.command ? <Box component="pre" id="h5-attention-context-command" translate="no" sx={{ ...CODE, mt: 0.75 }}>{pending.command}</Box> : null}
        </Box>
      ) : null}
      {summary ? (
        <Box id="h5-attention-context-summary">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ ...HEAD, flex: '1 1 auto', mb: 0 }}>{t('AI summary')}</Box>
            <Button id="h5-attention-summary-refresh" size="small" disabled={asking} onClick={() => void refresh()}>{t('Refresh')}</Button>
          </Box>
          <Box sx={{ fontSize: 14, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{summary.text}</Box>
          <Box sx={{ fontSize: 12, color: 'text.secondary' }}>{when(summary.at)}{summary.model ? ' \u00b7 ' : ''}<span translate="no">{summary.model || ''}</span></Box>
        </Box>
      ) : null}
      {context.goal ? (
        <Box id="h5-attention-context-goal">
          <Box sx={HEAD}>{t('Goal')}</Box>
          <Box sx={{ fontSize: 14, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{context.goal}</Box>
        </Box>
      ) : null}
      {reply || files.length || turns ? (
        <Box id="h5-attention-context-progress">
          <Box sx={HEAD}>{t('Progress')}</Box>
          {reply ? <Box sx={{ fontSize: 14, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{reply}</Box> : null}
          <Box sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}>
            {[when(context.turn_started_at || item.updated_at), turns ? `${t('Turns')}: ${turns}` : ''].filter(Boolean).join(' \u00b7 ')}
          </Box>
          {files.length && !here ? (
            <Box id="h5-attention-context-elsewhere" sx={{ fontSize: 12, color: 'text.secondary', mt: 0.75, overflowWrap: 'anywhere' }}>{t(`These files are on ${context.host}; only their paths are shown here`)}</Box>
          ) : null}
          {files.length ? (
            <Box component="ul" id="h5-attention-context-files" aria-label={t('Changed files')} sx={{ listStyle: 'none', m: 0, mt: 0.75, p: 0 }}>
              {files.map(file => {
                const absolute = contextFilePath(context, file);
                const open = here ? contextFileAction(ui, absolute) : null;
                const counts = (
                  <Box component="span" sx={{ flex: '0 0 auto', fontFamily: MONO, fontSize: 12 }}>
                    <Box component="span" sx={{ color: 'success.light' }}>{`+${Number(file.added) || 0}`}</Box>{' '}
                    <Box component="span" sx={{ color: 'error.light' }}>{`\u2212${Number(file.deleted) || 0}`}</Box>
                  </Box>
                );
                const name = <Box component="span" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, fontFamily: MONO, fontSize: 12.5, color: open ? 'primary.light' : 'text.secondary', textDecoration: open ? 'underline' : 'none', textUnderlineOffset: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}><bdi>{file.path}</bdi></Box>;
                return (
                  <Box component="li" key={file.path} className="h5-attention-file" data-path={file.path} data-open={open ? 'true' : undefined}>
                    {open ? (
                      <ButtonBase onClick={() => { onLeave(); open(); }} title={absolute} sx={{ width: '100%', display: 'flex', gap: 1, alignItems: 'center', minHeight: 36, px: 0.5, borderRadius: 1, color: 'primary.light', 'html[data-input="touch"] &': { minHeight: 44 } }}>{name}{counts}</ButtonBase>
                    ) : (
                      <Box title={absolute || file.path} sx={{ display: 'flex', gap: 1, alignItems: 'center', minHeight: 32, px: 0.5 }}>{name}{counts}</Box>
                    )}
                  </Box>
                );
              })}
            </Box>
          ) : null}
        </Box>
      ) : null}
      {place.length ? (
        <Box id="h5-attention-context-place" translate="no" sx={{ fontFamily: MONO, fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {context.cwd || ''}{context.branch ? `${context.cwd ? ' \u00b7 ' : ''}${context.branch}` : ''}{context.host ? ` \u00b7 ${context.host}` : ''}
        </Box>
      ) : null}
      {jump ? (
        <Button id="h5-attention-jump" variant="outlined" onClick={() => void go()} sx={{ alignSelf: 'flex-start' }} title={jump.kind === 'copy' ? jump.command : undefined}>
          {t(jump.kind === 'terminal' ? 'Open terminal' : 'Copy resume command')}
        </Button>
      ) : null}
    </Box>
  );
}

// The history as a timeline: readable sentences with their times, grouped by day, the newest last.
function Timeline({ events }) {
  if (events === null) return <LinearProgress aria-label={t('Loading…')} />;
  const days = timeline(events);
  if (!days.length) return <Typography variant="body2" color="text.secondary">{t('No history yet')}</Typography>;
  return (
    <Box id="h5-attention-history">
      {days.map(day => (
        <Box key={day.day || 'none'} className="h5-attention-day" data-day={day.day}>
          <Box sx={{ fontSize: 12, fontWeight: 600, color: 'text.secondary', pt: 1, pb: 0.25 }}>{day.day ? dayLabel(day.day) : ''}</Box>
          <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {day.items.map(entry => (
              <Box component="li" key={entry.id} className="h5-attention-event" data-kind={entry.kind} sx={{ display: 'flex', gap: 1, py: 0.5, borderBottom: 1, borderColor: 'divider', fontSize: 13 }}>
                <Box component="span" sx={{ flex: '0 0 auto', color: 'text.secondary', fontVariantNumeric: 'tabular-nums', minWidth: 44 }}>{clock(entry.at)}</Box>
                <Box component="span" className="h5-attention-sentence" sx={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                  {entry.text ? `${t(entry.key)}: ${entry.text}` : t(entry.key)}
                  {entry.actor && ['status', 'created', 'updated', 'deleted'].includes(entry.kind) ? <Box component="span" translate="no" sx={{ color: 'text.secondary' }}>{` \u00b7 ${entry.actor}`}</Box> : null}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// The edit view of one task. The form starts from the item; Save sends only the changed fields (PATCH). The history is read when it opens.
function EditDialog({ item, state, wide, ui, onClose, onLeave }) {
  const [form, setForm] = useState(() => ({ title: item.title || '', notes: item.notes || '', status: item.status, priority: item.priority || 'none', due_date: item.due_date || '' }));
  const [events, setEvents] = useState(null); // null: loading
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    ui.actions.attentionDetail(item.id).then(data => { if (live) setEvents(Array.isArray(data && data.events) ? data.events : []); }).catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [item.id, item.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const save = async () => {
    const body = patchFor(item, form);
    if (!body) { onClose(); return; }
    if (body.title !== undefined && !body.title) { setError(t('The title cannot be empty')); return; }
    setBusy(true);
    setError('');
    try { await ui.actions.attentionUpdate(item.id, body); ui.notify(t('Saved'), 'success'); onClose(); }
    catch (failure) { setError(`${t('Could not save')}: ${failure.message}`); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await ui.actions.attentionDelete(item.id); setConfirming(false); ui.notify(t('Task deleted'), 'success'); onClose(); }
    catch (failure) { setError(`${t('Could not delete')}: ${failure.message}`); setConfirming(false); }
    finally { setBusy(false); }
  };
  const link = safeLink(item.link_url);
  return (
    <Dialog
      open onClose={onClose} fullScreen={!wide} fullWidth maxWidth="sm" aria-labelledby="h5-attention-edit-title" id="h5-attention-edit"
      slotProps={{ paper: { sx: { backgroundImage: 'none', ...(wide ? {} : { pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' }) } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <Typography id="h5-attention-edit-title" variant="subtitle1" component="h2" sx={{ flex: '1 1 auto', fontWeight: 600 }}>{t('Edit task')}</Typography>
        <IconButton id="h5-attention-edit-close" {...named(t('Close'))} onClick={onClose}><Icon name="close" size={22} /></IconButton>
      </Box>
      <Box sx={{ flex: '1 1 auto', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, px: 2, pt: 2.5, pb: 2 }}>
        <ContextCard item={item} state={state} ui={ui} onLeave={onLeave} />
        {REMIND_STATUSES.includes(item.status) && item.attention_reason && !(contextOf(item).pending && contextOf(item).pending.text) ? (
          <Box id="h5-attention-edit-reason" sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: REASON_COLOR[item.status], color: REASON_COLOR[item.status], fontSize: 14, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{item.attention_reason}</Box>
        ) : null}
        <Field id="h5-attention-edit-name" label="Title" value={form.title} onChange={set('title')} htmlInput={{ maxLength: 300 }} />
        <Field id="h5-attention-edit-notes" label="Notes" value={form.notes} onChange={set('notes')} multiline minRows={3} maxRows={12} htmlInput={{ maxLength: 20000 }} />
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', '& > *': { flex: '1 1 140px' } }}>
          <TextField id="h5-attention-edit-status" select label={t('Status')} size="small" value={form.status} onChange={set('status')} slotProps={{ select: { native: true } }}>
            {STATUSES.map(status => <option key={status} value={status}>{t(STATUS_LABELS[status])}</option>)}
          </TextField>
          <TextField id="h5-attention-edit-priority" select label={t('Priority')} size="small" value={form.priority} onChange={set('priority')} slotProps={{ select: { native: true } }}>
            {PRIORITIES.map(priority => <option key={priority} value={priority}>{t(PRIORITY_LABELS[priority])}</option>)}
          </TextField>
          <TextField id="h5-attention-edit-due" label={t('Due date')} size="small" type="date" value={form.due_date} onChange={set('due_date')} slotProps={{ inputLabel: { shrink: true } }} />
        </Box>
        {link ? (
          <Button
            id="h5-attention-edit-link" variant="outlined" component="a" href={link.url} startIcon={<Icon name="link" size={18} />}
            {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            sx={{ justifyContent: 'flex-start', overflowWrap: 'anywhere', textAlign: 'left' }}
          ><span translate="no">{item.link_label || item.link_url}</span></Button>
        ) : null}
        <Typography variant="caption" color="text.secondary" component="div" id="h5-attention-edit-meta" sx={{ overflowWrap: 'anywhere' }}>
          {`${t('Source')}: `}<span translate="no">{item.source || 'user'}</span>{item.created_at ? ` · ${t('Created')} ${when(item.created_at)}` : ''}{item.updated_at ? ` · ${t('Updated')} ${when(item.updated_at)}` : ''}
        </Typography>
        {error ? <Typography id="h5-attention-edit-error" role="alert" variant="body2" color="error">{error}</Typography> : null}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button id="h5-attention-edit-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
          <Button id="h5-attention-edit-delete" variant="outlined" color="error" disabled={busy} onClick={() => setConfirming(true)}>{t('Delete')}</Button>
        </Box>
        <Box component="section" aria-labelledby="h5-attention-history-title">
          <Typography id="h5-attention-history-title" variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>{t('History')}</Typography>
          <Timeline events={events} />
        </Box>
      </Box>
      <Dialog open={confirming} onClose={() => setConfirming(false)} aria-labelledby="h5-attention-delete-title" id="h5-attention-delete" slotProps={{ paper: { sx: { backgroundImage: 'none', m: 2 } } }}>
        <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography id="h5-attention-delete-title" variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>{t('Delete this task?')}</Typography>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{item.title}</Typography>
          <Typography variant="body2" color="text.secondary">{t('The task and its history are deleted for good.')}</Typography>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button id="h5-attention-delete-cancel" color="inherit" onClick={() => setConfirming(false)}>{t('Cancel')}</Button>
            <Button id="h5-attention-delete-confirm" variant="contained" color="error" disabled={busy} onClick={() => void remove()}>{t('Delete')}</Button>
          </Box>
        </Box>
      </Dialog>
    </Dialog>
  );
}

export function AttentionPanel({ state, ui }) {
  const attention = state.attention || {};
  const open = Boolean(attention.open);
  const side = Boolean(state.wide);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState(null); // the id of the task in the edit view
  const items = attention.items || [];
  const groups = useMemo(() => groupItems(items), [items]);
  const close = () => { setEditing(null); ui.actions.closeAttention(); };
  // Opened for one task (a system notification was tapped): its edit view.
  useEffect(() => {
    if (!open || attention.focus == null) return;
    if (items.some(item => item.id === attention.focus)) { setEditing(attention.focus); ui.set(s => ({ attention: { ...s.attention, focus: null } })); }
  }, [open, attention.focus, items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) setEditing(null); }, [open]);
  const item = editing == null ? null : items.find(entry => entry.id === editing);
  useEffect(() => { if (editing != null && !item && attention.status === 'ready') { setEditing(null); ui.notify(t('This task was deleted')); } }, [editing, item]); // eslint-disable-line react-hooks/exhaustive-deps

  const contents = (
    <>
      <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography id="h5-attention-title" variant="subtitle1" component="h2" translate="no" sx={{ fontWeight: 600, lineHeight: 1.3 }}>T-Attention</Typography>
          <Typography id="h5-attention-state" variant="caption" component="div" color="text.secondary" sx={{ lineHeight: 1.3, minHeight: '1.3em' }}>
            {attention.status === 'ready' && !attention.live ? t('Not live: reconnecting…') : ' '}
          </Typography>
        </Box>
        <IconButton id="h5-attention-close" {...named(t('Close'))} onClick={close}><Icon name="close" size={22} /></IconButton>
      </Box>
      <QuickAdd ui={ui} />
      {attention.status === 'loading' ? <LinearProgress id="h5-attention-loading" aria-label={t('Loading…')} sx={{ flex: '0 0 auto' }} /> : null}
      <Box id="h5-attention-body" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', pb: 2 }}>
        {attention.status === 'error' ? (
          <Box id="h5-attention-error" role="status" sx={{ p: 3, textAlign: 'center', color: 'text.secondary', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <span>{t('Could not read the tasks')}</span>
            <Button id="h5-attention-retry" variant="outlined" onClick={() => ui.actions.attentionReload()}>{t('Try again')}</Button>
          </Box>
        ) : null}
        {attention.status === 'ready' && !groups.length ? <Box id="h5-attention-empty" role="status" sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>{t('No tasks yet')}</Box> : null}
        {groups.map(group => {
          const folded = group.folded && !showClosed;
          const head = `${t(group.label)} (${group.items.length})`;
          return (
            <Box component="section" key={group.key} className="h5-attention-group" data-group={group.key} aria-label={t(group.label)}>
              {group.folded ? (
                <ButtonBase id="h5-attention-closed-toggle" aria-expanded={!folded} onClick={() => setShowClosed(value => !value)} sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, px: 2, minHeight: 44, fontSize: 13, fontWeight: 600, color: 'text.secondary', borderBottom: 1, borderColor: 'divider' }}>
                  <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', transform: folded ? 'none' : 'rotate(90deg)', transition: 'transform 120ms' }}><Icon name="treeChevron" size={14} /></Box>
                  <span className="h5-attention-group-title">{head}</span>
                </ButtonBase>
              ) : (
                <Box className="h5-attention-group-title" sx={{ px: 2, pt: 1.5, pb: 0.5, fontSize: 13, fontWeight: 600, color: group.key === 'needs' ? 'warning.light' : 'text.secondary', borderBottom: 1, borderColor: 'divider' }}>{head}</Box>
              )}
              {folded ? null : <Box role="list">{group.items.map(entry => <Row key={entry.id} item={entry} ui={ui} onOpen={setEditing} />)}</Box>}
            </Box>
          );
        })}
      </Box>
      {/* onLeave: the user goes to a terminal or a file from the context card; the edit view closes, and on a phone the sheet too. */}
      {item ? <EditDialog key={item.id} item={item} state={state} wide={side} ui={ui} onClose={() => setEditing(null)} onLeave={() => { setEditing(null); if (!side) ui.actions.closeAttention(); }} /> : null}
    </>
  );
  if (side) {
    // A wide screen: a panel on the right beside the terminal (html[data-side-panel], so the terminal refits once). Escape inside it closes it;
    // keys inside it are never sent to the terminal (h5.js).
    return (
      <Drawer
        variant="persistent" anchor="right" id="h5-attention-sheet" open={open} transitionDuration={reduced ? 0 : undefined}
        slotProps={{ paper: { className: 'h5-attention-panel h5-design-side', role: 'complementary', 'aria-labelledby': 'h5-attention-title', onKeyDown: event => { if (event.key === 'Escape' && event.currentTarget.contains(event.target)) { event.stopPropagation(); close(); } }, sx: { width: 'var(--h5-side-width)', height: '100%', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: 1, borderColor: 'divider' } } }}
      >
        {contents}
      </Drawer>
    );
  }
  // A phone: a full-screen sheet from the bottom. It is a modal: Escape, the Android back button (back.mjs) close it, the edit view first.
  return (
    <Drawer
      anchor="bottom" id="h5-attention-sheet" open={open} onClose={close} transitionDuration={reduced ? 0 : undefined}
      ModalProps={{ disableScrollLock: true }}
      slotProps={{ paper: { className: 'h5-attention-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'h5-attention-title', sx: { height: '100dvh', width: '100%', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' } } }}
    >
      {contents}
    </Drawer>
  );
}
