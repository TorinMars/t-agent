import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { api, t } from './common.jsx';
import { Feedback, Hint, Section, failure, onAnyGroupOpen, useFeedback } from './Form.jsx';
import { detailLine, keyEntry, labelsShown, normalizeSync, outcomeText, peerStatus, saveOutcome, scopeOf, scopeText, scopeTitle } from './settings-sync.mjs';

// The scope labels of the settings sheet ("Settings sync" in DESIGN.md): next to the heading of each part, what a change there affects. "Shared across
// devices" (copied to every linked device), "This device only", or Telegram's one sender. The data is GET /api/settings-sync (settings-sync.mjs), kept
// in one small store for the whole sheet: read each time a group opens (the sheet reads nothing before), after "Sync now" and while a shared save is copied.
// An older server (404) and a single machine (no linked device) show no label at all, so the sheet looks as before.
const SYNC_URL = '/api/settings-sync';
let snapshot = { loaded: false, sync: normalizeSync(null) };
const listeners = new Set();
const emit = next => { snapshot = next; for (const listener of listeners) listener(); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
let reading = null;

// Reads the route again; two calls at the same time share one request. Any failure other than 404 keeps what was known.
export function refreshSettingsSync() {
  if (reading) return reading;
  reading = (async () => {
    try { emit({ loaded: true, sync: normalizeSync(await api('GET', SYNC_URL)) }); }
    catch (error) { emit({ loaded: true, sync: error.status === 404 ? normalizeSync(null) : snapshot.sync }); }
    finally { reading = null; }
    return snapshot.sync;
  })();
  return reading;
}
export const useSettingsSync = () => useSyncExternalStore(subscribe, () => snapshot);
onAnyGroupOpen(() => void refreshSettingsSync());

const PILL = {
  display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', minHeight: 22, maxWidth: '100%', px: 1, py: 0.25, borderRadius: 11, border: 1,
  fontSize: 12, fontWeight: 500, lineHeight: 1.3, whiteSpace: 'normal', overflowWrap: 'anywhere', verticalAlign: 'middle',
};
const LOOK = {
  shared: { color: 'primary.main', borderColor: theme => alpha(theme.palette.primary.main, 0.4), bgcolor: theme => alpha(theme.palette.primary.main, 0.1) },
  telegram: { color: 'text.primary', borderColor: theme => alpha(theme.palette.info.main, 0.5), bgcolor: theme => alpha(theme.palette.info.main, 0.1) },
  device: { color: 'text.secondary', borderColor: 'divider', bgcolor: 'transparent' },
};

// One label. `id` is the setting's id on the route (its `scopes` decide); `scope` is the scope the page knows when the route does not name the part
// (the parts that are always this device's own, such as the agent skills). `subject` names one control of a part ("Window language: ...").
export function ScopeLabel({ id = null, scope: fallback = 'device', subject = '', sx }) {
  const { sync } = useSettingsSync();
  if (!labelsShown(sync)) return null;
  const scope = scopeOf(sync, id, fallback);
  const details = scope === 'shared' ? detailLine(sync, id, { t }) : '';
  const text = `${subject ? `${t(subject)}: ` : ''}${t(scopeText(scope, sync.sender))}`;
  const title = [t(scopeTitle(scope)), details].filter(Boolean).join('\n');
  return (
    <Box component="span" className="h5-scope" data-scope={scope} data-setting={id || ''} sx={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 0.75, rowGap: 0.25, minWidth: 0, maxWidth: '100%', ...sx }}>
      <Box component="span" className="h5-scope-label" title={title} sx={{ ...PILL, ...LOOK[scope] }}>{text}</Box>
      {details ? <Typography component="span" variant="caption" color="text.secondary" className="h5-scope-detail" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>{details}</Typography> : null}
    </Box>
  );
}

