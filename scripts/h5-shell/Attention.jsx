import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemButton from '@mui/material/ListItemButton';
import NativeSelect from '@mui/material/NativeSelect';
import OutlinedInput from '@mui/material/OutlinedInput';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha } from '@mui/material/styles';
import { Pill, deviceParts, deviceText, errorText, named, t } from './common.jsx';
import { DeviceTag } from './TaskDrawer.jsx';
import { shortName } from './task-order.mjs';
import { Field } from './Form.jsx';
import TextField from './TextField.jsx';
import { Icon } from './Icons.jsx';
import { AttentionGuide } from './AttentionGuide.jsx';
import { DRAG_SX, useListDrag } from './list-drag.jsx';
import {
  MAX_INDENT, PRIORITIES, PRIORITY_LABELS, REMIND_STATUSES, STATUSES, STATUS_LABELS, buildTree, childrenOf, collapseId, contextFilePath, contextOf, engineOf, groupItems,
  groupOf, hasTree, homeDetail, homeGroups, jumpBack, keyOf, moveLocal, onThisMachine, overdue, parentChoices, parseKey, patchFor, pendingLine, readCollapsed, rollbackItems,
  safeLink, shortTime, statusOfGroup, statusesOfGroup, stepMove, timeline,
} from './attention-model.mjs';

// T-Attention: the tasks agents and services report (through listener plugins, the `t-attention` CLI) and the user's own, in one list
// ("Attention" in row 2). Phone: a full-screen sheet; wide: the right side panel. The list and the live
// updates are in attention-feed.mjs (`state.attention`); this file only draws them and calls `ui.actions.attention*`. A tap on the circle marks a
// task done (from any status; on a done task it opens it again); a tap on the row opens the edit view (a dialog: title, notes, status, priority,
// due date, link, history, delete).
// Phone: the "Home view" of the t-attention skill (`homeGroups`, the grouping of `t-attention list --tree`, lib/attention-home.js): the sections Needs
// you (waiting_user, then review), Working and To do, each heading with a coloured dot (red, green, yellow; an empty section says "None"), whole trees
// (a tree is in the section of its most urgent open task, a sub-task always under its parent), each row with its own status pill, the section's
// detail line (Needs you: what you need to do; Working: custom status · notes; To do: nothing) and the time of its last change (MM-DD HH:MM). Then
// "Done: N" (grey dot): finished tasks are only counted; a tap unfolds them (the closed group of the wide panel), so they can be opened again.
// Wide: the groups Needs you, Review, Working, To do, Done & failed (folded); inside a group a sub-task is drawn under its parent (`buildTree`), one
// whose parent is in another group in its own group with a "↳ parent" hint; a row shows its custom status and result.
// A server with sub-tasks (`hasTree`): parents collapse, Review rows have Confirm / Reject and Needs you rows Handled, and a held row is dragged to
// reorder it among its siblings of the same status group (the server's order is per status) or dropped on another section's title to change its
// status (Needs you gives waiting_user, Done gives done; `POST /api/attention/:id/move`, useListDrag of list-drag.jsx). Every such change is drawn at
// once and put back when it fails.
// Several engines (`state.attention.engines`, attention-feed.mjs): one list, each group in engine blocks (this machine first), every row with the engine
// tag of the task list (`DeviceTag`) in front of its title; a row is named by its `key` (ids repeat between engines), every request goes to its engine,
// and a row is dragged only among the rows of its own engine. With one engine the panel looks as it always did (no tags, no "on <engine>").

const MONO = 'ui-monospace, Menlo, monospace';
const REASON_COLOR = { waiting_user: 'warning.light', review: 'info.light', failed: 'error.light' };
const PRIORITY_COLOR = { high: 'error.light', medium: 'warning.light', low: 'text.secondary' };

