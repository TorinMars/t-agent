// "Updated to v…": the dialog the person sees once after the service was updated ("Notice after an update" in docs/design/update-check-and-versions.md).
// A chunk of its own (screen-updated.jsx), loaded only when the updater's read of /api/system/update-status says `updated_notice` (Update.jsx, through
// lazy-screens.jsx `showUpdatedNotice`), so the first screen carries one call for it. It draws into a root of its own with the page's theme.
//
// - It asks GET /api/system/updated-notice and shows nothing when the answer says no. Only the top page (never a pane of the multi-column view).
// - It waits while the page is hidden, another dialog or sheet is open (the Update dialog, an update being followed) or a key was pressed in the
//   last moment, so the dialog never takes keys typed into the terminal; it is tried again every half second and when the tab is shown.
// - OK, Escape and a click outside close it and count as seen: POST /api/system/updated-notice with the version and the linked lines shown. The focus
//   goes back where it was (MUI); when that was nowhere, to the terminal as the page would put it (`ui.actions.focusTerminal`, h5.js).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { ThemeProvider } from '@mui/material/styles';
import { api, t } from './common.jsx';
import { theme } from './theme.mjs';

const tf = (template, ...values) => t(template).replace(/\{(\d)\}/g, (all, number) => String(values[Number(number) - 1]));
const QUIET_KEYS_MS = 1500; // no key for this long before the dialog may take the focus
const RETRY_MS = 500;

// "Nov 20, 00:42" in the browser's time zone (the year too when it is not this year), in the language of the page.
export function updatedWhen(value, lang = typeof I18n !== 'undefined' ? I18n.get() : 'en', today = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (date.getFullYear() !== today.getFullYear()) options.year = 'numeric';
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', options);
}

function UpdatedNoticeDialog({ notice, onClose, onExited }) {
  const [open, setOpen] = useState(true);
  const close = () => { if (!open) return; setOpen(false); onClose(); };
  const notes = Array.isArray(notice.notes) ? notice.notes : [];
  const linked = Array.isArray(notice.linked) ? notice.linked : [];
  return (
    <Dialog id="h5-updated-dialog" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-updated-title" aria-describedby="h5-updated-body"
      slotProps={{ transition: { onExited } }}>
      <DialogTitle id="h5-updated-title">{tf('Updated to v{1}', notice.version)}</DialogTitle>
      <DialogContent>
        <DialogContentText id="h5-updated-body" variant="body2">
          {tf('T-Agent on {1} was updated on {2}, from v{3}.', notice.engine_name || t('This computer'), updatedWhen(notice.updated_at), notice.previous_version)}
        </DialogContentText>
        {linked.map(row => (
          <DialogContentText key={row.id} className="h5-updated-linked" variant="body2" sx={{ mt: 1 }}>{tf('{1} was also updated to v{2}.', row.name, row.version)}</DialogContentText>
        ))}
        {notes.length ? (
          <>
            <Typography variant="overline" component="h3" color="text.secondary" sx={{ display: 'block', mt: 2, mb: 0.5, lineHeight: '16px' }}>{t("What's new")}</Typography>
            <Box id="h5-updated-notes" translate="no" role="list" sx={{ maxHeight: 'min(280px, 40vh)', overflowY: 'auto', mx: -0.5, px: 0.5 }}>
              {notes.map(row => (
                <Box key={row.version} role="listitem" className="h5-updated-note" sx={{ display: 'flex', gap: 1.5, py: 0.75 }}>
                  <Typography component="span" variant="body2" color="primary" sx={{ flex: '0 0 auto', minWidth: 62, fontVariantNumeric: 'tabular-nums' }}>v{row.version}</Typography>
                  <Typography component="span" variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{row.note}</Typography>
                </Box>
              ))}
            </Box>
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button id="h5-updated-ok" onClick={close}>{t('OK')}</Button>
      </DialogActions>
    </Dialog>
  );
}

let lastKey = 0;
let busy = false; // asking, waiting, shown or acknowledging: a second read of update-status does nothing meanwhile
if (typeof document !== 'undefined') document.addEventListener('keydown', () => { lastKey = Date.now(); }, true);

const otherLayerOpen = () => Boolean(document.querySelector('.MuiModal-root:not(.MuiModal-hidden), dialog[open]'));
const free = () => !document.hidden && !otherLayerOpen() && Date.now() - lastKey >= QUIET_KEYS_MS;
function whenFree() {
  return new Promise(resolve => {
    const check = () => {
      if (!free()) return;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      resolve();
    };
    const timer = setInterval(check, RETRY_MS);
    document.addEventListener('visibilitychange', check);
    check();
  });
}

function mount(notice, ui) {
  const host = document.createElement('div');
  host.id = 'h5-updated-root';
  document.body.appendChild(host);
  const root = createRoot(host);
  const acknowledge = () => {
    const linked = (notice.linked || []).map(({ id, version }) => ({ id, version }));
    api('POST', '/api/system/updated-notice', { version: notice.version, linked }).catch(() => { /* shown again on the next read */ }).finally(() => { busy = false; });
  };
  const exited = () => {
    root.unmount();
    host.remove();
    const active = document.activeElement;
    if ((!active || active === document.body) && ui && ui.actions && ui.actions.focusTerminal) ui.actions.focusTerminal();
  };
  root.render(<ThemeProvider theme={theme}><UpdatedNoticeDialog notice={notice} onClose={acknowledge} onExited={exited} /></ThemeProvider>);
}

// Called by the updater whenever update-status says there is a notice for this person.
export async function showUpdatedNotice(ui) {
  if (busy || window.H5Pane || window.top !== window) return;
  busy = true;
  try {
    const notice = await api('GET', '/api/system/updated-notice');
    if (!notice || !notice.show) { busy = false; return; }
    await whenFree();
    mount(notice, ui);
  } catch {
    busy = false;
  }
}
