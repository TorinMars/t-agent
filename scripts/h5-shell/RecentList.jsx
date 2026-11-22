// The "Recent" tab of the task list ("Recent tab" in docs/design/page-task-list.md): the sessions this device used, most recent first, as one flat list:
// the same entries and order as the session switcher (h5.js `state.recent`, recent-sessions.mjs). Each row: the session's tile with its state dot, its
// name, when it was last used ("Current" for the shown one), and a line with the device tag, the task and the state word in the state's colour. A tap
// opens the session the way the task list and the switcher do (`ui.actions.openRow`); the "⋯" opens the menu of a session row (`recentMore`) with
// "Remove from Recent" (only the list changes), and Rename puts the rename field of the task list in place of the row. "Clear list" at the right of
// the caption empties the list except the shown session. The search field and the filter chips of the list apply here too (`filterRecent`), and
// the chips count the sessions of this list (`onCounts`). A lazy chunk of its own (screen-recent.jsx, lazy-screens.jsx `RecentScreen`), loaded when
// the tab is first reached, so the first screen does not carry it.
import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';
import { columnStatus, stateWord } from './columns.mjs';
import { Icon } from './Icons.jsx';
import { filterRecent, recentCounts, recentRows, recentWhen } from './recent-rows.mjs';
import { shallowEqual } from './store.mjs';
import { TOUCH } from './theme.mjs';
import { countRender, useStore } from './use-store.mjs';
import {
  DOT_SX, DeviceTag, HOVER_SX, REVEAL_SX, RenameRow, SELECTED_SX, STATE_DOT, STATE_TEXT, STATE_WORDS, SessionKindIcon, VISUALLY_HIDDEN,
} from './TaskDrawer.jsx';

const KIND_NAMES = { claude: 'Claude session', codex: 'Codex session', opencode: 'OpenCode session' };
// What the tab reads; it is drawn only while the tab is shown (the By task tab reads none of it).
const RECENT = state => ({ recent: state.recent, shownTarget: state.shownTarget, taskList: state.taskList, activity: state.terminalActivity, attention: state.attention });

// "Current", "2 min ago", "yesterday", ... (translated piece by piece: the number stays as it is).
function whenText(row, now) {
  if (row.current) return t('Current');
  const when = recentWhen(row.lastUsed, now);
  if (!when) return '';
  return when.count ? `${when.count} ${t(when.word)}` : t(when.word);
}

// The time words are drawn again once a minute while the tab is shown (a row whose words did not change is not drawn again).
function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const ROW_KEYS = ['key', 'ref', 'terminalId', 'agent', 'name', 'named', 'taskTitle', 'status', 'waiting', 'current'];
const sameRow = (a, b) => a.ui === b.ui && a.when === b.when && a.rename === b.rename
  && ROW_KEYS.every(key => a.row[key] === b.row[key]) && (a.row.device === b.row.device || shallowEqual(a.row.device, b.row.device));

