import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { Pill, api, errorText, t } from './common.jsx';
import { Feedback, Field, Hint, Section, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { LocalOnly } from './DeviceTarget.jsx';
import { copyText } from './Attention.jsx';
import { countdownText, secondsLeft } from './plugins-model.mjs';
import { browserDetail, newlyPaired, normalizeStatus, pairCodeText } from './browser-ext-model.mjs';

// "Browser extension", a part of the Settings group "Tasks and files" (`#h5-sec-browser-ext`; "Browser extension" in DESIGN.md): the browsers
// paired with this T-Agent (GET /api/browser-ext, read each time the group opens), "Pair a browser" (POST /pair-code: a one-time code with a
// countdown and the steps to load the extension from this install's `extensions/chrome` folder), Rename (PATCH /:id) and Remove (DELETE /:id,
// which revokes the token and closes its connection). It always shows this device: the extension pairs only with the T-Agent on its own
// computer, so with a linked device chosen in "Settings for" it shows the note to open that device's own page. An older server (404): nothing.
const BASE = '/api/browser-ext';
const POLL_EVERY = 3; // seconds, while the pairing dialog is open
const FALLBACK_URL = 'http://127.0.0.1:3000';
const ERRORS = {
  INVALID_NAME: 'The name must be 1 to 60 characters on one line',
  BROWSER_NOT_FOUND: 'This browser is no longer paired',
};
const say = error => `${t('Failed')}: ${ERRORS[error && error.message] ? t(ERRORS[error.message]) : errorText(error)}`;

function CopyLine({ id, label, value }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [value]);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
      {label ? <Typography variant="body2" color="text.secondary">{label}</Typography> : null}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box component="code" id={id} translate="no" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', userSelect: 'all', fontSize: 13, px: 1, py: 0.75, borderRadius: 1, bgcolor: 'action.hover' }}>{value}</Box>
        <Button id={`${id}-copy`} variant="outlined" size="small" sx={{ flexShrink: 0, minHeight: 44 }} onClick={async () => setCopied(await copyText(value))}>{copied ? t('Copied') : t('Copy')}</Button>
      </Box>
    </Box>
  );
}

