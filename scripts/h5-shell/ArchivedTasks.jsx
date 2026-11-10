import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';

// `archived_at` as the server keeps it: an SQLite time ("2026-11-10 12:00:00", UTC, without a zone) or ISO 8601.
function when(value) {
  const text = String(value || '');
  const at = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isFinite(at) ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

// One archived task: the title, when it was archived, Restore and Delete. It opens nothing when tapped: an archived task has no terminals.
function Row({ row, busy, ui }) {
  const at = when(row.archivedAt);
  return (
    <Box className="h5-archived-row" data-task-id={row.id} sx={{ px: 0.75, py: 0.5, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
      <Box className="h5-archived-title" translate="no" sx={{ fontSize: 14, lineHeight: 1.25, fontWeight: 700, overflowWrap: 'anywhere' }}>{row.title}</Box>
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 0.5 }}>
        <Box component="span" className="h5-archived-when" sx={{ flex: '1 1 96px', minWidth: 0, fontSize: 12, color: 'text.secondary' }}>{at ? `${t('Archived')} ${at}` : ''}</Box>
        <Button className="h5-archived-restore" size="small" disabled={Boolean(busy)} onClick={() => void ui.actions.archivedRestore(row.id)}>{t('Restore')}</Button>
        <Button className="h5-archived-delete" size="small" color="error" disabled={Boolean(busy)} onClick={() => ui.actions.archivedDelete(row.id)}>{t('Delete')}</Button>
      </Box>
    </Box>
  );
}

// The Archived entry at the end of the task list, the same on a phone sheet and the wide sidebar: closed at first, and its rows are read only when it is opened (h5.js `archived`).
// Not there on a remote Engine without 'tasks:archive'. The number appears once the rows have been read.
export function ArchivedTasks({ archived, ui }) {
  if (!archived || !archived.supported) return null;
  const { open, status, rows, count, busy } = archived;
  return (
    <Box id="h5-archived" component="section" sx={{ mt: 0.5, borderTop: 1, borderColor: 'divider' }}>
      <ListItemButton
        component="button" id="h5-archived-toggle" aria-expanded={open} onClick={() => ui.actions.toggleArchived()}
        sx={{ width: '100%', minHeight: 36, py: 0, px: 0.75, borderRadius: 2, gap: 1, textAlign: 'left', fontSize: 14, color: 'text.secondary' }}
      >
        <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none' }}><Icon name="treeChevron" size={16} /></Box>
        <Icon name="archived" size={18} />
        <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0 }}>{t('Archived')}</Box>
        {count != null ? <Box component="span" id="h5-archived-count" sx={{ fontSize: 12 }}>{count}</Box> : null}
      </ListItemButton>
      {open ? (
        <Box id="h5-archived-list" role="group" aria-label={t('Archived')}>
          {status === 'loading' ? <Typography className="h5-archived-note" variant="body2" color="text.secondary" sx={{ px: 1, py: 0.75 }}>{t('Loading…')}</Typography> : null}
          {status === 'error' ? <Typography className="h5-archived-note" variant="body2" color="error" sx={{ px: 1, py: 0.75 }}>{t('Could not load the archived tasks')}</Typography> : null}
          {status === 'ready' && !rows.length ? <Typography className="h5-archived-note" variant="body2" color="text.secondary" sx={{ px: 1, py: 0.75 }}>{t('No archived tasks')}</Typography> : null}
          {rows.map(row => <Row key={row.id} row={row} busy={busy} ui={ui} />)}
        </Box>
      ) : null}
    </Box>
  );
}