// One row (about 56px; 64px on a touch screen). It is drawn again only when what it shows changed, so one pushed activity draws one row.
const RecentRow = React.memo(function RecentRow({ row, when, ui, rename }) {
  countRender('RecentRow');
  const target = { kind: 'terminal', id: row.terminalId };
  if (rename) return <RenameRow menu={rename} ui={ui} row={row} />;
  const state = t(stateWord(STATE_WORDS, row.status, row.waiting) || 'Idle');
  return (
    <Box
      component="li" className="h5-recent-row" data-key={row.key} data-status={row.status} data-waiting={row.waiting || undefined} data-current={row.current ? 'true' : undefined}
      sx={theme => ({
        position: 'relative', display: 'flex', alignItems: 'center', borderRadius: 2, ...(row.current ? SELECTED_SX(theme) : {}), ...REVEAL_SX,
        // On a computer the "⋯" takes the place of the time while the pointer is over the row or the focus is in it.
        '@media (hover: hover)': { ...(row.current ? {} : HOVER_SX['@media (hover: hover)']), '&:hover .h5-recent-when': { opacity: 0 } },
        '&:has(:focus-visible) .h5-recent-when': { opacity: 0 },
        [TOUCH]: { '& .h5-recent-when': { opacity: 1 } },
      })}
    >
      <ListItemButton
        component="button" className="h5-recent-main" aria-current={row.current ? 'true' : undefined} selected={row.current}
        onClick={() => ui.actions.openRow(row.ref, target)}
        sx={{
          flex: '1 1 auto', minWidth: 0, minHeight: 56, py: 0.75, pl: 1.25, pr: 1, gap: 1.5, borderRadius: 2, textAlign: 'left',
          '&:hover, &.Mui-selected, &.Mui-selected:hover': { bgcolor: 'transparent' }, [TOUCH]: { minHeight: 64, pr: 6 },
        }}
      >
        <SessionKindIcon agent={row.agent} title={t(KIND_NAMES[row.agent] || 'Terminal')} size={32}>
          <Box component="span" className="h5-terminal-dot" sx={{ ...DOT_SX, position: 'absolute', right: -2, bottom: -2, width: 10, height: 10, bgcolor: STATE_DOT[row.status], boxShadow: theme => `0 0 0 2px ${theme.palette.background.paper}` }} />
        </SessionKindIcon>
        <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
            <Box component="span" className="h5-recent-name" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, typography: 'body2', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.named ? row.name : t(row.name)}</Box>
            {when ? <Box component="span" className="h5-recent-when" sx={{ flex: '0 0 auto', typography: 'caption', color: 'text.secondary', whiteSpace: 'nowrap', transition: 'opacity 120ms ease-out' }}>{when}</Box> : null}
          </Box>
          <Box component="span" className="h5-recent-sub" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, typography: 'caption', color: 'text.secondary', whiteSpace: 'nowrap' }}>
            <Box component="span" sx={VISUALLY_HIDDEN}>{`${t(KIND_NAMES[row.agent] || 'Terminal')}, `}</Box>
            {row.device ? <DeviceTag device={row.device} /> : null}
            {row.taskTitle ? <Box component="span" className="h5-recent-task" translate="no" title={row.taskTitle} sx={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.taskTitle}</Box> : null}
            <Box component="span" className="h5-recent-state" sx={{ flex: '0 0 auto', color: STATE_TEXT[row.status] }}>{`· ${state}`}</Box>
          </Box>
        </Box>
      </ListItemButton>
      <IconButton
        className="h5-recent-more h5-row-act" size="small" aria-label={t('Terminal actions')} title={t('Terminal actions')} aria-haspopup="menu"
        onClick={event => ui.actions.recentMore(row.ref, target, event.currentTarget)}
        sx={{ position: 'absolute', right: 4, top: 6, p: 0.5, [TOUCH]: { top: 'calc(50% - 22px)', right: 0 } }}
      ><Icon name="taskMore" size={20} /></IconButton>
    </Box>
  );
}, sameRow);

// The tab's list: its caption, the rows the search and the filters keep, or why there are none. Every recent session gets its task, device and state;
// the state is the header's and the switcher's rule (columns.mjs `columnStatus`: the activity feeds and the T-Attention items), so it follows the pushed
// activity with no request. `rename`: the menu while a session row is being renamed (its rename field takes the place of that row); `onCounts` gets
// { running, pending } for the chips whenever they change.
export function RecentList({ ui, query, filter, rename, onCounts }) {
  const state = useStore(ui, RECENT, shallowEqual);
  const now = useMinute();
  const items = state.attention && state.attention.items;
  const all = recentRows(state.recent, {
    shown: state.shownTarget, tasks: state.taskList && state.taskList.tasks,
    statusOf: entry => columnStatus({ target: entry }, { activity: state.activity, items }).state,
    kindOf: entry => columnStatus({ target: entry }, { activity: state.activity, items }).kind,
  });
  const counts = recentCounts(all);
  useEffect(() => { onCounts(counts); }, [counts.running, counts.pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = filterRecent(all, query, filter);
  const total = all.length;
  const note = state.taskList && state.taskList.note;
  if (note && !total) return <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t(note)}</Typography>;
  if (!total) {
    return (
      <Box id="h5-recent-empty" sx={{ px: 3, py: 4, textAlign: 'center' }}>
        <Typography variant="subtitle2" component="p">{t('No recent sessions yet')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('Sessions you open appear here, most recent first.')}</Typography>
      </Box>
    );
  }
  return (
    <>
      {/* "Clear list" empties the list except the shown session (h5.js `clearRecent`; a snackbar offers Undo). Only the list changes. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 34, pl: 1.5, pr: 0, pt: 0.5, pb: 0.25 }}>
        <Typography id="h5-recent-caption" variant="caption" component="p" color="text.secondary" sx={{ flex: '1 1 auto', minWidth: 0 }}>{t('Sessions you used, most recent first')}</Typography>
        {all.some(row => !row.current) ? (
          <Button id="h5-recent-clear" size="small" onClick={() => ui.actions.clearRecent()} sx={{ flex: '0 0 auto', minWidth: 0, px: 0.75, [TOUCH]: { minHeight: 44, px: 1 } }}>{t('Clear list')}</Button>
        ) : null}
      </Box>
      {rows.length ? (
        <Box component="ul" aria-labelledby="h5-recent-caption" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {rows.map(row => {
            const renaming = rename && rename.rename && rename.rename.task === row.ref && rename.rename.kind === 'terminal' && String(rename.rename.id) === row.terminalId ? rename : null;
            return <RecentRow key={row.key} row={row} when={whenText(row, now)} ui={ui} rename={renaming} />;
          })}
        </Box>
      ) : <Typography className="h5-list-note" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('No matching sessions')}</Typography>}
    </>
  );
}