const INDENT_PX = 16; // one level of sub-tasks
const CIRCLE_X = 26; // the middle of the circle from the left edge of a row (its 44px button after 4px)
const ROW_SX = { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' };
const ACTION_SX = { minWidth: 0, px: 1.25, py: 0.25, fontSize: 13, lineHeight: 1.3, minHeight: 32 };
// The phone: the dot of a section heading (theme colours) and the tone of a status pill.
const SECTION_DOT = { needs_you: 'error.main', working: 'success.main', todo: 'warning.main', closed: 'text.disabled' };
const STATUS_TONE = { waiting_user: 'warning', review: 'info', working: 'success', done: 'success', failed: 'error' };
const PILL_SX = { height: 20, fontSize: 12, px: 1, flex: '0 0 auto' };
const DETAIL_COLOR = { reason: null, confirm: 'info.light', progress: 'text.secondary' };
function Dot({ section }) {
  return <Box component="span" className="h5-attention-dot" data-section={section} aria-hidden="true" sx={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', bgcolor: SECTION_DOT[section] || 'text.disabled' }} />;
}

// The second line of a row: the result of a task in Review or Done (when it has one), else what is pending (Needs you, Review, Failed).
function secondLine(item, fields) {
  if (fields && ['review', 'done'].includes(item.status) && item.result) return { kind: 'result', text: String(item.result) };
  if (REMIND_STATUSES.includes(item.status)) { const text = pendingLine(item); if (text) return { kind: 'reason', text }; }
  return null;
}

// One row. `node` (the tree, buildTree) gives its indent and, for a sub-task of a task in another group, that parent (`node.parent`, the "↳" hint);
// `fold` is the collapse button of a parent; `act` runs a row button (Confirm, Reject, Handled); `hold` are the drag props (useListDrag) or null.
// `section` (the phone): the key of the Home view section it is drawn in ('closed' in the unfolded Done list); the row then has its status pill, the
// section's detail line and its time.
function Row({ item, node, ui, onOpen, fields, fold, act, busy, hold, tag, section }) {
  const done = item.status === 'done';
  const home = Boolean(section);
  const detail = home ? homeDetail(item, section) : null;
  const second = home ? (fields && ['review', 'done'].includes(item.status) && item.result ? { kind: 'result', text: String(item.result) } : null) : secondLine(item, fields);
  const updated = home ? shortTime(item.updated_at) : '';
  const late = overdue(item);
  const toggle = async () => {
    try { await ui.actions.attentionUpdate(keyOf(item), { status: done ? 'todo' : 'done' }); }
    catch (error) { ui.notify(`${t('Could not update the task')}: ${error.message}`, 'error'); }
  };
  const mark = done ? 'Mark as not done' : 'Mark as done';
  const indent = node ? node.indent : 0;
  const actions = item.status === 'review' ? ['Confirm', 'Reject'] : item.status === 'waiting_user' ? ['Handled'] : [];
  const custom = fields && item.custom_status && !home ? String(item.custom_status) : '';
  return (
    <Box
      className="h5-attention-row" data-id={item.id} data-key={keyOf(item)} data-engine={engineOf(item)} data-status={item.status} data-depth={node ? node.depth : 0} {...(hold || {})}
      sx={{ display: 'flex', alignItems: 'flex-start', borderBottom: 1, borderColor: 'divider', pl: `${indent * INDENT_PX}px`, ...(hold ? ROW_SX : {}) }}
    >
      <IconButton className="h5-attention-check" {...named(t(mark))} aria-pressed={done} onClick={() => void toggle()} sx={{ flex: '0 0 auto', mt: 0.25, ml: 0.5, color: done ? 'success.light' : 'text.secondary' }}>
        <Icon name={done ? 'attentionDone' : 'attentionOpen'} size={22} />
      </IconButton>
      <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ListItemButton className="h5-attention-open" onClick={() => onOpen(keyOf(item))} sx={{ flex: '0 0 auto', minWidth: 0, display: 'block', py: 1, pl: 0.5, pr: fold ? 0.5 : 2 }}>
          {node && node.parent ? (
            <Box className="h5-attention-parent-hint" sx={{ fontSize: 12, lineHeight: 1.35, color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {'↳ '}{node.parent.title}
            </Box>
          ) : null}
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, minWidth: 0 }}>
            {tag ? <Box component="span" className="h5-attention-engine" sx={{ flex: '0 0 auto', display: 'inline-flex', mt: '0.5px' }}><DeviceTag device={tag} /></Box> : null}
            <Box className="h5-attention-title" sx={{ flex: '1 1 auto', minWidth: 0, fontSize: 15, lineHeight: 1.35, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', color: done || item.status === 'cancelled' ? 'text.secondary' : 'text.primary', textDecoration: done ? 'line-through' : 'none' }}>{item.title}</Box>
            {custom ? <Pill className="h5-attention-custom" label={custom} title={custom} tone="info" sx={{ flex: '0 1 auto', maxWidth: '45%', height: 20, mt: '1px', fontSize: 12, px: 1, display: 'inline-block', lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis' }} /> : null}
          </Box>
          {detail ? (
            <Box className={detail.kind === 'progress' ? 'h5-attention-progress' : 'h5-attention-reason'} data-kind={detail.kind} sx={{ mt: 0.25, fontSize: 13, lineHeight: 1.35, color: DETAIL_COLOR[detail.kind] || REASON_COLOR[item.status], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail.kind === 'confirm' ? t(detail.text) : detail.text}
            </Box>
          ) : null}
          {second ? <Box className={second.kind === 'result' ? 'h5-attention-result' : 'h5-attention-reason'} sx={{ mt: 0.25, fontSize: 13, lineHeight: 1.35, color: second.kind === 'result' ? 'text.secondary' : REASON_COLOR[item.status], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{second.text}</Box> : null}
          {home || (item.source && item.source !== 'user') || (item.priority && item.priority !== 'none') || item.due_date || item.status === 'failed' || item.status === 'cancelled' ? (
            <Box className={home ? 'h5-attention-meta' : undefined} sx={{ mt: 0.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 0.75, rowGap: 0.5, fontSize: 12, color: 'text.secondary' }}>
              {home ? <Pill className="h5-attention-status" data-status={item.status} label={t(STATUS_LABELS[item.status] || 'To do')} tone={STATUS_TONE[item.status] || 'default'} sx={PILL_SX} /> : null}
              {home && updated ? <Box component="span" className="h5-attention-updated" title={when(item.updated_at)} sx={{ fontVariantNumeric: 'tabular-nums' }}>{updated}</Box> : null}
              {item.source && item.source !== 'user' ? <Pill className="h5-attention-source" label={item.source} translate="no" sx={{ height: 20, fontSize: 12, px: 1 }} /> : null}
              {!home && (item.status === 'failed' || item.status === 'cancelled') ? <Box component="span" sx={{ color: item.status === 'failed' ? 'error.light' : 'text.secondary' }}>{t(STATUS_LABELS[item.status])}</Box> : null}
              {item.priority && item.priority !== 'none' ? <Box component="span" className="h5-attention-priority" sx={{ color: PRIORITY_COLOR[item.priority] }}>{t(PRIORITY_LABELS[item.priority])}</Box> : null}
              {item.due_date ? <Box component="span" className="h5-attention-due" data-late={late || undefined} sx={{ color: late ? 'error.light' : 'text.secondary' }}>{`${t('Due')} ${item.due_date}`}</Box> : null}
            </Box>
          ) : null}
        </ListItemButton>
        {actions.length && act ? (
          <Box className="h5-attention-actions" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, pl: 0.25, pb: 0.75, mt: -0.5 }}>
            {actions.map(name => (
              <Button
                key={name} className="h5-attention-action" data-action={name.toLowerCase()} size="small" variant="text" disabled={busy}
                color={name === 'Reject' ? 'inherit' : 'primary'} onClick={() => act(item, name)} sx={ACTION_SX}
              >{t(name)}</Button>
            ))}
          </Box>
        ) : null}
      </Box>
      {fold}
    </Box>
  );
}

// The collapse button of a task with sub-tasks (remembered per task, `h5-attention-collapsed`).
function Fold({ id, open, count, onToggle }) {
  const label = t(open ? 'Collapse sub-tasks' : 'Expand sub-tasks');
  return (
    <IconButton className="h5-attention-fold" data-id={id} {...named(label)} aria-expanded={open} onClick={() => onToggle(id)} sx={{ flex: '0 0 auto', mt: 0.25, mr: 0.5, color: 'text.secondary', gap: 0.25, fontSize: 12 }}>
      {open ? null : <Box component="span" className="h5-attention-fold-count" aria-hidden="true">{count}</Box>}
      <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}><Icon name="treeChevron" size={14} /></Box>
    </IconButton>
  );
}

// A task and, under it, its sub-tasks of the same group (the whole block moves with it). The sub-tasks' level has a thin guide line under the circle of
// their parent; past MAX_INDENT the rows are drawn at that indent without more lines.
function Node({ node, group, ctx }) {
  const { item, children } = node;
  const engine = engineOf(item);
  const open = !ctx.collapsed.has(collapseId(item));
  const count = children.length;
  const fold = count ? <Fold id={collapseId(item)} open={open} count={count} onToggle={ctx.toggleCollapsed} /> : null;
  const movable = ctx.hold && ctx.movable(engine);
  return (
    <Box className="h5-attention-node" data-id={item.id} data-key={keyOf(item)} data-engine={engine} data-group={group} data-status={item.status} data-sgroup={groupOf(item)} data-movable={movable ? 'true' : undefined} role="listitem" sx={{ position: 'relative' }}>
      <Row item={item} node={node} ui={ctx.ui} onOpen={ctx.onOpen} fields={ctx.fields(engine)} fold={fold} act={ctx.act} busy={ctx.busy.has(keyOf(item))} hold={movable ? ctx.hold() : null} tag={ctx.tagOf(engine)} section={ctx.home ? group : undefined} />
      {count && open ? (
        <Box
          className="h5-attention-level" data-level={`${group}:${collapseId(item)}`} role="list" aria-label={item.title}
          sx={{ position: 'relative', ...(node.depth < MAX_INDENT ? { '&::before': { content: '""', position: 'absolute', left: `${CIRCLE_X + node.indent * INDENT_PX}px`, top: 0, bottom: 0, borderLeft: 1, borderColor: 'divider', pointerEvents: 'none' } } : {}) }}
        >
          {children.map(child => <Node key={keyOf(child.item)} node={child} group={group} ctx={ctx} />)}
        </Box>
      ) : null}
    </Box>
  );
}

// Reject (a task in Review): an optional reason, then back to Working with a note "Rejected: <reason>".
function RejectDialog({ item, onCancel, onReject }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onCancel} aria-labelledby="h5-attention-reject-title" id="h5-attention-reject" slotProps={{ paper: { sx: { backgroundImage: 'none', m: 2, width: 'calc(100% - 32px)', maxWidth: 420 } } }}>
      <Box component="form" onSubmit={event => { event.preventDefault(); onReject(reason.trim()); }} sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography id="h5-attention-reject-title" variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>{t('Reject this result?')}</Typography>
        <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{item.title}</Typography>
        <Typography variant="body2" color="text.secondary">{t('The task goes back to Working.')}</Typography>
        <Field id="h5-attention-reject-reason" label="Reason (optional)" value={reason} onChange={event => setReason(event.target.value)} autoFocus htmlInput={{ maxLength: 400 }} />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button id="h5-attention-reject-cancel" color="inherit" onClick={onCancel}>{t('Cancel')}</Button>
          <Button id="h5-attention-reject-confirm" type="submit" variant="contained" color="warning">{t('Reject')}</Button>
        </Box>
      </Box>
    </Dialog>
  );
}

// The engine a new task goes to when more than one is listed (`h5-attention-add-on`, an engine key); this machine unless another was chosen.
const ADD_ON_KEY = 'h5-attention-add-on';

function QuickAdd({ ui, engines }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(() => readKey(ADD_ON_KEY) || 'local');
  // A choice that left the list (unlinked, hidden, offline) falls back to this machine, or the first engine that is left.
  const picked = engines.find(engine => engine.key === on) || engines.find(engine => engine.key === 'local') || engines[0];
  const engine = picked ? picked.key : 'local';
  const choose = key => { setOn(key); if (key === 'local') removeKey(ADD_ON_KEY); else writeKey(ADD_ON_KEY, key); };
  const submit = async event => {
    event.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    try { await ui.actions.attentionCreate({ title: text }, engine); setTitle(''); }
    catch (error) { ui.notify(`${t('Could not add the task')}: ${errorText(error)}`, 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Box component="form" id="h5-attention-add-form" onSubmit={event => void submit(event)} sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <OutlinedInput
        id="h5-attention-add-input" size="small" fullWidth value={title} onChange={event => setTitle(event.target.value)} placeholder={t('Add a task')} disabled={busy}
        inputProps={{ 'aria-label': t('Add a task'), maxLength: 300, enterKeyHint: 'done' }} sx={{ flex: '1 1 auto', fontSize: 15, minWidth: 0 }}
      />
      {engines.length > 1 ? (
        <NativeSelect
          value={engine} onChange={event => choose(event.target.value)} disabled={busy} disableUnderline
          inputProps={{ id: 'h5-attention-add-on', 'aria-label': t('Add on'), title: deviceText(picked) }}
          sx={{ flex: '0 0 auto', maxWidth: 120, fontSize: 13, color: 'text.secondary', '& select': { py: 0, minHeight: 44, boxSizing: 'border-box', display: 'flex', alignItems: 'center', textOverflow: 'ellipsis' } }}
        >
          {engines.map(entry => <option key={entry.key} value={entry.key}>{`${t('on')} ${entry.local && !entry.name ? deviceParts(entry).name : shortName(deviceParts(entry).name, 12)}`}</option>)}
        </NativeSelect>
      ) : null}
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
// A file of another engine's task (`engine`, 'remote:7') opens on that engine when it reads any path (h5.js `canOpenAnyPath`), else only its path shows.
export function contextFileAction(ui, absolute, engine = 'local') {
  if (!absolute) return null;
  if (engine !== 'local') return ui.actions.canOpenAnyPath && ui.actions.canOpenAnyPath(engine) ? () => ui.actions.openAnyPath(absolute, engine) : null;
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
  // The host of the item's own engine (the `host` of its list); its way back is a task of that engine in the one task list.
  const engine = engineOf(item);
  const owner = ((state.attention && state.attention.engines) || []).find(entry => entry.key === engine);
  const localHost = owner ? owner.host : engine === 'local' ? state.attention && state.attention.host : null;
  const here = onThisMachine(context, localHost);
  // `groups`: this machine's tasks of the one list, by group; `tasks`: every row of the one list (another engine's task is found there)
  const jump = jumpBack(context, { sourceKey: engine, groups: state.taskList && state.taskList.groups, tasks: state.taskList && state.taskList.tasks, localHost });
  const reply = String(context.last_reply || '').trim();
  const turns = Number(context.turns) || 0;
  const place = [context.cwd, context.branch].filter(Boolean);
  if (!context.goal && !reply && !pending && !files.length && !summary && !place.length && !jump) return null;
  const refresh = async () => {
    setAsking(true);
    try { await ui.actions.attentionSummarize(keyOf(item)); ui.notify(t('A new summary was asked for')); }
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
                const open = here ? contextFileAction(ui, absolute, engine) : null;
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
function Timeline({ events, titleOf }) {
  if (events === null) return <LinearProgress aria-label={t('Loading…')} />;
  const days = timeline(events, titleOf);
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
                  {entry.joined ? t(`${entry.key} ${entry.text}`) : entry.text ? `${t(entry.key)}: ${entry.text}` : t(entry.key)}
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
function EditDialog({ item, items, fields, movable, tag, state, wide, ui, onClose, onLeave, onOpen, onMove }) {
  const key = keyOf(item);
  const [form, setForm] = useState(() => ({
    title: item.title || '', notes: item.notes || '', status: item.status, priority: item.priority || 'none', due_date: item.due_date || '',
    ...(fields ? { custom_status: item.custom_status || '', result: item.result || '', parent_id: item.parent_id == null ? '' : String(item.parent_id) } : {}),
  }));
  const [events, setEvents] = useState(null); // null: loading
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    ui.actions.attentionDetail(key).then(data => { if (live) setEvents(Array.isArray(data && data.events) ? data.events : []); }).catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [key, item.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const save = async () => {
    const body = patchFor(item, form);
    if (!body) { onClose(); return; }
    if (body.title !== undefined && !body.title) { setError(t('The title cannot be empty')); return; }
    setBusy(true);
    setError('');
    try { await ui.actions.attentionUpdate(key, body); ui.notify(t('Saved'), 'success'); onClose(); }
    catch (failure) { setError(`${t('Could not save')}: ${failure.message}`); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await ui.actions.attentionDelete(key); setConfirming(false); ui.notify(t('Task deleted'), 'success'); onClose(); }
    catch (failure) {
      // A task with sub-tasks is refused (409 HAS_CHILDREN): they are deleted or moved first.
      const children = failure.status === 409 && failure.data && failure.data.error === 'HAS_CHILDREN';
      setError(children ? t('Delete or move its sub-tasks first') : `${t('Could not delete')}: ${errorText(failure)}`);
      setConfirming(false);
    }
    finally { setBusy(false); }
  };
  const link = safeLink(item.link_url);
  const children = fields ? childrenOf(items, key) : [];
  const choices = fields ? parentChoices(items, item) : []; // the tasks of its own engine only
  const titleOf = id => { const found = items.find(entry => entry.id === id && engineOf(entry) === engineOf(item)); return found ? found.title : ''; };
  const steps = movable ? [['up', 'Move up'], ['down', 'Move down'], ['top', 'Move to top']].map(([step, label]) => ({ step, label, move: stepMove(items, key, step) })) : [];
  return (
    <Dialog
      open onClose={onClose} fullScreen={!wide} fullWidth maxWidth="sm" aria-labelledby="h5-attention-edit-title" id="h5-attention-edit"
      slotProps={{ paper: { sx: { backgroundImage: 'none', ...(wide ? {} : { pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' }) } } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        <Typography id="h5-attention-edit-title" variant="subtitle1" component="h2" sx={{ flex: '0 1 auto', fontWeight: 600 }}>{t('Edit task')}</Typography>
        {tag ? <Box id="h5-attention-edit-engine" sx={{ display: 'inline-flex', minWidth: 0 }}><DeviceTag device={tag} /></Box> : null}
        <Box sx={{ flex: '1 1 auto' }} />
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
        {fields ? (
          <>
            <Field id="h5-attention-edit-custom" label="Custom status" value={form.custom_status} onChange={set('custom_status')} htmlInput={{ maxLength: 100 }} />
            <Field id="h5-attention-edit-result" label="Result" value={form.result} onChange={set('result')} multiline maxRows={4} htmlInput={{ maxLength: 500 }} />
            <TextField id="h5-attention-edit-parent" select label={t('Parent')} size="small" value={form.parent_id} onChange={set('parent_id')} slotProps={{ select: { native: true } }}>
              <option value="">{t('None')}</option>
              {choices.map(entry => <option key={entry.id} value={String(entry.id)}>{entry.title.length > 80 ? `${entry.title.slice(0, 79)}…` : entry.title}</option>)}
            </TextField>
          </>
        ) : null}
        {steps.length ? (
          <Box id="h5-attention-edit-move" role="group" aria-label={t('Order')} sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {steps.map(({ step, label, move }) => (
              <Button key={step} id={`h5-attention-move-${step}`} size="small" variant="outlined" color="inherit" disabled={!move} onClick={() => onMove(key, move)}>{t(label)}</Button>
            ))}
          </Box>
        ) : null}
        {children.length ? (
          <Box component="section" id="h5-attention-edit-children" aria-labelledby="h5-attention-children-title">
            <Typography id="h5-attention-children-title" variant="subtitle2" component="h3" sx={{ mb: 0.25 }}>{`${t('Sub-tasks')} (${children.length})`}</Typography>
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {children.map(child => (
                <Box component="li" key={keyOf(child)}>
                  <ButtonBase className="h5-attention-child" data-id={child.id} onClick={() => onOpen(keyOf(child))} sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, minHeight: 36, px: 0.5, borderRadius: 1, fontSize: 14, color: 'primary.light', textAlign: 'left', 'html[data-input="touch"] &': { minHeight: 44 } }}>
                    <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{child.title}</Box>
                    <Box component="span" sx={{ flex: '0 0 auto', fontSize: 12, color: 'text.secondary' }}>{t(STATUS_LABELS[child.status] || 'To do')}</Box>
                  </ButtonBase>
                </Box>
              ))}
            </Box>
          </Box>
        ) : null}
        {link ? (
          <Button
            id="h5-attention-edit-link" variant="outlined" component="a" href={link.url} startIcon={<Icon name="link" size={18} />}
            {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            sx={{ justifyContent: 'flex-start', overflowWrap: 'anywhere', textAlign: 'left' }}
          ><span translate="no">{item.link_label || item.link_url}</span></Button>
        ) : null}
        <Typography variant="caption" color="text.secondary" component="div" id="h5-attention-edit-meta" sx={{ overflowWrap: 'anywhere' }}>
          {`${t('Source')}: `}<span translate="no">{item.source || 'user'}</span>{tag ? <>{' · '}<span translate="no">{deviceText(tag)}</span></> : null}{item.created_at ? ` · ${t('Created')} ${when(item.created_at)}` : ''}{item.updated_at ? ` · ${t('Updated')} ${when(item.updated_at)}` : ''}
        </Typography>
        {error ? <Typography id="h5-attention-edit-error" role="alert" variant="body2" color="error">{error}</Typography> : null}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button id="h5-attention-edit-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
          <Button id="h5-attention-edit-delete" variant="outlined" color="error" disabled={busy} onClick={() => setConfirming(true)}>{t('Delete')}</Button>
        </Box>
        <Box component="section" aria-labelledby="h5-attention-history-title">
          <Typography id="h5-attention-history-title" variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>{t('History')}</Typography>
          <Timeline events={events} titleOf={titleOf} />
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

const COLLAPSED_KEY = 'h5-attention-collapsed'; // the ids of the parents whose sub-tasks are hidden (JSON list); default: shown
const readKey = key => { try { return localStorage.getItem(key); } catch { return null; } };
const writeKey = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };
const removeKey = key => { try { localStorage.removeItem(key); } catch { /* not remembered */ } };

// The drag of a T-Attention row (useListDrag, list-drag.jsx): a row is held (a finger 400 ms; a mouse held, or moved 4px) and moves among the rows drawn
// at its own level of its group (its siblings) of its own engine and status group (the server keeps one order per status; on the phone a level can
// hold several statuses), its sub-tasks with it; the title of a group or section whose statuses do not include the row's is a drop target. `move` is
// the panel's move. The rows of another engine are no place for it: dragged over them, its slot stays at the nearest edge of its own engine's block.
function attentionDrag(moveRef) {
  return {
    rows: list => [...list.querySelectorAll('.h5-attention-node[data-key]')],
    key: el => el.dataset.key,
    group: el => (el.parentElement && el.parentElement.dataset.level) || '',
    row: handle => handle.closest('.h5-attention-node'),
    peers: (list, row) => [...row.parentElement.querySelectorAll(':scope > .h5-attention-node[data-movable="true"]')].filter(el => el.dataset.engine === row.dataset.engine && el.dataset.sgroup === row.dataset.sgroup),
    head: row => row,
    floatClass: 'h5-task-float h5-attention-float',
    clamp: false,
    hold: true,
    ignore: '.h5-attention-check, .h5-attention-fold, .h5-attention-action',
    focus: () => null,
    dragging: null,
    tap: null, // a tap is the row's own click: it opens the edit view
    targets: (list, row) => [...list.querySelectorAll('.h5-attention-drop[data-group]')].filter(el => !statusesOfGroup(el.dataset.group).includes(row.dataset.status)),
    drop: (ui, s, others, say) => {
      const after = s.index >= others.length;
      const target = Number((after ? others[others.length - 1] : others[s.index]).el.dataset.id);
      moveRef.current(s.ref, after ? { after: target } : { before: target });
      say(t(`Moved to position ${s.index + 1} of ${s.rows.length}`));
    },
    dropOn: (ui, s, target) => {
      const status = statusOfGroup(target.dataset.group);
      if (status) moveRef.current(s.ref, { position: 'top', status }); // the status changes on the item's own engine
    },
  };
}
// The title of a group while a row is over it: tinted, dashed, with "→ <Status>".
const DROP_SX = theme => ({
  '& .h5-attention-drop-hint': { display: 'none' },
  '& .h5-attention-drop[data-drop-over]': { bgcolor: alpha(theme.palette.primary.main, 0.16), outline: `1.5px dashed ${alpha(theme.palette.primary.main, 0.7)}`, outlineOffset: '-3px', color: theme.palette.primary.light },
  '& .h5-attention-drop[data-drop-over] .h5-attention-drop-hint': { display: 'inline' },
});

// The phone list (the Home view): the sections with their dotted headings (each a drop target; empty: "None"), then "Done: N", which unfolds the
// finished tasks (`closed`, the closed group of `groupItems`) but the ones already drawn in a section (a finished parent kept above an open sub-task),
// so no task is drawn twice. `home` is `homeGroups`.
function HomeSections({ home, closed, items, movable, showClosed, setShowClosed, ctx }) {
  const hintOf = key => (movable ? <Box component="span" className="h5-attention-drop-hint" aria-hidden="true" sx={{ ml: 'auto', pl: 1 }}>{`\u2192 ${t(STATUS_LABELS[statusOfGroup(key)])}`}</Box> : null);
  const head = { px: 2, gap: 1, minHeight: 44, boxSizing: 'border-box', display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 600, borderBottom: 1, borderColor: 'divider' };
  const drawn = new Set();
  const walk = nodes => nodes.forEach(node => { drawn.add(keyOf(node.item)); walk(node.children); });
  home.sections.forEach(section => walk(section.nodes));
  const finished = closed ? closed.items.filter(item => !drawn.has(keyOf(item))) : [];
  const tree = showClosed ? buildTree(finished, items) : [];
  const count = finished.length;
  return (
    <>
      {home.sections.map(section => (
        <Box component="section" key={section.key} className="h5-attention-group" data-group={section.key} data-empty={section.nodes.length ? undefined : 'true'} aria-label={t(section.label)}>
          <Box className={movable ? 'h5-attention-group-title h5-attention-drop' : 'h5-attention-group-title'} data-group={section.key} sx={{ ...head, pt: 1, color: 'text.primary' }}>
            <Dot section={section.key} />
            <Box component="span" className="h5-attention-group-label" sx={{ minWidth: 0 }}>{t(section.label)}</Box>
            {hintOf(section.key)}
          </Box>
          {section.nodes.length ? (
            <Box className="h5-attention-level" data-level={`${section.key}:root`} role="list">
              {section.nodes.map(node => <Node key={keyOf(node.item)} node={node} group={section.key} ctx={ctx} />)}
            </Box>
          ) : (
            <Box className="h5-attention-none" sx={{ px: 2, py: 1.25, fontSize: 13, color: 'text.secondary', borderBottom: 1, borderColor: 'divider' }}>{t('None')}</Box>
          )}
        </Box>
      ))}
      <Box component="section" className="h5-attention-group" data-group="closed" data-empty={count ? undefined : 'true'} aria-label={t('Done & failed')}>
        <ButtonBase id="h5-attention-closed-toggle" className={movable ? 'h5-attention-drop' : undefined} data-group="closed" aria-expanded={showClosed} disabled={!count && !movable} onClick={() => setShowClosed(value => !value)} sx={{ ...head, width: '100%', justifyContent: 'flex-start', color: 'text.secondary' }}>
          <Dot section="closed" />
          <span className="h5-attention-group-title">{t(`Done: ${home.done}`)}</span>
          {count ? <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', transform: showClosed ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}><Icon name="treeChevron" size={14} /></Box> : null}
          {hintOf('closed')}
        </ButtonBase>
        {tree.length ? (
          <Box className="h5-attention-level" data-level="closed:root" role="list">
            {tree.map(node => <Node key={keyOf(node.item)} node={node} group="closed" ctx={ctx} />)}
          </Box>
        ) : null}
      </Box>
    </>
  );
}

// The scrolling list of the groups. It is drawn inside the sheet, so the drag (and its touchmove guard) is set up when the list is there. `home` (the
// phone): the Home view sections (`homeGroups`) instead of the groups.
function GroupList({ ui, attention, groups, home, items, fields, fieldsOf, movable, movableOf, tagOf, showClosed, setShowClosed, collapsed, toggleCollapsed, onOpen, act, busy, move, open }) {
  const listRef = useRef(null);
  const hostRef = useRef(null);
  const liveRef = useRef(null);
  const moveRef = useRef(move);
  moveRef.current = move;
  const spec = useMemo(() => attentionDrag(moveRef), []);
  const drag = useListDrag(listRef, hostRef, liveRef, ui, spec);
  const ctx = { ui, onOpen, fields: fieldsOf, movable: movableOf, tagOf, act, busy, collapsed, toggleCollapsed, hold: movable ? drag.hold : null, home: Boolean(home) };
  const failed = attention.status === 'ready' && Array.isArray(attention.failed) ? attention.failed : [];
  return (
    <Box sx={theme => ({ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', ...DRAG_SX(theme), ...DROP_SX(theme) })}>
      <Box id="h5-attention-body" ref={listRef} sx={{ position: 'relative', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', pb: 2 }}>
        {/* The first-run guide (AttentionGuide.jsx): shown until its steps are done or it is closed; read each time the panel opens. */}
        <AttentionGuide ui={ui} place="panel" active={open} />
        {attention.status === 'error' ? (
          <Box id="h5-attention-error" role="status" sx={{ p: 3, textAlign: 'center', color: 'text.secondary', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5 }}>
            <span>{t('Could not read the tasks')}</span>
            <Button id="h5-attention-retry" variant="outlined" onClick={() => ui.actions.attentionReload()}>{t('Try again')}</Button>
          </Box>
        ) : null}
        {/* An engine whose list could not be read (the others go on); it is read again as its stream reconnects. */}
        {failed.map(entry => (
          <Box key={entry.key} className="h5-attention-failed" data-engine={entry.key} role="status" sx={{ px: 2, py: 0.75, fontSize: 12, lineHeight: 1.4, color: 'text.secondary', borderBottom: 1, borderColor: 'divider', overflowWrap: 'anywhere' }}>
            {t(`Could not load ${entry.name}`)}
          </Box>
        ))}
        {attention.status === 'ready' && !items.length ? <Box id="h5-attention-empty" role="status" sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>{t('No tasks yet')}</Box> : null}
        {items.length && home ? (
          <HomeSections home={home} closed={groups.find(group => group.key === 'closed')} items={items} movable={movable} showClosed={showClosed} setShowClosed={setShowClosed} ctx={ctx} />
        ) : null}
        {items.length && !home ? groups.map(group => {
          const folded = group.folded && !showClosed;
          const head = `${t(group.label)} (${group.items.length})`;
          const status = statusOfGroup(group.key);
          const hint = movable ? <Box component="span" className="h5-attention-drop-hint" aria-hidden="true" sx={{ ml: 'auto', pl: 1 }}>{`\u2192 ${t(STATUS_LABELS[status])}`}</Box> : null;
          const tree = folded ? [] : buildTree(group.items, items);
          return (
            <Box component="section" key={group.key} className="h5-attention-group" data-group={group.key} data-empty={group.items.length ? undefined : 'true'} aria-label={t(group.label)}>
              {group.folded ? (
                <ButtonBase id="h5-attention-closed-toggle" className={movable ? 'h5-attention-drop' : undefined} data-group={group.key} aria-expanded={!folded} onClick={() => setShowClosed(value => !value)} sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, px: 2, minHeight: 44, fontSize: 13, fontWeight: 600, color: 'text.secondary', borderBottom: 1, borderColor: 'divider' }}>
                  <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', transform: folded ? 'none' : 'rotate(90deg)', transition: 'transform 120ms' }}><Icon name="treeChevron" size={14} /></Box>
                  <span className="h5-attention-group-title">{head}</span>
                  {hint}
                </ButtonBase>
              ) : (
                <Box className={movable ? 'h5-attention-group-title h5-attention-drop' : 'h5-attention-group-title'} data-group={group.key} sx={{ px: 2, pt: 1.5, pb: 0.5, minHeight: movable ? 44 : undefined, boxSizing: 'border-box', display: 'flex', alignItems: 'flex-end', fontSize: 13, fontWeight: 600, color: group.key === 'needs' ? 'warning.light' : 'text.secondary', borderBottom: 1, borderColor: 'divider', opacity: group.items.length ? 1 : 0.7 }}>
                  <span>{head}</span>{hint}
                </Box>
              )}
              {folded || !tree.length ? null : (
                <Box className="h5-attention-level" data-level={`${group.key}:root`} role="list">
                  {tree.map(node => <Node key={keyOf(node.item)} node={node} group={group.key} ctx={ctx} />)}
                </Box>
              )}
            </Box>
          );
        }) : null}
      </Box>
      {/* The floating copy of a dragged row goes in here (useListDrag); a move is announced in the live region. */}
      <Box ref={hostRef} />
      <Box ref={liveRef} role="status" aria-live="polite" sx={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }} />
    </Box>
  );
}

export function AttentionPanel({ state, ui }) {
  const attention = state.attention || {};
  const open = Boolean(attention.open);
  const side = Boolean(state.wide);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState(null); // the id of the task in the edit view
  const [rejecting, setRejecting] = useState(null); // the task whose Reject asks for a reason
  const [busy, setBusy] = useState(() => new Set()); // the ids with a row button on its way (one at a time per task)
  const busyRef = useRef(new Set());
  const [collapsed, setCollapsed] = useState(() => readCollapsed(readKey(COLLAPSED_KEY)));
  const items = attention.items || [];
  // The engines of the list, this machine first (attention-feed.mjs); with more than one every row has its engine tag.
  const engines = useMemo(() => (Array.isArray(attention.engines) && attention.engines.length ? attention.engines : [{ key: 'local', local: true, label: 'This machine', name: '' }]), [attention.engines]);
  const tagged = engines.length > 1;
  const tags = useMemo(() => new Map(engines.map(engine => [engine.key, engine])), [engines]);
  const tagOf = engine => (tagged ? tags.get(engine) || { key: engine, label: engine, name: '' } : null);
  // An engine with sub-tasks (its items have `parent_id`) gets the tree, the new fields and the drag; one without /move (`noMove`) has no drag.
  const treeEngines = useMemo(() => new Set(engines.map(engine => engine.key).filter(key => hasTree(items.filter(item => engineOf(item) === key)))), [engines, items]);
  const noMove = Array.isArray(attention.noMove) ? attention.noMove : [];
  const fields = treeEngines.size > 0;
  const fieldsOf = engine => treeEngines.has(engine);
  const movableOf = engine => treeEngines.has(engine) && !noMove.includes(engine);
  const movable = engines.some(engine => movableOf(engine.key));
  const order = useMemo(() => engines.map(engine => engine.key), [engines]);
  const groups = useMemo(() => groupItems(items, { keepEmpty: fields, engines: order }), [items, fields, order]);
  // The phone: the Home view of the t-attention skill (the same grouping as `t-attention list --tree`).
  const home = useMemo(() => (side ? null : homeGroups(items, { engines: order })), [side, items, order]);
  const close = () => { setEditing(null); ui.actions.closeAttention(); };
  // The item a key names, or a bare id (an older caller: a task of this machine).
  const find = ref => {
    if (ref == null) return null;
    const parsed = typeof ref === 'number' ? { engine: 'local', id: ref } : parseKey(ref);
    return items.find(entry => keyOf(entry) === ref) || (parsed ? items.find(entry => entry.id === parsed.id && engineOf(entry) === parsed.engine) : null) || null;
  };
  // Opened for one task: its edit view.
  useEffect(() => {
    if (!open || attention.focus == null) return;
    const found = find(attention.focus);
    if (found) { setEditing(keyOf(found)); ui.set(s => ({ attention: { ...s.attention, focus: null } })); }
  }, [open, attention.focus, items]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) { setEditing(null); setRejecting(null); } }, [open]);
  const item = editing == null ? null : items.find(entry => keyOf(entry) === editing);
  // The task went away: deleted, or its engine left the list (then nothing is said: it was not deleted).
  useEffect(() => {
    if (editing == null || item || attention.status !== 'ready') return;
    setEditing(null);
    const parsed = parseKey(editing);
    if (!parsed || tags.has(parsed.engine)) ui.notify(t('This task was deleted'));
  }, [editing, item]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleCollapsed = id => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeKey(COLLAPSED_KEY, JSON.stringify([...next]));
    return next;
  });
  const now = () => (ui.get().attention && ui.get().attention.items) || [];
  // A change drawn at once: `make` turns the list into the one shown until the answer; a failure puts the touched tasks back and says why.
  const optimistic = async (make, run, failure) => {
    const before = now();
    const shown = make(before);
    if (shown) ui.actions.attentionShow(shown);
    try { return await run(); }
    catch (error) {
      if (shown) ui.actions.attentionShow(rollbackItems(now(), before, shown));
      ui.notify(`${t(failure)}: ${errorText(error)}`, 'error');
      return null;
    }
  };
  const move = (key, body) => optimistic(list => moveLocal(list, key, body), () => ui.actions.attentionMove(key, body), 'Could not move the task');
  // The row buttons: Confirm (Review → Done), Reject (Review → Working, with a note), Handled (Needs you → Working, with a note). One request at a time.
  // `key`: the item's key (ids repeat between engines); the request goes to its engine.
  const send = async (key, body) => {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    try {
      await optimistic(
        list => list.map(entry => (keyOf(entry) === key ? { ...entry, status: body.status, ...(body.attention_reason === null ? { attention_reason: null } : {}) } : entry)),
        () => ui.actions.attentionUpdate(key, body), 'Could not update the task',
      );
    } finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  };
  const act = (entry, name) => {
    const key = keyOf(entry);
    if (busyRef.current.has(key)) return;
    if (name === 'Confirm') void send(key, { status: 'done' });
    else if (name === 'Handled') void send(key, { status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } });
    else if (name === 'Reject') setRejecting(key);
  };
  const reject = reason => {
    const key = rejecting;
    setRejecting(null);
    if (key != null) void send(key, { status: 'working', attention_reason: null, activity: { kind: 'note', text: reason ? `Rejected: ${reason}` : 'Rejected' } });
  };
  const rejectItem = rejecting == null ? null : items.find(entry => keyOf(entry) === rejecting);

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
      {/* A new task can go to this machine and to every engine whose list was read. */}
      <QuickAdd ui={ui} engines={engines.filter(engine => engine.key === 'local' || engine.ready)} />
      {attention.status === 'loading' ? <LinearProgress id="h5-attention-loading" aria-label={t('Loading…')} sx={{ flex: '0 0 auto' }} /> : null}
      <GroupList
        ui={ui} attention={attention} groups={groups} home={home} items={items} fields={fields} fieldsOf={fieldsOf} movable={movable} movableOf={movableOf} tagOf={tagOf} showClosed={showClosed} setShowClosed={setShowClosed}
        collapsed={collapsed} toggleCollapsed={toggleCollapsed} onOpen={setEditing} act={act} busy={busy} move={move} open={open}
      />
      {rejectItem ? <RejectDialog key={keyOf(rejectItem)} item={rejectItem} onCancel={() => setRejecting(null)} onReject={reject} /> : null}
      {/* onLeave: the user goes to a terminal or a file from the context card; the edit view closes, and on a phone the sheet too. */}
      {item ? (
        <EditDialog
          key={keyOf(item)} item={item} items={items} fields={fieldsOf(engineOf(item))} movable={movableOf(engineOf(item))} tag={tagOf(engineOf(item))} state={state} wide={side} ui={ui} onClose={() => setEditing(null)}
          onLeave={() => { setEditing(null); if (!side) ui.actions.closeAttention(); }} onOpen={setEditing} onMove={move}
        />
      ) : null}
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