// The code, big, with a countdown and the steps. A browser that was not paired before appears in the list: the code was used.
function PairDialog({ open, status, onClose, onPaired }) {
  const [made, setMade] = useState(null); // { code, expiresAt }
  const [left, setLeft] = useState(0);
  const [paired, setPaired] = useState(null);
  const [error, setError] = useState('');
  const known = useRef([]);
  const run = useRef(0);

  const create = async () => {
    run.current += 1;
    const mine = run.current;
    setError(''); setPaired(null); setMade(null);
    try {
      const before = normalizeStatus(await api('GET', BASE));
      const created = await api('POST', `${BASE}/pair-code`, {});
      if (mine !== run.current) return;
      known.current = before.browsers.map(browser => browser.browser_id);
      const expiresAt = new Date(Date.now() + created.expires_in_seconds * 1000).toISOString();
      setMade({ code: created.code, expiresAt });
      setLeft(secondsLeft(expiresAt));
    } catch (failed) { if (mine === run.current) setError(say(failed)); }
  };
  useEffect(() => {
    if (open) void create();
    else run.current += 1;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- a new code each time the dialog opens

  useEffect(() => {
    if (!open || !made || paired) return undefined;
    let ticks = 0;
    const timer = setInterval(async () => {
      setLeft(secondsLeft(made.expiresAt));
      ticks += 1;
      if (ticks % POLL_EVERY) return;
      const mine = run.current;
      try {
        const now = normalizeStatus(await api('GET', BASE));
        const fresh = newlyPaired(known.current, now.browsers);
        if (!fresh || mine !== run.current) return;
        known.current.push(fresh.browser_id);
        setPaired(fresh);
        onPaired();
      } catch { /* the next read tries again */ }
    }, 1000);
    return () => clearInterval(timer);
  }, [open, made, paired]); // eslint-disable-line react-hooks/exhaustive-deps -- onPaired is only called

  const expired = Boolean(made) && !paired && left <= 0;
  const serverUrl = status.serverUrl || FALLBACK_URL;
  return (
    <Dialog id="h5-browser-pair-dialog" open={open} onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="h5-browser-pair-title">
      <DialogTitle id="h5-browser-pair-title" sx={{ fontSize: 18 }}>{t('Pair a browser')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {error ? <Typography id="h5-browser-pair-error" role="alert" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{error}</Typography> : null}
        {!made && !error ? <Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography> : null}
        {paired ? <Typography id="h5-browser-pair-done" role="status" variant="body1" sx={{ overflowWrap: 'anywhere' }}>{t('Paired:')} <span translate="no">{paired.name}</span></Typography> : null}
        {made && !paired ? (
          <>
            <Box id="h5-browser-pair-code" translate="no" aria-label={t('Pairing code')} sx={{ fontSize: 34, fontWeight: 700, letterSpacing: 3, textAlign: 'center', fontFamily: 'monospace', opacity: expired ? 0.4 : 1 }}>{pairCodeText(made.code)}</Box>
            <Typography id="h5-browser-pair-countdown" role="timer" variant="body2" color={expired ? 'error' : 'text.secondary'} sx={{ textAlign: 'center' }}>
              {expired ? t('The code expired') : `${t('Valid for')} ${countdownText(left)}`}
            </Typography>
            <Box component="ol" id="h5-browser-pair-steps" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 1.25, typography: 'body2' }}>
              <li>{t('In Chrome on the computer that runs T-Agent, open chrome://extensions and turn on Developer mode (top right).')}</li>
              <li>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  <span>{t('Click “Load unpacked” and choose this folder:')}</span>
                  <CopyLine id="h5-browser-ext-dir" value={status.extensionDir} />
                  {!status.extensionPresent ? <Typography id="h5-browser-ext-missing" role="alert" variant="body2" sx={{ color: 'warning.main' }}>{t('This folder is missing in this T-Agent install. Update T-Agent, then try again.')}</Typography> : null}
                </Box>
              </li>
              <li>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  <span>{t('Open the extension’s options (Details, then Extension options), enter this server address and the code above, then choose Pair.')}</span>
                  <CopyLine id="h5-browser-ext-url" value={serverUrl} />
                </Box>
              </li>
            </Box>
            <Button id="h5-browser-pair-copy" variant="outlined" disabled={expired} onClick={() => void copyText(made.code)}>{t('Copy the code')}</Button>
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        {expired || error ? <Button id="h5-browser-pair-new" onClick={() => void create()}>{t('New code')}</Button> : null}
        <Button id="h5-browser-pair-close" onClick={onClose}>{paired ? t('Done') : t('Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function RenameDialog({ browser, onClose, onDone }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (browser) { setName(browser.name); setError(''); } }, [browser]);
  const save = async () => {
    const value = name.trim();
    if (!value || [...value].length > 60) { setError(t(ERRORS.INVALID_NAME)); return; }
    setBusy(true);
    try { await api('PATCH', `${BASE}/${encodeURIComponent(browser.browser_id)}`, { name: value }); onDone(); }
    catch (failed) { setError(say(failed)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog id="h5-browser-rename" open={Boolean(browser)} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="h5-browser-rename-title">
      <DialogTitle id="h5-browser-rename-title" sx={{ fontSize: 18 }}>{t('Rename browser')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: '8px !important' }}>
        <Field id="h5-browser-rename-name" label="Name" value={name} onChange={event => setName(event.target.value)} htmlInput={{ maxLength: 120 }} onKeyDown={event => { if (event.key === 'Enter') void save(); }} />
        {error ? <Typography id="h5-browser-rename-error" role="alert" variant="body2" color="error">{error}</Typography> : null}
      </DialogContent>
      <DialogActions>
        <Button id="h5-browser-rename-cancel" color="inherit" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-browser-rename-save" variant="contained" disabled={busy} onClick={() => void save()}>{t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function RemoveDialog({ browser, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (browser) setError(''); }, [browser]);
  const remove = async () => {
    setBusy(true);
    try { await api('DELETE', `${BASE}/${encodeURIComponent(browser.browser_id)}`); onDone(); }
    catch (failed) { setError(say(failed)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog id="h5-browser-remove" open={Boolean(browser)} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="h5-browser-remove-title">
      <DialogTitle id="h5-browser-remove-title" sx={{ fontSize: 18 }}>{t('Remove this browser?')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="body2" translate="no" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{browser ? browser.name : ''}</Typography>
        <Typography variant="body2" color="text.secondary">{t('Its extension is disconnected and can no longer connect. To use it again, pair it again.')}</Typography>
        {error ? <Typography id="h5-browser-remove-error" role="alert" variant="body2" color="error">{error}</Typography> : null}
      </DialogContent>
      <DialogActions>
        <Button id="h5-browser-remove-cancel" color="inherit" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-browser-remove-accept" variant="contained" color="error" disabled={busy} onClick={() => void remove()}>{t('Remove')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function BrowserRow({ browser, onRename, onRemove }) {
  return (
    <Box component="li" className="h5-browser-row" data-browser={browser.browser_id} data-online={browser.online ? 'true' : 'false'} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.5, borderRadius: 1, border: 1, borderColor: 'divider', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <Box component="span" className="h5-browser-name" translate="no" sx={{ fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0, flex: '1 1 8rem' }}>{browser.name}</Box>
        <Pill className="h5-browser-state" label={t(browser.online ? 'Online' : 'Offline')} tone={browser.online ? 'success' : 'default'} />
        {browser.active ? <Pill className="h5-browser-active" label={t('Commands go here')} tone="primary" /> : null}
      </Box>
      <Typography variant="caption" color="text.secondary" className="h5-browser-detail" sx={{ overflowWrap: 'anywhere' }}>{browserDetail(browser, { t })}</Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button className="h5-browser-rename" variant="outlined" size="small" sx={{ minHeight: 44 }} onClick={onRename}>{t('Rename')}</Button>
        <Button className="h5-browser-remove" variant="outlined" color="error" size="small" sx={{ minHeight: 44 }} onClick={onRemove}>{t('Remove')}</Button>
      </Box>
    </Box>
  );
}

function BrowserExtPart({ opened }) {
  const [status, setStatus] = useState(null);
  const [supported, setSupported] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [feedback, sayLine] = useFeedback();
  const load = async () => {
    try { setStatus(normalizeStatus(await api('GET', BASE))); setSupported(true); }
    catch (error) {
      if (error.status === 404) { setSupported(false); return; }
      sayLine(say(error), true);
    }
  };
  useEffect(() => { if (opened) { sayLine(''); void load(); } }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group opens
  // Drawn once the first read answered: an older server (404) never shows the part, not even for a moment.
  if (!supported || (!status && !feedback.message)) return <span id="h5-browser-ext" hidden />;
  if (!status) {
    return <Section id="browser-ext" title="Browser extension"><Feedback id="h5-browser-ext-feedback" feedback={feedback} /></Section>;
  }
  return (
    <Section id="browser-ext" title="Browser extension" aside={<ScopeLabel follow={false} />}>
      <LocalOnly id="h5-browser-ext-remote">
        <Box id="h5-browser-ext" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
          <Hint>{t('Lets agent sessions use Chrome on this computer with tcli browser: open pages, click and type, read the page and its network traffic, and record how a site works. Only tabs T-Agent opened (the “T-Agent” tab group) and tabs you hand over with the extension button can be used. Cookies, tokens and passwords are hidden in what it reads.')}</Hint>
          {status.browsers.length ? (
            <Box component="ul" id="h5-browser-list" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              {status.browsers.map(browser => <BrowserRow key={browser.browser_id} browser={browser} onRename={() => setRenaming(browser)} onRemove={() => setRemoving(browser)} />)}
            </Box>
          ) : <Hint id="h5-browser-empty">{t('No browser is paired yet.')}</Hint>}
          <Box><Button id="h5-browser-pair" variant="contained" onClick={() => setPairing(true)}>{t('Pair a browser')}</Button></Box>
          <Hint>{t('The extension acts with your logged-in browser. Pair only a browser on this computer that you want T-Agent’s sessions to use.')}</Hint>
          <Feedback id="h5-browser-ext-feedback" feedback={feedback} />
        </Box>
        <PairDialog open={pairing} status={status} onClose={() => { setPairing(false); void load(); }} onPaired={() => void load()} />
        <RenameDialog browser={renaming} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); sayLine('Saved'); void load(); }} />
        <RemoveDialog browser={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); sayLine('Removed'); void load(); }} />
      </LocalOnly>
    </Section>
  );
}

export function BrowserExtSection(props) {
  return <BrowserExtPart {...props} />;
}
