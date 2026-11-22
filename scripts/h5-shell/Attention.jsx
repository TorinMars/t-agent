import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemButton from '@mui/material/ListItemButton';
import NativeSelect from '@mui/material/NativeSelect';
import OutlinedInput from '@mui/material/OutlinedInput';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha } from '@mui/material/styles';
import { DialogError, Pill, api, deviceParts, deviceText, errorText, named, t, useShared } from './common.jsx';
import { baseOf } from './attention-feed.mjs';
import { readShared, writeShared } from './shared-store.mjs';
import { DeviceTag } from './TaskDrawer.jsx';
import { shortName } from './task-order.mjs';
import { Field } from './Form.jsx';
import TextField from './TextField.jsx';
import { Icon } from './Icons.jsx';
import { copyText } from './copy-text.mjs';
import { AttentionGuide } from './AttentionGuide.jsx';
import { DRAG_SX, useListDrag } from './list-drag.jsx';
import {
  MAX_INDENT, PRIORITIES, PRIORITY_LABELS, REMIND_STATUSES, STATUSES, STATUS_LABELS, buildTree, childrenOf, collapseId, contextFilePath, contextOf, engineOf, groupItems,
  groupOf, hasTree, homeDetail, homeGroups, isShownSession, jumpBack, keyOf, moveLocal, onThisMachine, overdue, parentChoices, parseKey, patchFor, readCollapsed, rollbackItems,
  linkParts, safeLink, sessionOf, shortTime, statusOfGroup, statusesOfGroup, stepMove, timeline,
  WEEKDAYS, applyChange, momentOf, momentTokens, scheduleLine, tagItem, thenOf, timedSections,
} from './attention-model.mjs';
import { FREQUENCIES, hasSchedule, retryActions, scheduleForm, scheduleFromForm, schedulePatch, scriptTerminal, sessionTasks, targetName } from './attention-schedule.mjs';
import { DIALOG_RADIUS, TOUCH } from './theme.mjs';

// T-Attention: the tasks agents and services report (through listener plugins, the `t-attention` CLI) and the user's own, in one list
// ("Attention" in row 2). One design on both layouts ("One design on both layouts" in docs/design/page-attention.md): the same header, the same Home
// view sections and rows, the same empty state and the same edit view; only the container differs (wide: a floating side sheet on the right with a close button;
// phone: a full-screen page with a back arrow, and the edit view full screen). The list and the live
// updates are in attention-feed.mjs (`state.attention`); this file only draws them and calls `ui.actions.attention*`. A tap on the circle marks a
// task done (from any status; on a done task it opens it again); a tap on the row opens the edit view (a dialog: title, notes, status, priority,
// due date, link and its label, history, delete). A task with a link has a link button at the right of its row (a real <a>: a web address opens in
// a new tab, a page path of this app in this one; it never opens the edit view); web addresses inside the read-only texts of the edit view (the
// reason, the context card, the history) are links too (`Linked`, `linkParts` of attention-model.mjs).
// Both layouts: the "Home view" of the t-attention skill (`homeGroups`, the grouping of `t-attention list --tree`, lib/attention-home.js): the sections Needs
// you (waiting_user, then review), Working and To do, each heading with a coloured dot (red, green, yellow) and its count (an empty section says "None"), whole trees
// (a tree is in the section of its most urgent open task, a sub-task always under its parent), each row with its own status pill, the section's
// detail line (Needs you: what you need to do; Working: custom status · notes; To do: nothing) and the time of its last change (MM-DD HH:MM). Then
// "Done: N" (grey dot): finished tasks are only counted; a tap unfolds them (the closed group of `groupItems`), so they can be opened again.
// A server with sub-tasks (`hasTree`): parents collapse, Review rows have Confirm / Reject and Needs you rows Handled, and a held row is dragged to
// reorder it among its siblings of the same status group (the server's order is per status) or dropped on another section's title to change its
// status (Needs you gives waiting_user, Done gives done; `POST /api/attention/:id/move`, useListDrag of list-drag.jsx). Every such change is drawn at
// once and put back when it fails.
// Several engines (`state.attention.engines`, attention-feed.mjs): one list, each group in engine blocks (by name), every row with the engine
// tag of the task list (`DeviceTag`) in front of its title; a row is named by its `key` (ids repeat between engines), every request goes to its engine,
// and a row is dragged only among the rows of its own engine. With one engine the panel looks as it always did (no tags, no "on <engine>").

const MONO = 'ui-monospace, Menlo, monospace';
const REASON_COLOR = { waiting_user: 'warning.light', review: 'info.light', failed: 'error.light' };
const PRIORITY_COLOR = { high: 'error.light', medium: 'warning.light', low: 'text.secondary' };

