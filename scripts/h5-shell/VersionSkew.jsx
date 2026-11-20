// The banner at the top of the task list while a linked engine (or this one) runs an older version that lacks something the engines share
// ("When engines run different versions" in docs/design/update-check-and-versions.md). A chunk of its own (screen-skew.jsx): the task list draws it
// only when the update status said so (`version_skew`, kept by the updater in Update.jsx as `state.versionSkew`), and it then reads the details from
// GET /api/system/version-skew. "Update" opens the Update dialog. Closing it is remembered for that engine and version in the shared page state
// (`version-skew-closed:<instance id>` = the version), so it is closed on every device and engine, and comes back for the next older version.
import { useEffect, useState, useSyncExternalStore } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import { api, t } from './common.jsx';
import { Icon } from './Icons.jsx';

// What each shared capability keeps in step, in a few words. A capability that is not here (a newer engine's) is not named.
export const PHRASES = {
  'learn:sync': 'Learn progress',
  'page-state:sync': 'Recent sessions and layout',
  'settings:sync': 'Shared settings',
  'task-order': 'Task order',
  'updated-notice': 'Update notices',
  'notify:relay': 'Notification sending',
  'environment:tools': 'Environment compare',
};

const pageState = () => (typeof globalThis.TAPageState !== 'undefined' ? globalThis.TAPageState : null);
export const closedKey = engine => `version-skew-closed:${String(engine.instance_id || engine.id).toLowerCase().replace(/[^a-z0-9._:-]/g, '-').slice(0, 64)}`;
const subscribe = listener => { const store = pageState(); return store ? store.subscribe(listener) : () => {}; };
const readClosed = () => {
  const store = pageState();
  if (!store) return '';
  try { return store.keys().filter(key => key.startsWith('version-skew-closed:')).map(key => `${key}=${store.get(key) || ''}`).join('|'); } catch { return ''; }
};
const closedFor = (closed, engine) => {
  const key = `${closedKey(engine)}=`;
  const entry = closed.split('|').find(item => item.startsWith(key));
  return entry ? entry.slice(key.length) : null;
};

const language = () => { try { return globalThis.I18n && globalThis.I18n.get ? globalThis.I18n.get() : 'en'; } catch { return 'en'; } };
function joinList(items) {
  try { return new Intl.ListFormat(language() === 'zh' ? 'zh' : 'en', { style: 'long', type: 'conjunction' }).format(items); } catch { return items.join(', '); }
}
// The sentence of one engine: its name, its version and the named features, or a general phrase when none of them is known here.
export function skewText(engine) {
  const named = [...new Set(engine.missing.map(name => PHRASES[name]).filter(Boolean))].map(phrase => t(phrase));
  const lead = `${engine.name} runs an older version (v${engine.version}).`;
  if (!named.length) return t(`${lead} Some things shared between engines are not in step with it until it updates.`);
  return t(`${lead} ${joinList(named)} ${named.length === 1 ? 'is' : 'are'} not in step with it until it updates.`);
}

// `skew`: the update status's `version_skew`; the details are read again whenever it changes.
export function VersionSkewBanner({ ui, skew }) {
  const [view, setView] = useState(null);
  const [hidden, setHidden] = useState({}); // closed on this page (also where the shared page state is missing)
  const closed = useSyncExternalStore(subscribe, readClosed);
  useEffect(() => {
    let stop = false;
    api('GET', '/api/system/version-skew').then(next => { if (!stop) setView(next); }, () => { if (!stop) setView(null); });
    return () => { stop = true; };
  }, [skew]);
  const engines = view && Array.isArray(view.engines) ? view.engines : [];
  const shown = engines.filter(engine => Array.isArray(engine.missing) && engine.missing.length && closedFor(closed, engine) !== engine.version && hidden[closedKey(engine)] !== engine.version);
  if (!shown.length) return null;
  const close = engine => {
    setHidden(all => ({ ...all, [closedKey(engine)]: engine.version }));
    const store = pageState();
    try { if (store) store.set(closedKey(engine), engine.version); } catch { /* closed on this page only */ }
  };
  return (
    <Box id="h5-version-skew" sx={{ px: 1.5, pb: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {shown.map(engine => (
        <Alert
          key={closedKey(engine)} className="h5-version-skew" data-engine={engine.instance_id || engine.id} severity="warning" role="status"
          icon={<Icon name="warning" size={20} />}
          action={<IconButton className="h5-version-skew-close" color="inherit" size="small" aria-label={t('Close')} title={t('Close')} onClick={() => close(engine)}><Icon name="close" size={18} /></IconButton>}
          sx={{ typography: 'body2', overflowWrap: 'anywhere', '& .MuiAlert-message': { flex: '1 1 auto', minWidth: 0 }, '& .MuiAlert-action': { pt: 0.25, mr: -0.5, alignItems: 'flex-start' } }}
        >
          {/* An MD2 banner: the text, then its action at the bottom right; the close button stays at the top right. */}
          <span className="h5-version-skew-text">{skewText(engine)}</span>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5, mb: -0.5 }}>
            <Button className="h5-version-skew-update" color="inherit" size="small" onClick={() => ui.actions.openUpdate && ui.actions.openUpdate()} sx={{ fontWeight: 600 }}>{t('Update')}</Button>
          </Box>
        </Alert>
      ))}
    </Box>
  );
}
