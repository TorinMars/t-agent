import { useContext, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Feedback, Group, Hint, Section, SettingsNav, SubHeading, SwitchRow, failure, useFeedback } from './Form.jsx';
import { InTab } from './DeviceTarget.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';

// The Settings group "Usage data" ("Usage data" in docs/design/usage-data.md): the switch "Record button use" (one choice for every linked engine:
// the settings sync group usage-record, so it is in the Shared tab), the most pressed controls of the last 30 days (all, computer or phone), the
// controls shown but not pressed in that time, and the store (count, size, where it is kept, Clear, Export JSON). The data is one set for the linked
// normal engines ("Merged across linked devices"), so the cards are the same in every tab. It reads GET /api/ui-events/settings and /summary each
// time it opens; the switch is saved at once (PUT) and tells this page's recorder through `usageRecording` (usage-track.mjs).

// Readable names of the main controls (English; the page translates them). Any other key is shown as it is.
const NAMES = {
  'h5-translate-button': 'Send', 'h5-translate-send': 'Send as typed', 'h5-more-send': 'Send as typed', 'h5-cycle': 'Recent sessions',
  'h5-commands': 'Saved commands', 'h5-more-commands': 'Saved commands', 'h5-more': 'More tools', 'h5-voice': 'Voice input', 'h5-image': 'Upload image or file',
  'h5-design': 'Docs', 'h5-more-docs': 'Docs', 'h5-attention': 'Attention', 'h5-more-cycle': 'Next running or pending session', 'h5-more-keyboard': 'Terminal keyboard',
  'action:keyboard': 'Terminal keyboard', 'action:draft': 'Draft keyboard', 'action:more': 'More', 'action:width': 'Wide terminal', 'action:maximize': 'Maximize column', 'action:close': 'Close column',
  'h5-paste-text': 'Paste text', 'h5-add-menu-command': 'Saved command', 'h5-add-menu-key': 'Key combination', 'h5-add-menu-edit': 'Edit before sending',
  'h5-term-width': 'Wide terminal', 'h5-header-more': 'More (header)', 'h5-refresh': 'Refresh the page', 'h5-header-update': 'Update', 'h5-update': 'Update',
  'h5-sidebar-toggle': 'Fold the task list', 'h5-open-tasks': 'Tasks',
  'h5-nav-sessions': 'Sessions', 'h5-nav-columns': 'Columns', 'h5-nav-attention': 'Attention', 'h5-nav-maps': 'Mind maps', 'h5-nav-settings': 'Settings',
  'h5-bnav-sessions': 'Sessions', 'h5-bnav-attention': 'Attention', 'h5-bnav-maps': 'Mind maps', 'h5-bnav-settings': 'Settings',
  'h5-task-item': 'Open a task', 'h5-terminal-main': 'Open a session', 'h5-task-more': 'Task actions', 'h5-terminal-more': 'Session actions', 'h5-task-add': 'New session',
  'h5-add-task': 'New task', 'h5-task-list-more': 'List options', 'h5-expand-all': 'Expand all', 'h5-collapse-all': 'Collapse all', 'h5-task-tag': 'Device tag',
  'h5-tasks-settings': 'Settings', 'h5-tasks-mindmap': 'Mind maps', 'h5-close-tasks': 'Close the task list', 'h5-menu-action': 'Menu action', 'h5-term-menu-cancel': 'Cancel',
  'h5-attention-open': 'Open session', 'h5-attention-check': 'Mark done', 'h5-attention-details': 'Details', 'h5-attention-fold': 'Fold', 'h5-attention-action': 'T-Attention action',
  'h5-attention-close': 'Close T-Attention', 'h5-attention-add': 'Add task', 'h5-attention-jump': 'Go to the session',
  'h5-switcher-card': 'Switcher card', 'h5-new-task-create': 'Create task', 'h5-new-task-cancel': 'Cancel', 'h5-close-settings': 'Close Settings',
};
const KEY_LABELS = { Escape: 'Esc', ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow', ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', PageUp: 'Page up', PageDown: 'Page down', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
export function nameOf(key) {
  if (Object.hasOwn(NAMES, key)) return t(NAMES[key]);
  const [prefix, rest] = key.split(':');
  if ((prefix === 'key' || prefix === 'mod') && rest) return t(`${t(KEY_LABELS[rest] || rest)} key`);
  if (prefix === 'shortcut' && rest === 'ctrl-c') return 'Ctrl+C';
  return key;
}
// Readable names of the surfaces (usage-track.mjs `surfaceOf`).
const SURFACES = {
  header: 'Header', rail: 'Rail', 'bottom-nav': 'Bottom navigation', 'bottom-row': 'Bottom row', 'tool-row': 'Tool row', 'key-row': 'Key row', keyboard: 'On-screen keyboard',
  'task-list': 'Task list', 'task-menu': 'Session menu', attention: 'T-Attention', switcher: 'Switcher', columns: 'Columns', maps: 'Mind maps', design: 'Docs', files: 'Files',
  chat: 'Chat', notice: 'Notice', page: 'Page', settings: 'Settings', 'menu:commands': 'Saved commands',
};
export function surfaceName(surface) {
  if (Object.hasOwn(SURFACES, surface)) return t(SURFACES[surface]);
  const kind = surface.split(':')[0];
  return t({ settings: 'Settings', dialog: 'Dialog', menu: 'Menu' }[kind] || surface);
}
const LAYOUT_NAMES = { wide: 'computer', narrow: 'phone' };
const FILTERS = [['', 'All'], ['wide', 'Computer'], ['narrow', 'Phone']];

// Where the data is kept (`where` of the summary), as one sentence.
export function whereText(where) {
  const place = where && typeof where === 'object' ? where : {};
  if (place.hands_over && place.home_name) {
    if (place.home_online) return t(`Kept on ${place.home_name}. This company computer hands its presses over and keeps none.`);
    return t(`Kept on ${place.home_name}, which can't be reached right now. ${place.waiting || 0} presses wait on this computer and move there when it is back.`);
  }
  const names = Array.isArray(place.shared_with) ? place.shared_with.filter(name => typeof name === 'string' && name) : [];
  if (names.length) return t(`Kept on this machine and on ${names.join(', ')}, as one set.`);
  return t('Kept on this machine only.');
}

const size = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const day = at => new Date(at).toISOString().slice(0, 10);

// One bar of "Most used": the name, the surface (with the layout when every press was on one), a bar relative to the first one and the count. On a
// computer one row of four columns, as in the mockup; on a phone the name, the surface and the count on one line and the bar under them.
function UsageBar({ entry, max, filter, wide }) {
  const surface = entry.surfaces[0] ? entry.surfaces[0].surface : 'page';
  const only = !filter && entry.layouts ? Object.entries(entry.layouts).filter(([, n]) => n > 0).map(([layout]) => layout) : [];
  const where = only.length === 1 ? `${surfaceName(surface)} · ${t(LAYOUT_NAMES[only[0]])}` : surfaceName(surface);
  const share = max ? Math.max(2, Math.round((entry.count / max) * 100)) : 0;
  return (
    <Box
      component="li" className="h5-usage-row"
      sx={wide ? { display: 'grid', gridTemplateColumns: 'minmax(0, 200px) 150px minmax(0, 1fr) 56px', alignItems: 'center', columnGap: 1.5, minHeight: 32 }
        : { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto 48px', gridTemplateAreas: '"name where count" "bar bar bar"', alignItems: 'center', columnGap: 1, rowGap: 0.5, py: 0.75 }}
    >
      <Typography variant="body2" className="h5-usage-name" noWrap sx={{ gridArea: wide ? undefined : 'name' }}>{nameOf(entry.key)}</Typography>
      <Typography variant="caption" color="text.secondary" className="h5-usage-surface" noWrap sx={{ gridArea: wide ? undefined : 'where' }}>{where}</Typography>
      <Box aria-hidden="true" sx={{ gridArea: wide ? undefined : 'bar', height: 8, borderRadius: 1, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box className="h5-usage-bar" sx={{ width: `${share}%`, height: '100%', borderRadius: 1, bgcolor: 'primary.main' }} />
      </Box>
      <Typography variant="body2" className="h5-usage-count" sx={{ gridArea: wide ? undefined : 'count', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'text.primary' }}>{entry.count.toLocaleString('en')}</Typography>
    </Box>
  );
}

// The chips of "Not used in 30 days": a key that is left unused on one layout only says which, and one unused on several surfaces says where.
function unusedChips(unused, filter) {
  const perKey = new Map();
  for (const entry of unused) perKey.set(entry.key, (perKey.get(entry.key) || 0) + 1);
  return unused.map(entry => {
    const notes = [];
    if (perKey.get(entry.key) > 1) notes.push(surfaceName(entry.surface));
    if (!filter && entry.layouts.length === 1) notes.push(t(LAYOUT_NAMES[entry.layouts[0]]));
    return { id: `${entry.key}|${entry.surface}`, label: notes.length ? `${nameOf(entry.key)} (${notes.join(', ')})` : nameOf(entry.key) };
  });
}

export function UsageDataGroup({ ui, request }) {
  const [opened, setOpened] = useState(0);
  return (
    <Group id="usage-data" title="Usage data" onOpen={() => setOpened(count => count + 1)} request={request}>
      <UsageParts ui={ui} opened={opened} />
    </Group>
  );
}

function UsageParts({ ui, opened }) {
  const nav = useContext(SettingsNav);
  const wide = !nav || nav.wide;
  const [enabled, setEnabled] = useState(null);
  const [filter, setFilter] = useState('');
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async (layout = filter) => {
    try {
      const [setting, data] = await Promise.all([api('GET', '/api/ui-events/settings'), api('GET', `/api/ui-events/summary?days=30${layout ? `&layout=${layout}` : ''}`)]);
      setEnabled(Boolean(setting && setting.enabled));
      setSummary(data);
      say('');
    } catch (error) { say(failure(error), true); }
  };
  // Read each time the group is shown (`opened` counts the openings; the parts mount once and stay mounted).
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const change = async on => {
    setBusy(true);
    setEnabled(on);
    try {
      const saved = await api('PUT', '/api/ui-events/settings', { enabled: on });
      const now = Boolean(saved && saved.enabled);
      setEnabled(now);
      ui.set({ usageRecording: now });
    } catch (error) { say(failure(error), true); setEnabled(!on); }
    finally { setBusy(false); }
  };
  const choose = (event, value) => { if (value === null) return; setFilter(value); void load(value); };
  const clear = async () => {
    setBusy(true);
    try { await api('DELETE', '/api/ui-events'); setConfirming(false); await load(); say('Usage data cleared'); }
    catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const top = summary ? summary.top : [];
  const max = top.length ? top[0].count : 0;
  const chips = summary ? unusedChips(summary.unused || [], filter) : [];
  const data = summary ? summary.data : null;
  const dataLine = !data ? '' : [
    data.count ? t(`${data.count.toLocaleString('en')} events since ${day(data.first_at)}`) : t('No events yet'),
    t(`kept for ${data.retention_days} days`),
    size(data.bytes || 0),
  ].join(' · ');
  return (
    <>
      <InTab part="usage-record">
        <Section id="usage-record">
          <SwitchRow
            inputId="h5-usage-enabled" label={t('Record button use')} checked={Boolean(enabled)} disabled={enabled === null || busy} onChange={on => void change(on)}
            secondary={t('Records which button was pressed, where, and when. Never what you type, task names or terminal text. Nothing is sent to any outside service.')}
            aside={<ScopeLabel id="usage-record" scope="shared" />}
          />
        </Section>
      </InTab>
      <Section id="usage-top">
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}><SubHeading id="h5-sec-usage-top-title">{t('Most used · last 30 days')}</SubHeading></Box>
          <ToggleButtonGroup id="h5-usage-layout" size="small" color="primary" exclusive value={filter} onChange={choose} aria-label={t('Layout')}>
            {FILTERS.map(([value, label]) => <ToggleButton key={label} id={`h5-usage-layout-${label.toLowerCase()}`} value={value} sx={{ px: 1.25, py: 0.25 }}>{t(label)}</ToggleButton>)}
          </ToggleButtonGroup>
        </Box>
        {top.length ? (
          <Box component="ol" id="h5-usage-top" aria-labelledby="h5-sec-usage-top-title" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column' }}>
            {top.map(entry => <UsageBar key={entry.key} entry={entry} max={max} filter={filter} wide={wide} />)}
          </Box>
        ) : <Hint id="h5-usage-top-empty">{t(summary ? 'No button presses recorded in this time.' : 'Loading…')}</Hint>}
      </Section>
      <Section id="usage-unused" title="Not used in 30 days">
        <Hint>{t('Candidates to move into a menu.')}</Hint>
        {chips.length ? (
          <Box id="h5-usage-unused" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {chips.map(chip => <Chip key={chip.id} className="h5-usage-chip" label={chip.label} variant="outlined" />)}
          </Box>
        ) : <Hint id="h5-usage-unused-empty">{t(summary ? 'Every control shown in this time was used.' : 'Loading…')}</Hint>}
      </Section>
      <Section id="usage-store">
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1.5, rowGap: 1 }}>
          <Box sx={{ flex: '1 1 16rem', minWidth: 0 }}>
            <SubHeading id="h5-sec-usage-store-title">{t('Data')}</SubHeading>
            <Typography id="h5-usage-data" variant="body2" color="text.secondary">{dataLine}</Typography>
            {summary ? <Typography id="h5-usage-where" variant="body2" color="text.secondary">{whereText(summary.where)}</Typography> : null}
          </Box>
          <Box sx={{ display: 'flex', gap: 1, ml: 'auto' }}>
            <Button id="h5-usage-clear" color="error" disabled={busy || !data || !data.count} onClick={() => setConfirming(true)}>{t('Clear')}</Button>
            <Button id="h5-usage-export" component="a" href="/api/ui-events/export" download={`t-agent-usage-${day(Date.now())}.json`}>{t('Export JSON')}</Button>
          </Box>
        </Box>
        <Feedback id="h5-usage-feedback" feedback={feedback} />
      </Section>
      <Dialog id="h5-usage-clear-dialog" open={confirming} onClose={() => setConfirming(false)} fullWidth maxWidth="xs" aria-labelledby="h5-usage-clear-title" aria-describedby="h5-usage-clear-text">
        <DialogTitle id="h5-usage-clear-title">{t('Clear usage data?')}</DialogTitle>
        <DialogContent>
          <DialogContentText id="h5-usage-clear-text" variant="body2">{t('Every recorded button press and the list of controls seen are deleted, here and on the linked machines that keep the same data. This cannot be undone.')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button id="h5-usage-clear-cancel" onClick={() => setConfirming(false)}>{t('Cancel')}</Button>
          <Button id="h5-usage-clear-confirm" color="error" disabled={busy} onClick={() => void clear()}>{t('Clear')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