const INDENT_PX = 16; // one level of sub-tasks
const CIRCLE_X = 26; // the middle of the circle from the left edge of a row (its 44px button after 4px)
const ROW_SX = { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' };
const ACTION_SX = { minWidth: 0, px: 1, py: 0.25, minHeight: 32 };
// The dot of a section heading (theme colours) and the tone of a status pill.
const SECTION_DOT = { needs_you: 'error.main', working: 'success.main', todo: 'warning.main', scheduled: 'primary.main', recurring: 'info.main', closed: 'text.disabled' };
// The sections of tasks that wait for their time (Scheduled, Recurring): ordered by that time, so their rows are not dragged and their titles take no drop.
const TIMED = new Set(['scheduled', 'recurring']);
const STATUS_TONE = { waiting_user: 'warning', review: 'info', working: 'success', done: 'success', failed: 'error' };
const PILL_SX = { height: 20, typography: 'caption', px: 1, flex: '0 0 auto' };
const DETAIL_COLOR = { reason: null, confirm: 'info.light', progress: 'text.secondary' };
function Dot({ section }) {
  return <Box component="span" className="h5-attention-dot" data-section={section} aria-hidden="true" sx={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', bgcolor: SECTION_DOT[section] || 'text.disabled' }} />;
}

// A read-only text with its http(s) addresses as links (`linkParts`): a new tab, no referrer, never translated, broken anywhere. Never used inside
// an input.
const LINK_SX = { color: 'primary.light', overflowWrap: 'anywhere', wordBreak: 'break-word', textUnderlineOffset: 3 };
function Linked({ text }) {
  return linkParts(text).map((part, index) => (part.url
    ? <Box component="a" key={index} className="h5-attention-text-link" href={part.url} target="_blank" rel="noopener noreferrer" translate="no" sx={LINK_SX}>{part.text}</Box>
    : part.text));
}

// The link button of a row (a task with a safe link_url): a real <a>, so a middle click, a long press and "open in a new tab" work. A web address opens
// in a new tab; a page path of this app (`/…`) in this one. A tap on it never opens the edit view, and it never starts a drag (`ignore` of attentionDrag).
function RowLink({ item }) {
  const link = safeLink(item.link_url);
  if (!link) return null;
  const label = String(item.link_label || '').trim() || t('Open link');
  return (
    <IconButton
      className="h5-attention-row-link" component="a" href={link.url} {...named(label)} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onClick={event => event.stopPropagation()} sx={{ flex: '0 0 auto', mt: 0.25, color: 'primary.light', WebkitTouchCallout: 'default' }}
    ><Icon name="link" size={18} /></IconButton>
  );
}

// The session chip of a row from a T-Agent session (`sessionOf`): the terminal glyph, the device tag of the task list (when it shows one), the
// session's name and its live state dot (the task list's colours). Drawn inside the row's button, so the row's own accessible name tells what a tap does.
const STATE_DOT = { running: 'success.main', waiting: 'warning.main', idle: 'text.disabled' };
const STATE_LABEL = { running: 'Running', waiting: 'Needs you', idle: 'Idle' };
const WAIT_LABEL = { select: 'Needs selection', accept: 'Needs acceptance' }; // a session at a question (columns.mjs WAITING_WORDS)
const AGENT_NAME = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const sessionName = session => session.title || AGENT_NAME[session.agent] || t('Session');
function SessionChip({ session, shown }) {
  return (
    <Box
      component="span" className="h5-attention-session" data-terminal={session.terminalId} data-state={session.status || undefined} translate="no"
      sx={theme => ({
        flex: '0 1 auto', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: 0.75, height: 24, pl: 0.75, pr: 1,
        borderRadius: '12px', bgcolor: alpha(theme.palette.primary.main, shown ? 0.24 : 0.12), color: shown ? 'primary.light' : 'primary.main', typography: 'caption', fontWeight: 500,
      })}
    >
      <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', flex: '0 0 auto' }}><Icon name="terminalKeyboard" size={14} /></Box>
      {session.device ? <DeviceTag device={session.device} /> : null}
      <Box component="span" className="h5-attention-session-name" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sessionName(session)}</Box>
      {session.status ? <Box component="span" className="h5-attention-session-dot" data-state={session.status} data-waiting={session.waiting || undefined} title={t((session.status === 'waiting' && WAIT_LABEL[session.waiting]) || STATE_LABEL[session.status])} sx={{ flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', bgcolor: STATE_DOT[session.status] }} /> : null}
    </Box>
  );
}

// The Details button at the end of a row from a session (a tap on that row opens the session): it opens the edit view, as a tap on any other row
// does. With a mouse it shows while the pointer is over the row or the keyboard focus is in it (its place is kept, so nothing moves); on a touch
// screen it is always there, 44px (the theme's MuiIconButton rule). Its own Tab stop.
function DetailsButton({ onClick }) {
  return (
    <IconButton className="h5-attention-details" {...named(t('Details'))} onClick={event => { event.stopPropagation(); onClick(); }} sx={{ flex: '0 0 auto', mt: 0.25, color: 'text.secondary' }}>
      <Icon name="infoCircle" size={20} />
    </IconButton>
  );
}
// The whole row is what a pointer acts on (its button opens the session, the Details button sits at its end), so the hover tint covers the row, laid
// over the mark of the shown row, instead of only the row's button.
const DETAILS_SX = theme => ({
  '& .h5-attention-details': { opacity: 0, transition: 'opacity 120ms ease-out', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } },
  '&:hover .h5-attention-details, &:focus-within .h5-attention-details': { opacity: 1 },
  [`${TOUCH} .h5-attention-details`]: { opacity: 1 },
  '@media (hover: hover)': {
    '&:hover': { backgroundImage: `linear-gradient(${theme.palette.action.hover}, ${theme.palette.action.hover})` },
    '& .h5-attention-open:hover': { bgcolor: 'transparent' },
  },
});
// The row of the session the page shows (wide layout): MD2's selected look, the primary colour at 8% and a 3px indicator at the left edge.
const SHOWN_SX = theme => ({ bgcolor: alpha(theme.palette.primary.main, 0.08), boxShadow: `inset 3px 0 0 ${theme.palette.primary.main}` });

// Tokens of a schedule line or a moment (`scheduleLine`, `momentTokens` of attention-model.mjs) as text: an English word is translated, a time or date
// is shown as it is, and a session name is never translated.
function Words({ tokens }) {
  return tokens.map((token, index) => (
    <Fragment key={index}>
      {index ? ' ' : ''}
      {typeof token === 'string' ? t(token) : token.name != null ? <span className="h5-attention-schedule-session" translate="no">{token.name}</span> : token.raw}
    </Fragment>
  ));
}
// The schedule line of a row ("Scheduled and recurring tasks" in docs/design/page-attention.md): the icon (clock-circle once, sync recurring, send for
// a prompt), the rule, the next time, when it was last done and the session a prompt goes to, joined with " · ".
function ScheduleLine({ line }) {
  return (
    <Box className="h5-attention-schedule" data-kind={line.kind} data-icon={line.icon} sx={{ mt: 0.25, display: 'flex', alignItems: 'flex-start', gap: 0.5, typography: 'body2', color: 'text.secondary' }}>
      <Box component="span" aria-hidden="true" sx={{ flex: '0 0 auto', display: 'inline-flex', mt: '3px', color: 'primary.light' }}><Icon name={line.icon} size={14} /></Box>
      <Box component="span" className="h5-attention-schedule-text" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {line.parts.map((part, index) => <Fragment key={index}>{index ? ' · ' : ''}<Words tokens={part} /></Fragment>)}
      </Box>
    </Box>
  );
}

// One row. `node` (the tree, buildTree) gives its indent and, for a sub-task of a task in another group, that parent (`node.parent`, the "↳" hint);
// `fold` is the collapse button of a parent; `act` runs a row button (Confirm, Reject, Handled); `hold` are the drag props (useListDrag) or null.
// `section`: the key of the Home view section it is drawn in ('closed' in the unfolded Done list); the row has its status pill, the section's detail
// line and its time. An MD2 list item: the circle, the title in body1, the detail and result lines in body2, the meta line in caption, the row buttons.
// `session` (`sessionOf`): the row came from a T-Agent session that is still there; it has the session chip, a tap opens that session (`onJump`) and
// the Details button opens the edit view. `shown`: that session is the one the page shows (wide layout), and the row is marked.
// `ownerName`: the device of a read copy (docs/design/attention-copies.md), for the lines of a change queued for it ("Will be sent to K01") or dropped
// there; `dismiss` reads the note of a dropped one. `line`: the schedule line of a task with a schedule (`scheduleLine`). In Scheduled and Recurring
// the status pill is left out (every task there is To do until its time).
function Row({ item, node, ui, onOpen, fields, fold, act, busy, hold, tag, section, session, shown, onJump, ownerName, dismiss, line }) {
  const done = item.status === 'done';
  const detail = homeDetail(item, section);
  const second = fields && ['review', 'done'].includes(item.status) && item.result ? { kind: 'result', text: String(item.result) } : null;
  const updated = shortTime(item.updated_at);
  const late = overdue(item);
  const toggle = async () => {
    try { await ui.actions.attentionUpdate(keyOf(item), { status: done ? 'todo' : 'done' }); }
    catch (error) { ui.notify(`${t('Could not update the task')}: ${error.message}`, 'error'); }
  };
  const mark = done ? 'Mark as not done' : 'Mark as done';
  const indent = node ? node.indent : 0;
  // A scheduled task that waits for the person: a prompt whose session was busy has "Send now", a failed script "Open terminal" and "Run again".
  const actions = item.status === 'review' ? ['Confirm', 'Reject'] : item.status === 'waiting_user' ? [...retryActions(item), 'Handled'] : [];
  const pending = Array.isArray(item.pending) && item.pending.length > 0;
  const dropped = Array.isArray(item.dropped) && item.dropped.length > 0;
  const linked = Boolean(safeLink(item.link_url));
  return (
    <Box
      className="h5-attention-row" data-id={item.id} data-key={keyOf(item)} data-engine={engineOf(item)} data-status={item.status} data-depth={node ? node.depth : 0} {...(hold || {})}
      data-shown={shown ? 'true' : undefined}
      sx={theme => ({ display: 'flex', alignItems: 'flex-start', borderBottom: 1, borderColor: 'divider', pl: `${indent * INDENT_PX}px`, ...(hold ? ROW_SX : {}), ...(session ? DETAILS_SX(theme) : {}), ...(shown ? SHOWN_SX(theme) : {}) })}
    >
      <IconButton className="h5-attention-check" {...named(t(mark))} aria-pressed={done} onClick={() => void toggle()} sx={{ flex: '0 0 auto', mt: 0.25, ml: 0.5, color: done ? 'success.light' : 'text.secondary' }}>
        <Icon name={done ? 'attentionDone' : 'attentionOpen'} size={22} />
      </IconButton>
      <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ListItemButton
          className="h5-attention-open" data-session={session ? 'true' : undefined} aria-current={shown ? 'true' : undefined}
          aria-label={session ? `${item.title}, ${t(`open session ${sessionName(session)}`)}` : undefined}
          onClick={() => (session ? onJump(item, session) : onOpen(keyOf(item)))} sx={{ flex: '0 0 auto', minWidth: 0, display: 'block', py: 1, pl: 0.5, pr: fold || linked || session ? 0.5 : 2 }}
        >
          {node && node.parent ? (
            <Box className="h5-attention-parent-hint" sx={{ typography: 'caption', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {'↳ '}{node.parent.title}
            </Box>
          ) : null}
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, minWidth: 0 }}>
            {tag ? <Box component="span" className="h5-attention-engine" sx={{ flex: '0 0 auto', display: 'inline-flex', mt: '0.5px' }}><DeviceTag device={tag} /></Box> : null}
            <Box className="h5-attention-title" sx={{ flex: '1 1 auto', minWidth: 0, typography: 'body1', lineHeight: 1.4, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', color: done || item.status === 'cancelled' ? 'text.secondary' : 'text.primary', textDecoration: done ? 'line-through' : 'none' }}>{item.title}</Box>
          </Box>
          {detail ? (
            <Box className={detail.kind === 'progress' ? 'h5-attention-progress' : 'h5-attention-reason'} data-kind={detail.kind} sx={{ mt: 0.25, typography: 'body2', color: DETAIL_COLOR[detail.kind] || REASON_COLOR[item.status], overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail.kind === 'confirm' ? t(detail.text) : detail.text}
            </Box>
          ) : null}
          {line ? <ScheduleLine line={line} /> : null}
          {second ? <Box className="h5-attention-result" sx={{ mt: 0.25, typography: 'body2', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{second.text}</Box> : null}
          {/* A change made here while the item's device was offline: shown at once, sent when it is back (or not sent, when it was changed there first). */}
          {pending ? <Box className="h5-attention-pending" sx={{ mt: 0.25, typography: 'caption', color: 'info.light', overflowWrap: 'anywhere' }}>{t(`Will be sent to ${ownerName}`)}</Box> : null}
          {dropped ? <Box className="h5-attention-dropped" sx={{ mt: 0.25, typography: 'caption', color: 'warning.light', overflowWrap: 'anywhere' }}>{t(`Not sent: it was changed on ${ownerName} first`)}</Box> : null}
          {/* The meta line: the status pill, the time of the last change, the source, the priority and the due date. */}
          <Box className="h5-attention-meta" sx={{ mt: 0.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 0.75, rowGap: 0.5, typography: 'caption', color: 'text.secondary' }}>
              {TIMED.has(section) ? null : <Pill className="h5-attention-status" data-status={item.status} label={t(STATUS_LABELS[item.status] || 'To do')} tone={STATUS_TONE[item.status] || 'default'} sx={PILL_SX} />}
              {session ? <SessionChip session={session} shown={shown} /> : null}
              {updated ? <Box component="span" className="h5-attention-updated" title={when(item.updated_at)} sx={{ fontVariantNumeric: 'tabular-nums' }}>{updated}</Box> : null}
              {item.source && item.source !== 'user' ? <Pill className="h5-attention-source" label={item.source} translate="no" sx={{ height: 20, typography: 'caption', px: 1 }} /> : null}
              {item.priority && item.priority !== 'none' ? <Box component="span" className="h5-attention-priority" sx={{ color: PRIORITY_COLOR[item.priority] }}>{t(PRIORITY_LABELS[item.priority])}</Box> : null}
              {item.due_date ? <Box component="span" className="h5-attention-due" data-late={late || undefined} sx={{ color: late ? 'error.light' : 'text.secondary' }}>{`${t('Due')} ${item.due_date}`}</Box> : null}
          </Box>
        </ListItemButton>
        {(actions.length && act) || (dropped && dismiss) ? (
          <Box className="h5-attention-actions" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, pb: 1, mt: -0.5 }}>
            {act ? actions.map(name => (
              <Button
                key={name} className="h5-attention-action" data-action={name.toLowerCase().replace(/ /g, '-')} size="small" variant="text" disabled={busy}
                color={name === 'Reject' ? 'inherit' : 'primary'} onClick={() => act(item, name)} sx={ACTION_SX}
              >{t(name)}</Button>
            )) : null}
            {dropped && dismiss ? <Button className="h5-attention-action" data-action="dismiss" size="small" variant="text" color="inherit" onClick={() => dismiss(item)} sx={ACTION_SX}>{t('Dismiss')}</Button> : null}
          </Box>
        ) : null}
      </Box>
      {linked ? <RowLink item={item} /> : null}
      {session ? <DetailsButton onClick={() => onOpen(keyOf(item))} /> : null}
      {fold}
    </Box>
  );
}

// The collapse button of a task with sub-tasks (remembered per task, `h5-attention-collapsed`).
function Fold({ id, open, count, onToggle }) {
  const label = t(open ? 'Collapse sub-tasks' : 'Expand sub-tasks');
  return (
    <IconButton className="h5-attention-fold" data-id={id} {...named(label)} aria-expanded={open} onClick={() => onToggle(id)} sx={{ flex: '0 0 auto', mt: 0.25, mr: 0.5, color: 'text.secondary', gap: 0.25, typography: 'caption' }}>
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
  const movable = ctx.hold && ctx.movable(engine) && !TIMED.has(group);
  const session = ctx.sessionOf(item);
  return (
    <Box className="h5-attention-node" data-id={item.id} data-key={keyOf(item)} data-engine={engine} data-group={group} data-status={item.status} data-sgroup={groupOf(item)} data-movable={movable ? 'true' : undefined} role="listitem" sx={{ position: 'relative' }}>
      <Row
        item={item} node={node} ui={ctx.ui} onOpen={ctx.onOpen} fields={ctx.fields(engine)} fold={fold} act={ctx.act} busy={ctx.busy.has(keyOf(item))} hold={movable ? ctx.hold() : null}
        tag={ctx.tagOf(engine)} section={group} session={session} shown={Boolean(session) && ctx.shownOf(item)} onJump={ctx.jump}
        ownerName={ctx.nameOf(engine)} dismiss={ctx.dismiss} line={ctx.lineOf(item)}
      />
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

// Reject (a task in Review): an optional reason, then back to Working with a note "Rejected: <reason>". A small form in the one dialog pattern: Enter
// rejects, Escape and Cancel keep the task as it is.
function RejectDialog({ item, onCancel, onReject }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onCancel} fullWidth maxWidth="xs" aria-labelledby="h5-attention-reject-title" id="h5-attention-reject">
      <Box component="form" onSubmit={event => { event.preventDefault(); onReject(reason.trim()); }}>
        <DialogTitle id="h5-attention-reject-title">{t('Reject this result?')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <DialogContentText variant="body2" sx={{ color: 'text.primary' }}>{item.title}</DialogContentText>
          <DialogContentText variant="body2">{t('The task goes back to Working.')}</DialogContentText>
          <Box sx={{ mt: 1 }}><Field id="h5-attention-reject-reason" label="Reason (optional)" value={reason} onChange={event => setReason(event.target.value)} autoFocus htmlInput={{ maxLength: 400 }} /></Box>
        </DialogContent>
        <DialogActions>
          <Button id="h5-attention-reject-cancel" onClick={onCancel}>{t('Cancel')}</Button>
          <Button id="h5-attention-reject-confirm" type="submit">{t('Reject')}</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

// The engine a new task goes to when more than one is listed (`h5-attention-add-on`, an engine key): the one chosen last, else the first in the one
// order of devices (never "the engine of this page", so every engine's page starts alike; docs/design/entry-symmetry.md). The person's choice on
// every device and engine (the shared page state keeps it by instance id, shared-store.mjs); this machine is kept by its key too.
const ADD_ON_KEY = 'h5-attention-add-on';

function QuickAdd({ ui, engines }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const on = useShared(ADD_ON_KEY);
  // A choice that left the list (unlinked, hidden, offline) falls back to the first engine that is left.
  const picked = engines.find(engine => engine.key === on) || engines[0];
  const engine = picked ? picked.key : 'local';
  const choose = key => writeShared(ADD_ON_KEY, key);
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
    <Box component="form" id="h5-attention-add-form" onSubmit={event => void submit(event)} sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <OutlinedInput
        id="h5-attention-add-input" size="small" fullWidth value={title} onChange={event => setTitle(event.target.value)} placeholder={t('Add a task')} disabled={busy}
        inputProps={{ 'aria-label': t('Add a task'), maxLength: 300, enterKeyHint: 'done' }} sx={{ flex: '1 1 auto', minWidth: 0 }}
      />
      {engines.length > 1 ? (
        <NativeSelect
          value={engine} onChange={event => choose(event.target.value)} disabled={busy} disableUnderline
          inputProps={{ id: 'h5-attention-add-on', 'aria-label': t('Add on'), title: deviceText(picked) }}
          sx={{ flex: '0 0 auto', maxWidth: 120, typography: 'body2', color: 'text.secondary', '& select': { py: 0, minHeight: 44, boxSizing: 'border-box', display: 'flex', alignItems: 'center', textOverflow: 'ellipsis' } }}
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
const CODE = { m: 0, p: 1, borderRadius: 1, bgcolor: 'action.hover', typography: 'caption', fontFamily: MONO, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflowY: 'auto' };
const HEAD = { typography: 'caption', fontWeight: 500, color: 'text.secondary', mb: 0.25 };
const BODY = { typography: 'body2', overflowWrap: 'anywhere' };
const SMALL = { typography: 'caption', color: 'text.secondary' };

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
    <Box id="h5-attention-context" sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2, borderRadius: 1, border: 1, borderColor: 'divider' }}>
      {pending ? (
        <Box id="h5-attention-context-pending" sx={{ color: REASON_COLOR.waiting_user }}>
          <Box sx={{ ...HEAD, color: 'warning.light' }}>{t('Needs you')}</Box>
          <Box sx={{ ...BODY, whiteSpace: 'pre-wrap', color: 'text.primary' }}><Linked text={pending.text} /></Box>
          {pending.command ? <Box component="pre" id="h5-attention-context-command" translate="no" sx={{ ...CODE, mt: 0.75 }}>{pending.command}</Box> : null}
        </Box>
      ) : null}
      {summary ? (
        <Box id="h5-attention-context-summary">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ ...HEAD, flex: '1 1 auto', mb: 0 }}>{t('AI summary')}</Box>
            <Button id="h5-attention-summary-refresh" size="small" disabled={asking} onClick={() => void refresh()}>{t('Refresh')}</Button>
          </Box>
          <Box sx={{ ...BODY, whiteSpace: 'pre-line' }}><Linked text={summary.text} /></Box>
          <Box sx={SMALL}>{when(summary.at)}{summary.model ? ' \u00b7 ' : ''}<span translate="no">{summary.model || ''}</span></Box>
        </Box>
      ) : null}
      {context.goal ? (
        <Box id="h5-attention-context-goal">
          <Box sx={HEAD}>{t('Goal')}</Box>
          <Box sx={{ ...BODY, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}><Linked text={context.goal} /></Box>
        </Box>
      ) : null}
      {reply || files.length || turns ? (
        <Box id="h5-attention-context-progress">
          <Box sx={HEAD}>{t('Progress')}</Box>
          {reply ? <Box sx={{ ...BODY, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}><Linked text={reply} /></Box> : null}
          <Box sx={{ ...SMALL, mt: 0.25 }}>
            {[when(context.turn_started_at || item.updated_at), turns ? `${t('Turns')}: ${turns}` : ''].filter(Boolean).join(' \u00b7 ')}
          </Box>
          {files.length && !here ? (
            <Box id="h5-attention-context-elsewhere" sx={{ ...SMALL, mt: 0.75, overflowWrap: 'anywhere' }}>{t(`These files are on ${context.host}; only their paths are shown here`)}</Box>
          ) : null}
          {files.length ? (
            <Box component="ul" id="h5-attention-context-files" aria-label={t('Changed files')} sx={{ listStyle: 'none', m: 0, mt: 0.75, p: 0 }}>
              {files.map(file => {
                const absolute = contextFilePath(context, file);
                const open = here ? contextFileAction(ui, absolute, engine) : null;
                const counts = (
                  <Box component="span" sx={{ flex: '0 0 auto', typography: 'caption', fontFamily: MONO }}>
                    <Box component="span" sx={{ color: 'success.light' }}>{`+${Number(file.added) || 0}`}</Box>{' '}
                    <Box component="span" sx={{ color: 'error.light' }}>{`\u2212${Number(file.deleted) || 0}`}</Box>
                  </Box>
                );
                const name = <Box component="span" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, typography: 'caption', fontFamily: MONO, color: open ? 'primary.light' : 'text.secondary', textDecoration: open ? 'underline' : 'none', textUnderlineOffset: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}><bdi>{file.path}</bdi></Box>;
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
        <Box id="h5-attention-context-place" translate="no" sx={{ ...SMALL, fontFamily: MONO, overflowWrap: 'anywhere' }}>
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
          <Box sx={{ ...HEAD, pt: 1 }}>{day.day ? dayLabel(day.day) : ''}</Box>
          <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {day.items.map(entry => (
              <Box component="li" key={entry.id} className="h5-attention-event" data-kind={entry.kind} sx={{ display: 'flex', gap: 1, py: 0.5, borderBottom: 1, borderColor: 'divider', typography: 'body2' }}>
                <Box component="span" sx={{ flex: '0 0 auto', color: 'text.secondary', fontVariantNumeric: 'tabular-nums', minWidth: 44 }}>{clock(entry.at)}</Box>
                <Box component="span" className="h5-attention-sentence" sx={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                  {entry.joined ? t(`${entry.key} ${entry.text}`) : entry.text ? <>{`${t(entry.key)}: `}<Linked text={entry.text} /></> : t(entry.key)}
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

// ── "When" and "Then" of the edit view ("Scheduled and recurring tasks" in docs/design/page-attention.md) ──

// The sessions a prompt can go to are those of the item's own engine. The task list knows the sessions of an open task; the others are read here when
// "Send a prompt to a session" is shown (`GET <tasks>/:id/terminals` of that engine) and kept for the page's life, so the row lines can name them too.
const sessionReads = new Map(); // engine key -> Map('<task id>' -> [{ id, title, agent }])
const readsOf = engine => sessionReads.get(engine) || new Map();
const tasksBaseOf = engine => (engine === 'local' ? '/api/tasks' : /^remote:\d+$/.test(engine) ? `/api/remote-servers/${engine.slice(7)}/tasks` : null);
const MAX_SESSION_READS = 40;
function useSessionTasks(state, engine, active) {
  const [, setTick] = useState(0);
  const tasks = sessionTasks((state.taskList || {}).tasks, engine, readsOf(engine));
  const missing = tasks.filter(task => !task.sessions).slice(0, MAX_SESSION_READS).map(task => task.taskId);
  const base = tasksBaseOf(engine);
  useEffect(() => {
    if (!active || !base || !missing.length) return undefined;
    let live = true;
    const reads = readsOf(engine);
    sessionReads.set(engine, reads);
    void Promise.all(missing.map(id => api('GET', `${base}/${encodeURIComponent(id)}/terminals`)
      .then(rows => { reads.set(String(id), (Array.isArray(rows) ? rows : []).map(row => ({ id: String(row.terminal_id), title: row.title || '', agent: row.agent || null }))); })
      .catch(() => { reads.set(String(id), []); }))).then(() => { if (live) setTick(tick => tick + 1); });
    return () => { live = false; };
  }, [active, base, engine, missing.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return tasks;
}

const OVERLINE = { typography: 'overline', fontWeight: 500, lineHeight: 1.5, color: 'text.secondary', mt: 0.5 };
const PAIR = { display: 'flex', gap: 1.5, '& > *': { flex: '1 1 0', minWidth: 0 } };
const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
// A day chip of "Every week": a round 40px toggle (44px on touch) with the day's letter; its accessible name is the day.
const DAY_SX = { width: 40, height: 40, minWidth: 40, p: 0, borderRadius: '50% !important', border: 1, borderColor: 'divider', typography: 'body2', fontWeight: 500, [TOUCH]: { width: 44, height: 44 } };
// The letter on a day chip: M T W T F S S in English; in Chinese the last character of the translated day name (the "one" of Monday's name, ...).
// Kept out of the dictionaries, where a bare "M" or "T" would change every such text of the page.
const dayLetter = day => { const name = t(day.long); return name !== day.long && name ? name.slice(-1) : day.letter; };
const SCRIPT_EXAMPLE = './scripts/backup.sh && git push'; // a placeholder that is code, never translated
const THEN_CHOICES = [
  ['remind', 'Remind me', 'The task comes back to To do and you are told as for Needs you'],
  ['prompt', 'Send a prompt to a session', 'At that time the prompt is typed into the session you pick, when it is idle'],
  ['script', 'Run a script', 'In a new terminal of the task you pick; the exit code is kept'],
];
const WHEN_CHOICES = [['none', 'No date'], ['once', 'Once'], ['repeat', 'Repeats']];
const ENDS_CHOICES = [['never', 'Never'], ['on', 'On a date'], ['after', 'After N times']];

// "Next time: Mon 11-24 09:00 · Every Monday at 09:00": the owner engine's preview of the schedule in the form (`POST <engine>/schedule/preview`, 300 ms
// after the last change), or what the form still lacks. An engine that cannot preview (an older one, a read copy) shows nothing.
function useSchedulePreview(engine, form) {
  const made = form.when === undefined || form.when === 'none' ? null : scheduleFromForm({ ...form, then: 'remind' });
  const body = made && !made.error ? JSON.stringify(made.schedule) : '';
  const [answer, setAnswer] = useState(null);
  useEffect(() => {
    setAnswer(null);
    if (!body) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      api('POST', `${baseOf(engine)}/schedule/preview`, { schedule: JSON.parse(body) })
        .then(data => { if (live) setAnswer(data && typeof data === 'object' ? data : null); })
        .catch(error => { if (live) setAnswer(error.status === 400 && error.data ? { error: error.data.message || error.message } : null); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [engine, body]);
  if (made && made.error) return { error: made.error };
  return answer;
}

function ScheduleFields({ form, setForm, item, state }) {
  const engine = engineOf(item);
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const put = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const preview = useSchedulePreview(engine, form);
  const tasks = useSessionTasks(state, engine, form.when !== 'none' && form.then === 'prompt');
  const listed = tasks.some(task => (task.sessions || []).some(session => `${task.taskId}|${session.id}` === form.session));
  const next = preview && Array.isArray(preview.next) && preview.next.length ? momentOf(preview.next[0]) : null;
  return (
    <Box id="h5-attention-schedule" component="section" aria-label={t('When')} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box id="h5-attention-when-title" sx={OVERLINE}>{t('When')}</Box>
      <ToggleButtonGroup
        id="h5-attention-when" exclusive fullWidth size="small" value={form.when} aria-labelledby="h5-attention-when-title"
        onChange={(event, value) => { if (value) put('when', value); }}
      >
        {WHEN_CHOICES.map(([value, label]) => <ToggleButton key={value} value={value} data-value={value}>{t(label)}</ToggleButton>)}
      </ToggleButtonGroup>
      {form.when === 'once' ? (
        <Box sx={PAIR}>
          <TextField id="h5-attention-once-date" label={t('Date')} size="small" type="date" value={form.onceDate} onChange={set('onceDate')} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField id="h5-attention-once-time" label={t('Time')} size="small" type="time" value={form.onceTime} onChange={set('onceTime')} slotProps={{ inputLabel: { shrink: true } }} />
        </Box>
      ) : null}
      {form.when === 'repeat' ? (
        <>
          <Box sx={PAIR}>
            <TextField id="h5-attention-repeat-freq" select label={t('Repeats')} size="small" value={form.freq} onChange={set('freq')} slotProps={{ select: { native: true } }}>
              {FREQUENCIES.map(entry => <option key={entry.value} value={entry.value}>{t(entry.label)}</option>)}
            </TextField>
            <TextField id="h5-attention-repeat-time" label={t('At')} size="small" type="time" value={form.time} onChange={set('time')} slotProps={{ inputLabel: { shrink: true } }} />
          </Box>
          {form.freq === 'weekly' ? (
            <ToggleButtonGroup
              id="h5-attention-repeat-days" value={form.days} aria-label={t('Days of the week')} onChange={(event, value) => put('days', value.map(Number).sort((a, b) => a - b))}
              sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, '& .MuiToggleButtonGroup-grouped': { m: 0, border: 1, borderColor: 'divider' } }}
            >
              {WEEKDAYS.map(day => (
                <ToggleButton
                  key={day.n} value={day.n} data-day={day.n} {...named(t(day.long))}
                  sx={theme => ({ ...DAY_SX, '&.Mui-selected, &.Mui-selected:hover': { bgcolor: 'primary.main', color: 'primary.contrastText', borderColor: `${theme.palette.primary.main} !important` } })}
                ><span translate="no">{dayLetter(day)}</span></ToggleButton>
              ))}
            </ToggleButtonGroup>
          ) : null}
          {form.freq === 'monthly' ? (
            <TextField id="h5-attention-repeat-day" label={t('Day of the month')} size="small" type="number" value={form.day} onChange={set('day')} helperText={t('A month without that day uses its last day')} slotProps={{ htmlInput: { min: 1, max: 31, inputMode: 'numeric' } }} />
          ) : null}
          {form.freq === 'every' ? (
            <TextField id="h5-attention-repeat-interval" label={t('Every how many days')} size="small" type="number" value={form.interval} onChange={set('interval')} slotProps={{ htmlInput: { min: 1, max: 365, inputMode: 'numeric' } }} />
          ) : null}
          <Box sx={PAIR}>
            <TextField id="h5-attention-repeat-ends" select label={t('Ends')} size="small" value={form.endsKind} onChange={set('endsKind')} slotProps={{ select: { native: true } }}>
              {ENDS_CHOICES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </TextField>
            <TextField id="h5-attention-repeat-starts" label={t('Starts')} size="small" type="date" value={form.starts} onChange={set('starts')} slotProps={{ inputLabel: { shrink: true } }} />
          </Box>
          {form.endsKind === 'on' ? <TextField id="h5-attention-repeat-ends-date" label={t('End date')} size="small" type="date" value={form.endsDate} onChange={set('endsDate')} slotProps={{ inputLabel: { shrink: true } }} /> : null}
          {form.endsKind === 'after' ? <TextField id="h5-attention-repeat-ends-count" label={t('Times')} size="small" type="number" value={form.endsCount} onChange={set('endsCount')} slotProps={{ htmlInput: { min: 1, max: 9999, inputMode: 'numeric' } }} /> : null}
        </>
      ) : null}
      {form.when !== 'none' && preview ? (
        <Box id="h5-attention-schedule-next" role="status" data-error={preview.error ? 'true' : undefined} sx={{ typography: 'body2', color: preview.error ? 'error.light' : 'primary.light', overflowWrap: 'anywhere' }}>
          {preview.error ? t(preview.error) : next ? (
            <>{`${t('Next time')}: `}<Words tokens={momentTokens(next)} />{form.when === 'repeat' && preview.text ? <>{' · '}{t(preview.text)}</> : null}</>
          ) : t('Nothing left to run')}
        </Box>
      ) : null}
      {form.when !== 'none' ? (
        <>
          <Box id="h5-attention-then-title" sx={OVERLINE}>{t('Then')}</Box>
          <RadioGroup id="h5-attention-then" aria-labelledby="h5-attention-then-title" value={form.then} onChange={set('then')} sx={{ gap: 1 }}>
            {THEN_CHOICES.map(([value, label, hint]) => (
              <FormControlLabel
                key={value} value={value} control={<Radio size="small" inputProps={{ 'data-value': value }} />} sx={{ alignItems: 'flex-start', mx: 0, '& .MuiRadio-root': { mt: -0.75, ml: -1 } }}
                label={<Box><Box sx={{ typography: 'body1' }}>{t(label)}</Box><Box sx={{ typography: 'caption', color: 'text.secondary' }}>{t(hint)}</Box></Box>}
              />
            ))}
          </RadioGroup>
          {form.then === 'prompt' ? (
            <>
              <TextField
                id="h5-attention-then-session" select label={t('Session')} size="small" value={form.session} onChange={set('session')} slotProps={{ select: { native: true } }}
                helperText={tasks.length ? null : t('No sessions of this device are in the task list')}
              >
                <option value="">{t('Choose a session')}</option>
                {form.session && !listed ? <option value={form.session}>{t('The saved session')}</option> : null}
                {tasks.map(task => (
                  <optgroup key={task.taskId} label={task.title}>
                    {task.sessions === null ? <option disabled value={`loading:${task.taskId}`}>{t('Loading…')}</option> : null}
                    {(task.sessions || []).map(session => (
                      <option key={session.id} value={`${task.taskId}|${session.id}`}>{session.title || AGENT_LABEL[session.agent] || t('Session')}</option>
                    ))}
                  </optgroup>
                ))}
              </TextField>
              <Field id="h5-attention-then-prompt" label="Prompt" value={form.prompt} onChange={set('prompt')} multiline minRows={3} maxRows={10} htmlInput={{ maxLength: 4000 }} />
            </>
          ) : null}
          {/* Run a script: in a new terminal of a task of the item's own engine (its folder, the person's shell); only the person can set it (the
              server answers 403 SCRIPT_NEEDS_PERSON to an agent's token, and its message shows in the error line). */}
          {form.then === 'script' ? (
            <>
              <TextField
                id="h5-attention-then-task" select label={t('In task')} size="small" value={form.scriptTask} onChange={set('scriptTask')} slotProps={{ select: { native: true } }}
                helperText={tasks.length ? null : t('No tasks of this device are in the task list')}
              >
                <option value="">{t('Choose a task')}</option>
                {form.scriptTask && !tasks.some(task => String(task.taskId) === form.scriptTask) ? <option value={form.scriptTask}>{t('The saved task')}</option> : null}
                {tasks.map(task => <option key={task.taskId} value={String(task.taskId)}>{task.title}</option>)}
              </TextField>
              <Field
                id="h5-attention-then-script" label="Script" value={form.script} onChange={set('script')} multiline minRows={2} maxRows={10} placeholder={SCRIPT_EXAMPLE}
                htmlInput={{ maxLength: 4000, translate: 'no', autoCorrect: 'off' }} sx={{ '& textarea': { typography: 'body2', fontFamily: MONO } }}
              />
              <TextField
                id="h5-attention-then-timeout" label={t('Stop after (minutes)')} size="small" type="number" value={form.timeoutMin} onChange={set('timeoutMin')}
                slotProps={{ htmlInput: { min: 1, max: 720, inputMode: 'numeric' } }} sx={{ maxWidth: 200 }}
              />
            </>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}

// The edit view of one task. The form starts from the item; Save sends only the changed fields (PATCH). The history is read when it opens.
// `owner`: the engine entry of the item's engine; a read copy of an offline engine says since when it is as shown, and that its history is kept there.
function EditDialog({ item, items, fields, movable, tag, owner, state, wide, ui, onClose, onLeave, onOpen, onMove }) {
  const key = keyOf(item);
  // "When" and "Then" for an engine whose items carry a schedule (an older engine's edit view has neither).
  const timed = hasSchedule(items.filter(entry => engineOf(entry) === engineOf(item)));
  const [form, setForm] = useState(() => ({
    ...(timed ? scheduleForm(item) : {}),
    title: item.title || '', notes: item.notes || '', status: item.status, priority: item.priority || 'none', due_date: item.due_date || '',
    link_url: item.link_url || '', link_label: item.link_label || '',
    ...(fields ? { custom_status: item.custom_status || '', result: item.result || '', parent_id: item.parent_id == null ? '' : String(item.parent_id) } : {}),
  }));
  const [events, setEvents] = useState(null); // null: loading
  const [elsewhere, setElsewhere] = useState(false); // the answer is the copy here: the history is on the item's own engine
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    ui.actions.attentionDetail(key).then(data => { if (live) { setEvents(Array.isArray(data && data.events) ? data.events : []); setElsewhere(Boolean(data && data.copy)); } }).catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [key, item.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }));
  const save = async event => {
    if (event) event.preventDefault();
    if (busy) return;
    const made = timed ? scheduleFromForm(form) : null;
    if (made && made.error) { setError(t(made.error)); return; }
    const changes = { ...(patchFor(item, form) || {}), ...(timed ? schedulePatch(item, form) : {}) };
    const body = Object.keys(changes).length ? changes : null;
    if (!body) { onClose(); return; }
    if (body.title !== undefined && !body.title) { setError(t('The title cannot be empty')); return; }
    setBusy(true);
    setError('');
    try { await ui.actions.attentionUpdate(key, body); ui.notify(t('Saved'), 'success'); onClose(); }
    catch (failure) { setError(`${t('Could not save')}: ${errorText(failure)}`); } // the server's message (a link that is not http(s), ...)
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
    // The same edit view on both layouts, in the one dialog pattern: a centred "sm" dialog on a wide screen, full screen on a phone. A form: Enter in a
    // one-line field saves, Escape closes; the title row has the close button, the actions row Delete (error colour, at the start), Cancel and Save.
    <Dialog
      open onClose={onClose} fullScreen={!wide} fullWidth maxWidth="sm" aria-labelledby="h5-attention-edit-title" id="h5-attention-edit"
      slotProps={{ paper: { component: 'form', noValidate: true, onSubmit: event => void save(event), sx: wide ? null : { pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' } } }}
    >
      <DialogTitle component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1, py: 1 }}>
        <Typography id="h5-attention-edit-title" variant="h6" component="h2" sx={{ flex: '0 1 auto' }}>{t('Edit task')}</Typography>
        {tag ? <Box id="h5-attention-edit-engine" sx={{ display: 'inline-flex', minWidth: 0 }}><DeviceTag device={tag} /></Box> : null}
        <Box sx={{ flex: '1 1 auto' }} />
        <IconButton id="h5-attention-edit-close" {...named(t('Close'))} onClick={onClose}><Icon name="close" size={22} /></IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 3 }}>
        <ContextCard item={item} state={state} ui={ui} onLeave={onLeave} />
        {REMIND_STATUSES.includes(item.status) && item.attention_reason && !(contextOf(item).pending && contextOf(item).pending.text) ? (
          <Box id="h5-attention-edit-reason" sx={{ p: 2, borderRadius: 1, border: 1, borderColor: REASON_COLOR[item.status], color: REASON_COLOR[item.status], ...BODY, whiteSpace: 'pre-wrap' }}><Linked text={item.attention_reason} /></Box>
        ) : null}
        <Field id="h5-attention-edit-name" label="Title" value={form.title} onChange={set('title')} htmlInput={{ maxLength: 300 }} />
        {timed ? <ScheduleFields form={form} setForm={setForm} item={item} state={state} /> : null}
        <Field id="h5-attention-edit-notes" label="Notes" value={form.notes} onChange={set('notes')} multiline minRows={3} maxRows={12} htmlInput={{ maxLength: 20000 }} />
        {/* The link: an http(s) address or a page path of this app; the server checks it (a refusal shows its message in the error line). */}
        <Field
          id="h5-attention-edit-link-url" label="Link" type="url" value={form.link_url} onChange={set('link_url')} placeholder={t('https://… or /path')}
          htmlInput={{ maxLength: 2000, inputMode: 'url', autoCorrect: 'off', translate: 'no' }}
        />
        <Field id="h5-attention-edit-link-label" label="Link label" value={form.link_label} onChange={set('link_label')} placeholder={t('Shown instead of the address')} htmlInput={{ maxLength: 200 }} />
        {/* The saved link (what the row's link button opens); a changed address is opened from here after Save. */}
        {link ? (
          <Button
            id="h5-attention-edit-link" variant="outlined" component="a" href={link.url} startIcon={<Icon name="link" size={18} />}
            {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            sx={{ justifyContent: 'flex-start', overflowWrap: 'anywhere', textAlign: 'left' }}
          ><span translate="no">{item.link_label || item.link_url}</span></Button>
        ) : null}
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
                  <ButtonBase className="h5-attention-child" data-id={child.id} onClick={() => onOpen(keyOf(child))} sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, minHeight: 36, px: 0.5, borderRadius: 1, typography: 'body2', color: 'primary.light', textAlign: 'left', 'html[data-input="touch"] &': { minHeight: 44 } }}>
                    <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{child.title}</Box>
                    <Box component="span" sx={{ flex: '0 0 auto', ...SMALL }}>{t(STATUS_LABELS[child.status] || 'To do')}</Box>
                  </ButtonBase>
                </Box>
              ))}
            </Box>
          </Box>
        ) : null}
        <Typography variant="caption" color="text.secondary" component="div" id="h5-attention-edit-meta" sx={{ overflowWrap: 'anywhere' }}>
          {`${t('Source')}: `}<span translate="no">{item.source || 'user'}</span>{tag ? <>{' · '}<span translate="no">{deviceText(tag)}</span></> : null}{item.created_at ? ` · ${t('Created')} ${when(item.created_at)}` : ''}{item.updated_at ? ` · ${t('Updated')} ${when(item.updated_at)}` : ''}
          {owner && owner.offline && owner.asOf ? <span className="h5-attention-edit-as-of">{` · ${t(`As of ${when(owner.asOf)}`)}`}</span> : null}
        </Typography>
        <Box component="section" aria-labelledby="h5-attention-history-title">
          <Typography id="h5-attention-history-title" variant="subtitle2" component="h3" sx={{ mb: 0.5 }}>{t('History')}</Typography>
          {elsewhere && owner ? <Typography id="h5-attention-history-elsewhere" variant="body2" color="text.secondary">{t(`The history is kept on ${deviceText(owner)}`)}</Typography> : <Timeline events={events} titleOf={titleOf} />}
        </Box>
        {error ? <DialogError id="h5-attention-edit-error" sx={{ mt: 0 }}>{error}</DialogError> : null}
      </DialogContent>
      <DialogActions>
        <Button id="h5-attention-edit-delete" color="error" disabled={busy} onClick={() => setConfirming(true)} sx={{ mr: 'auto' }}>{t('Delete')}</Button>
        <Button id="h5-attention-edit-cancel" onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-attention-edit-save" type="submit" variant="contained" disabled={busy}>{t('Save')}</Button>
      </DialogActions>
      <Dialog open={confirming} onClose={() => setConfirming(false)} fullWidth maxWidth="xs" aria-labelledby="h5-attention-delete-title" aria-describedby="h5-attention-delete-text" id="h5-attention-delete">
        <DialogTitle id="h5-attention-delete-title">{t('Delete this task?')}</DialogTitle>
        <DialogContent>
          <DialogContentText variant="body2" sx={{ color: 'text.primary', mb: 1 }}>{item.title}</DialogContentText>
          <DialogContentText id="h5-attention-delete-text" variant="body2">{t('The task and its history are deleted for good.')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button id="h5-attention-delete-cancel" onClick={() => setConfirming(false)}>{t('Cancel')}</Button>
          <Button id="h5-attention-delete-confirm" color="error" disabled={busy} onClick={() => void remove()}>{t('Delete')}</Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

// The ids of the parents whose sub-tasks are hidden (JSON list); default: shown. The same on every device and engine (the shared page state keeps
// them by instance id, shared-store.mjs).
const COLLAPSED_KEY = 'h5-attention-collapsed';

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
    ignore: '.h5-attention-check, .h5-attention-fold, .h5-attention-action, .h5-attention-row-link, .h5-attention-details',
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

// The list (the Home view, on both layouts): the sections with their dotted headings (MD2 list subheaders with the section's count; each a drop target;
// empty: "None"), then "Done: N", which unfolds the finished tasks (`closed`, the closed group of `groupItems`) but the ones already drawn in a section
// (a finished parent kept above an open sub-task), so no task is drawn twice. `home` is `homeGroups`. Between To do and "Done: N" come Scheduled and
// Recurring (`timed`, `timedSections`) when they have tasks: plain rows the soonest first, each with its schedule line; no drag and no drop there.
const HEAD_SX = { px: 2, gap: 1, minHeight: 44, pt: 1, boxSizing: 'border-box', display: 'flex', alignItems: 'center', typography: 'overline', fontWeight: 500, lineHeight: 1.5, color: 'text.secondary' };
const sizeOf = nodes => nodes.reduce((count, node) => count + 1 + sizeOf(node.children), 0);
function HomeSections({ home, timed, closed, items, movable, showClosed, setShowClosed, ctx }) {
  const hintOf = key => (movable ? <Box component="span" className="h5-attention-drop-hint" aria-hidden="true" sx={{ ml: 'auto', pl: 1, textTransform: 'none' }}>{`→ ${t(STATUS_LABELS[statusOfGroup(key)])}`}</Box> : null);
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
          <Box className={movable ? 'h5-attention-group-title h5-attention-drop' : 'h5-attention-group-title'} data-group={section.key} sx={HEAD_SX}>
            <Dot section={section.key} />
            <Box component="span" className="h5-attention-group-label" sx={{ minWidth: 0, color: 'text.primary' }}>{t(section.label)}</Box>
            <Box component="span" className="h5-attention-group-count" sx={{ fontVariantNumeric: 'tabular-nums' }}>{sizeOf(section.nodes)}</Box>
            {hintOf(section.key)}
          </Box>
          {section.nodes.length ? (
            <Box className="h5-attention-level" data-level={`${section.key}:root`} role="list">
              {section.nodes.map(node => <Node key={keyOf(node.item)} node={node} group={section.key} ctx={ctx} />)}
            </Box>
          ) : (
            <Box className="h5-attention-none" sx={{ px: 2, pb: 1.5, typography: 'body2', color: 'text.secondary', borderBottom: 1, borderColor: 'divider' }}>{t('None')}</Box>
          )}
        </Box>
      ))}
      {timed.filter(section => section.items.length).map(section => (
        <Box component="section" key={section.key} className="h5-attention-group" data-group={section.key} aria-label={t(section.label)}>
          <Box className="h5-attention-group-title" data-group={section.key} sx={HEAD_SX}>
            <Dot section={section.key} />
            <Box component="span" className="h5-attention-group-label" sx={{ minWidth: 0, color: 'text.primary' }}>{t(section.label)}</Box>
            <Box component="span" className="h5-attention-group-count" sx={{ fontVariantNumeric: 'tabular-nums' }}>{section.items.length}</Box>
          </Box>
          <Box className="h5-attention-level" data-level={`${section.key}:root`} role="list">
            {section.items.map(item => <Node key={keyOf(item)} node={{ item, depth: 0, indent: 0, parent: null, children: [] }} group={section.key} ctx={ctx} />)}
          </Box>
        </Box>
      ))}
      <Box component="section" className="h5-attention-group" data-group="closed" data-empty={count ? undefined : 'true'} aria-label={t('Done & failed')}>
        <ButtonBase id="h5-attention-closed-toggle" className={movable ? 'h5-attention-drop' : undefined} data-group="closed" aria-expanded={showClosed} disabled={!count && !movable} onClick={() => setShowClosed(value => !value)} sx={{ ...HEAD_SX, pt: 0, width: '100%', justifyContent: 'flex-start', borderBottom: 1, borderColor: 'divider' }}>
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

// The empty and the error state of the list: an MD2 empty state (an icon, a line in subtitle1, a hint in body2, and a button for the error).
function ListState({ id, icon, title, hint, children }) {
  return (
    <Box id={id} role="status" sx={{ px: 3, py: 6, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <Box aria-hidden="true" sx={{ display: 'inline-flex', color: 'text.disabled', mb: 1 }}><Icon name={icon} size={48} /></Box>
      <Typography variant="subtitle1" component="p">{title}</Typography>
      {hint ? <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 320 }}>{hint}</Typography> : null}
      {children}
    </Box>
  );
}

// The scrolling list of the sections. It is drawn inside the sheet, so the drag (and its touchmove guard) is set up when the list is there.
function GroupList({ ui, attention, groups, home, timed, lineOf, items, fieldsOf, movable, movableOf, tagOf, nameOf, dismiss, showClosed, setShowClosed, collapsed, toggleCollapsed, onOpen, act, busy, move, open, sessionOf: sessionFor, shownOf, jump, hint }) {
  const listRef = useRef(null);
  const hostRef = useRef(null);
  const liveRef = useRef(null);
  const moveRef = useRef(move);
  moveRef.current = move;
  const spec = useMemo(() => attentionDrag(moveRef), []);
  const drag = useListDrag(listRef, hostRef, liveRef, ui, spec);
  const ctx = { ui, onOpen, fields: fieldsOf, movable: movableOf, tagOf, nameOf, dismiss, act, busy, collapsed, toggleCollapsed, hold: movable ? drag.hold : null, sessionOf: sessionFor, shownOf, jump, lineOf };
  const failed = attention.status === 'ready' && Array.isArray(attention.failed) ? attention.failed : [];
  const offline = attention.status === 'ready' && Array.isArray(attention.offline) ? attention.offline : [];
  return (
    <Box sx={theme => ({ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', ...DRAG_SX(theme), ...DROP_SX(theme) })}>
      <Box id="h5-attention-body" ref={listRef} sx={{ position: 'relative', flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', pb: 2 }}>
        {/* The first-run guide (AttentionGuide.jsx): shown until its steps are done or it is closed; read each time the panel opens. */}
        <AttentionGuide ui={ui} place="panel" active={open} />
        {attention.status === 'error' ? (
          <ListState id="h5-attention-error" icon="attentionOpen" title={t('Could not read the tasks')}>
            <Button id="h5-attention-retry" variant="outlined" sx={{ mt: 1 }} onClick={() => ui.actions.attentionReload()}>{t('Try again')}</Button>
          </ListState>
        ) : null}
        {/* An engine whose list could not be read (the others go on); it is read again as its stream reconnects. */}
        {failed.map(entry => (
          <Box key={entry.key} className="h5-attention-failed" data-engine={entry.key} role="status" sx={{ px: 2, py: 1, typography: 'caption', color: 'text.secondary', borderBottom: 1, borderColor: 'divider', overflowWrap: 'anywhere' }}>
            {t(`Could not load ${entry.name}`)}
          </Box>
        ))}
        {/* An engine whose items are its read copies as of a time: it is offline (changes to them are sent when it is back), or known only through another
            device (read only). */}
        {offline.map(entry => (
          <Box key={entry.key} className="h5-attention-offline" data-engine={entry.key} role="status" sx={{ px: 2, py: 1, typography: 'caption', color: 'text.secondary', borderBottom: 1, borderColor: 'divider', overflowWrap: 'anywhere' }}>
            <Box component="span" sx={{ color: 'warning.light' }}>{t(entry.linked ? `${entry.name} is offline` : `${entry.name} is not linked to this device`)}</Box>
            {entry.asOf ? <Box component="span" className="h5-attention-as-of" title={when(entry.asOf)}>{` · ${t(`Its tasks as of ${shortTime(entry.asOf)}`)}`}</Box> : null}
            {entry.linked ? ` · ${t('Changes are sent when it is back')}` : ''}
          </Box>
        ))}
        {attention.status === 'ready' && !items.length ? (
          <ListState id="h5-attention-empty" icon="attentionDone" title={t('No tasks yet')} hint={t('Tasks that agents report, and the ones you add above, show up here.')} />
        ) : null}
        {items.length ? (
          <HomeSections home={home} timed={timed} closed={groups.find(group => group.key === 'closed')} items={items} movable={movable} showClosed={showClosed} setShowClosed={setShowClosed} ctx={ctx} />
        ) : null}
        {/* The side panel (mouse): how a row of a session works, since its Details button shows only on hover and focus. */}
        {hint ? (
          <Box id="h5-attention-hint" sx={{ mx: 2, my: 1.5, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, typography: 'caption', color: 'text.secondary' }}>
            {t('Click a row with a session chip to open it')}{' \u00b7 '}
            <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex' }}><Icon name="infoCircle" size={14} /></Box>{t('for details')}
          </Box>
        ) : null}
      </Box>
      {/* The floating copy of a dragged row goes in here (useListDrag); a move is announced in the live region. */}
      <Box ref={hostRef} />
      <Box ref={liveRef} role="status" aria-live="polite" sx={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }} />
    </Box>
  );
}

// The side sheet of a wide screen: MD2 elevation 16 (the theme's shadow and, in the dark theme, the surface overlay of that elevation, both from the
// Paper), 8px from the top, right and bottom edges of the window, about 480px wide but never wider than the window less the rail and 16px, the
// project's 8px corners. It lies above the page, the columns strip and the rail, under the menus and dialogs (the modal z-index) and the notices.
const SIDE_SHEET_Z = theme => theme.zIndex.modal - 10;
const SIDE_SHEET = {
  top: 8, right: 8, bottom: 8, height: 'auto', width: 'min(480px, calc(100vw - var(--h5-nav-width) - 16px))', borderRadius: `${DIALOG_RADIUS}px`, border: 0,
  zIndex: SIDE_SHEET_Z, display: 'flex', flexDirection: 'column', overflow: 'hidden',
};

// A press outside the side sheet: a transparent layer over the whole window under the sheet (no scrim) takes it, closes the sheet and swallows it, so
// it does not also click, focus or type into what lies below (an iframe column too, which a document listener would never hear). The rail lies
// under it as well: its Attention button closes the sheet with that one press, as a toggle would. Menus and dialogs opened from the sheet lie above
// it, so a press on them is not outside. The layer stays until the press has ended (its pointerup and click; a touch's late click a moment more),
// so the end of the press does not land on the page either.
function OutsidePress({ active, onPress }) {
  const [held, setHeld] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!active && !held) return null;
  const release = delay => { clearTimeout(timer.current); timer.current = setTimeout(() => setHeld(false), delay); };
  return (
    <Box
      className="h5-attention-outside" aria-hidden="true"
      onPointerDown={event => {
        event.preventDefault();
        clearTimeout(timer.current);
        setHeld(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not every pointer can be captured */ }
        if (active) onPress();
      }}
      onPointerUp={event => release(event.pointerType === 'mouse' ? 0 : 400)}
      onPointerCancel={() => release(0)}
      onClick={event => { event.preventDefault(); event.stopPropagation(); release(0); }}
      onContextMenu={event => event.preventDefault()}
      sx={{ position: 'fixed', inset: 0, zIndex: theme => SIDE_SHEET_Z(theme) - 1, bgcolor: 'transparent', touchAction: 'none' }}
    />
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
  const collapsedText = useShared(COLLAPSED_KEY);
  const collapsed = useMemo(() => readCollapsed(collapsedText), [collapsedText]);
  const items = attention.items || [];
  // The engines of the list, by name (attention-feed.mjs); with more than one every row has its engine tag.
  const engines = useMemo(() => (Array.isArray(attention.engines) && attention.engines.length ? attention.engines : [{ key: 'local', local: true, label: 'This machine', name: '' }]), [attention.engines]);
  const tagged = engines.length > 1;
  const tags = useMemo(() => new Map(engines.map(engine => [engine.key, engine])), [engines]);
  const tagOf = engine => (tagged ? tags.get(engine) || { key: engine, label: engine, name: '' } : null);
  // An engine with sub-tasks (its items have `parent_id`) gets the tree, the new fields and the drag; one without /move (`noMove`) has no drag.
  const treeEngines = useMemo(() => new Set(engines.map(engine => engine.key).filter(key => hasTree(items.filter(item => engineOf(item) === key)))), [engines, items]);
  const noMove = Array.isArray(attention.noMove) ? attention.noMove : [];
  const fields = treeEngines.size > 0;
  const fieldsOf = engine => treeEngines.has(engine);
  // The rows of an engine whose items are copies as of a time (offline, or not linked) are not dragged: the order is kept on that engine.
  const movableOf = engine => treeEngines.has(engine) && !noMove.includes(engine) && !(tags.get(engine) && tags.get(engine).offline);
  const nameOf = engine => deviceText(tags.get(engine) || { key: engine, label: engine });
  const dismiss = entry => {
    const ids = (Array.isArray(entry.dropped) ? entry.dropped : []).map(note => note.id);
    ui.actions.attentionShow(now().map(row => (keyOf(row) === keyOf(entry) ? { ...row, dropped: [] } : row)));
    for (const id of ids) void Promise.resolve(ui.actions.attentionDismiss && ui.actions.attentionDismiss(id)).catch(() => {});
  };
  const movable = engines.some(engine => movableOf(engine.key));
  const order = useMemo(() => engines.map(engine => engine.key), [engines]);
  const groups = useMemo(() => groupItems(items, { keepEmpty: fields, engines: order }), [items, fields, order]);
  // Both layouts: the Home view of the t-attention skill (the same grouping as `t-attention list --tree`).
  const home = useMemo(() => homeGroups(items, { engines: order }), [items, order]);
  // The tasks that wait for their time: Scheduled (once) and Recurring (repeat), after To do.
  const timed = useMemo(() => timedSections(items, { engines: order }), [items, order]);
  // The schedule line of a row; a prompt names its session and a script its task as the task list (or the edit view's read) knows them, on the
  // item's own engine.
  const lineOf = entry => scheduleLine(entry, { now: new Date(), targetName: then => targetName(then, (state.taskList || {}).tasks, engineOf(entry), readsOf(engineOf(entry))) });
  // The counts of the header: the tasks that need the person (Needs you and Review) and the open ones.
  const needCount = items.filter(entry => entry.status === 'waiting_user' || entry.status === 'review').length;
  const openCount = items.filter(entry => !['done', 'failed', 'cancelled'].includes(entry.status)).length;
  const close = () => { setEditing(null); ui.actions.closeAttention(); };
  // The session of a row (`sessionOf`): the T-Agent task and terminal its context names, when they are in the one task list and the session is
  // still there; on the host of the item's own engine ("Rows of a session" in docs/design/page-attention.md).
  const hostOf = engine => {
    const owner = (Array.isArray(attention.engines) ? attention.engines : []).find(entry => entry.key === engine);
    return owner ? owner.host : engine === 'local' ? attention.host : null;
  };
  const taskList = state.taskList || {};
  const sessionFor = entry => sessionOf(contextOf(entry), { sourceKey: engineOf(entry), groups: taskList.groups, tasks: taskList.tasks, localHost: hostOf(engineOf(entry)) });
  // The row of the session the page shows is marked on the wide layout only (on a phone the list is a page of its own).
  const shownOf = entry => side && isShownSession(contextOf(entry), engineOf(entry), state.shownTarget);
  // A tap on a row of a session opens it: the same as "Open terminal" of the edit view. The task's status stays as it is. On a phone the T-Attention
  // page closes (the bottom navigation shows Sessions again) and a notice names the task with a Details action that opens its edit view here again;
  // on a computer the panel stays open beside the session, whose row is then marked.
  const jump = (entry, session) => {
    if (!side) { setEditing(null); ui.actions.closeAttention(); }
    ui.actions.openRow(session.taskId, { kind: 'terminal', id: session.terminalId });
    const key = keyOf(entry);
    if (!side) ui.notify(t(`Opened from T-Attention: ${entry.title}`), 'info', { action: { label: 'Details', run: () => ui.actions.openAttention({ item: key }) } });
  };
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

  const toggleCollapsed = id => {
    const next = readCollapsed(readShared(COLLAPSED_KEY)); // the stored list, also when two toggles come before a drawing
    if (next.has(id)) next.delete(id); else next.add(id);
    writeShared(COLLAPSED_KEY, JSON.stringify([...next]));
  };
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
    else if (name === 'Send now' || name === 'Run again') void runNow(entry);
    else if (name === 'Open terminal') openScriptTerminal(entry);
  };
  // "Open terminal" of a failed script: the terminal of that run (`context.tagent`), on the item's own engine, as "Open terminal" of the edit view
  // does (on a phone the T-Attention page closes first).
  const openScriptTerminal = entry => {
    const where = scriptTerminal(contextOf(entry), engineOf(entry), taskList.tasks);
    if (!where) { ui.notify(t('The terminal of this run is not in the task list'), 'error'); return; }
    if (!side) { setEditing(null); ui.actions.closeAttention(); }
    ui.actions.openRow(where.taskId, { kind: 'terminal', id: where.terminalId });
  };
  // "Send now" of a prompt task whose session was busy at its time, "Run again" of a failed script: POST <engine>/:id/run-now on the item's own
  // engine (409 SESSION_BUSY when the session is still busy; the server's message says so). The answer's item, when there is one, replaces the row;
  // the stream brings it too.
  const runNow = async entry => {
    const key = keyOf(entry);
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy(new Set(busyRef.current));
    const engine = engineOf(entry);
    try {
      const data = await api('POST', `${baseOf(engine)}/${encodeURIComponent(entry.id)}/run-now`, {});
      const raw = data && data.item ? data.item : data && data.id != null ? data : null;
      if (raw) ui.actions.attentionShow(applyChange(now(), { kind: 'updated', item: tagItem(raw, engine) }));
      const script = thenOf(entry).kind === 'script';
      ui.notify(t(script ? 'The script runs again' : 'Prompt sent'), 'success');
    } catch (error) {
      ui.notify(`${t(thenOf(entry).kind === 'script' ? 'Could not run the script' : 'Could not send the prompt')}: ${errorText(error)}`, 'error');
    } finally {
      busyRef.current.delete(key);
      setBusy(new Set(busyRef.current));
    }
  };
  const reject = reason => {
    const key = rejecting;
    setRejecting(null);
    if (key != null) void send(key, { status: 'working', attention_reason: null, activity: { kind: 'note', text: reason ? `Rejected: ${reason}` : 'Rejected' } });
  };
  const rejectItem = rejecting == null ? null : items.find(entry => keyOf(entry) === rejecting);

  // The header, the same on both layouts: the title in h6 and a body2 line with the counts (and "Not live" while the stream reconnects). Only the way out
  // differs with the container: a back arrow at the start on a phone (a full-screen page), a close button at the end of the side panel.
  const live = attention.status !== 'ready' || attention.live;
  const counts = attention.status === 'ready' && items.length ? t(`Needs you: ${needCount} · Open: ${openCount}`) : '';
  const contents = (
    <>
      <Box component="header" sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 56, pl: side ? 2 : 0.5, pr: side ? 1 : 2, borderBottom: 1, borderColor: 'divider' }}>
        {side ? null : <IconButton id="h5-attention-close" {...named(t('Back'))} onClick={close}><Icon name="back" size={22} /></IconButton>}
        <Box sx={{ flex: '1 1 auto', minWidth: 0, pl: side ? 0 : 0.5 }}>
          <Typography id="h5-attention-title" variant="h6" component="h2" translate="no" noWrap sx={{ lineHeight: 1.3 }}>T-Attention</Typography>
          <Typography variant="body2" component="div" color="text.secondary" noWrap sx={{ display: counts || !live ? 'block' : 'none' }}>
            <span id="h5-attention-counts">{counts}</span>
            <Box component="span" id="h5-attention-state" sx={{ color: 'warning.light' }}>{live ? '' : `${counts ? ' · ' : ''}${t('Not live: reconnecting…')}`}</Box>
          </Typography>
        </Box>
        {side ? <IconButton id="h5-attention-close" {...named(t('Close'))} onClick={close}><Icon name="close" size={22} /></IconButton> : null}
      </Box>
      {/* A new task can go to this machine and to every engine whose list was read. */}
      <QuickAdd ui={ui} engines={engines.filter(engine => engine.key === 'local' || engine.ready)} />
      {attention.status === 'loading' ? <LinearProgress id="h5-attention-loading" aria-label={t('Loading…')} sx={{ flex: '0 0 auto' }} /> : null}
      <GroupList
        ui={ui} attention={attention} groups={groups} home={home} timed={timed} lineOf={lineOf} items={items} fieldsOf={fieldsOf} movable={movable} movableOf={movableOf} tagOf={tagOf} nameOf={nameOf} dismiss={dismiss} showClosed={showClosed} setShowClosed={setShowClosed}
        collapsed={collapsed} toggleCollapsed={toggleCollapsed} onOpen={setEditing} act={act} busy={busy} move={move} open={open}
        sessionOf={sessionFor} shownOf={shownOf} jump={jump} hint={side && items.some(entry => !['done', 'failed', 'cancelled'].includes(entry.status) && sessionFor(entry))}
      />
      {rejectItem ? <RejectDialog key={keyOf(rejectItem)} item={rejectItem} onCancel={() => setRejecting(null)} onReject={reject} /> : null}
      {/* onLeave: the user goes to a terminal or a file from the context card; the edit view closes, and on a phone the sheet too. */}
      {item ? (
        <EditDialog
          key={keyOf(item)} item={item} items={items} fields={fieldsOf(engineOf(item))} movable={movableOf(engineOf(item))} tag={tagOf(engineOf(item))} owner={tags.get(engineOf(item)) || null} state={state} wide={side} ui={ui} onClose={() => setEditing(null)}
          onLeave={() => { setEditing(null); if (!side) ui.actions.closeAttention(); }} onOpen={setEditing} onMove={move}
        />
      ) : null}
    </>
  );
  if (side) {
    // A wide screen: a floating side sheet over the page ("Panel" in docs/design/page-attention.md). It changes no layout, so nothing below refits and
    // no PTY resize is sent. No scrim: a press anywhere outside closes it and does nothing else (OutsidePress). Escape inside it closes it; keys
    // inside it are never sent to the terminal (h5.js).
    return (
      <>
        <OutsidePress active={open} onPress={close} />
        <Drawer
          variant="persistent" anchor="right" id="h5-attention-sheet" open={open} transitionDuration={reduced ? 0 : undefined}
          slotProps={{ paper: { className: 'h5-attention-panel', role: 'complementary', 'aria-labelledby': 'h5-attention-title', elevation: 16, onKeyDown: event => { if (event.key === 'Escape' && event.currentTarget.contains(event.target)) { event.stopPropagation(); close(); } }, sx: SIDE_SHEET } }}
        >
          {contents}
        </Drawer>
      </>
    );
  }
  // A phone: a full-screen page that comes in from the right, with a back arrow. It is a modal: Escape, the Android back button (back.mjs) close it, the
  // edit view first.
  return (
    <Drawer
      anchor="right" id="h5-attention-sheet" open={open} onClose={close} transitionDuration={reduced ? 0 : undefined}
      ModalProps={{ disableScrollLock: true }}
      slotProps={{ paper: { className: 'h5-attention-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'h5-attention-title', sx: { height: '100dvh', width: '100%', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' } } }}
    >
      {contents}
    </Drawer>
  );
}