// A heading with its label after it, wrapping under it when the line is too short (a phone). Without labels the heading is drawn alone, as before.
export function ScopedHeading({ children, label, sx }) {
  const { sync } = useSettingsSync();
  if (!label || !labelsShown(sync)) return children;
  return <Box className="h5-scoped-heading" sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, minWidth: 0, '& > .h5-scope': { flex: '1 1 10rem' }, ...sx }}>{children}{label}</Box>;
}

// After a save of a shared setting: `track()` starts watching the route (a few reads, about 10 seconds at most) and the line under the Saved feedback
// says "Copied to linked devices" once no linked device waits for it, or which device it waits for. Nothing is said without linked devices.
const LOOKS_MS = [800, 1500, 2500, 2500, 2700]; // ~10 s in all
export function useSyncAfterSave(id) {
  const [note, setNote] = useState(null);
  const run = useRef(0);
  useEffect(() => () => { run.current += 1; }, []);
  const track = async () => {
    const mine = ++run.current;
    const known = snapshot.sync;
    if (!labelsShown(known) || scopeOf(known, id) !== 'shared') { setNote(null); return; }
    const before = (keyEntry(known, id) || {}).updated_at || null;
    setNote({ state: 'copying' });
    for (let attempt = 0; attempt < LOOKS_MS.length; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, LOOKS_MS[attempt]));
      if (mine !== run.current) return;
      const sync = await refreshSettingsSync();
      if (mine !== run.current) return;
      const outcome = saveOutcome(sync, id, { before, attempt, last: attempt === LOOKS_MS.length - 1 });
      if (outcome) { setNote(outcome); return; }
    }
  };
  const clear = () => { run.current += 1; setNote(null); };
  return [note, track, clear];
}
export function SyncNote({ id, note }) {
  if (!note) return <p id={id} hidden />;
  return <Typography id={id} className="h5-sync-note" data-state={note.state} role="status" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{t(outcomeText(note))}</Typography>;
}

// "Settings sync" at the top of the Devices group: each linked device with online / last sync / error, and "Sync now" (POST /api/settings-sync/now).
// Hidden on an older server and with no linked device, like the labels.
export function SettingsSyncStatus({ opened }) {
  const { sync } = useSettingsSync();
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  useEffect(() => { if (opened) say(''); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- the route is read when the group opens (Form.jsx)
  if (!labelsShown(sync)) return <span id="h5-settings-sync" hidden />;
  const now = async () => {
    setBusy(true);
    say('');
    try { await api('POST', `${SYNC_URL}/now`, {}); await refreshSettingsSync(); say('Synced'); }
    catch (error) { say(failure(error), true); await refreshSettingsSync(); }
    finally { setBusy(false); }
  };
  return (
    <Section id="settings-sync" title="Settings sync" sx={{ borderBottom: 1, borderColor: 'divider', pb: 2 }}>
      <Box id="h5-settings-sync" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Hint>{t('Linked devices use one set of settings. Each part below says whether a change is copied to the other devices or stays on this one.')}</Hint>
        <Box component="ul" id="h5-settings-sync-peers" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {sync.peers.map(peer => (
            <Typography component="li" key={peer.name} variant="body2" className="h5-settings-sync-peer" data-peer={peer.name} data-online={peer.online ? 'true' : 'false'} color={peer.last_error ? 'error' : 'text.secondary'} sx={{ overflowWrap: 'anywhere' }}>
              <Box component="strong" translate="no" sx={{ color: 'text.primary', fontWeight: 600 }}>{peer.name}</Box>
              {` · ${peerStatus(peer, { t })}`}
            </Typography>
          ))}
        </Box>
        <Button id="h5-settings-sync-now" variant="outlined" disabled={busy} onClick={() => void now()} sx={{ alignSelf: 'flex-start' }}>{t('Sync now')}</Button>
        <Feedback id="h5-settings-sync-feedback" feedback={feedback} />
      </Box>
    </Section>
  );
}
