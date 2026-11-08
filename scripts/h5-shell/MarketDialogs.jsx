import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { api, errorText, named, t } from './common.jsx';
import { Field, Hint } from './Form.jsx';
import { Icon } from './Icons.jsx';
import { BASE } from './attention-feed.mjs';
import {
  capabilityText, filesText, isExpiredError, normalizeSources, parseGitSource, prepareBody, previewExpired, previewModel, removeRequest, sourceProblem,
} from './market-model.mjs';

// The dialogs of the plugin marketplace (PluginMarket.jsx): the install / update confirmation with the prepared preview, "Install from Git
// URL…", "Link local folder…", "Sources" and the remove confirmation. Server side: /api/attention/market/* (services/attention-market.js; see
// "Plugin marketplace" in DESIGN.md). Nothing is installed before the person presses Install in the confirmation dialog.

// Examples in the empty fields: addresses and paths, not text to translate.
const GIT_EXAMPLE = 'https://github.com/owner/repo.git#v1.0.0';
const FOLDER_EXAMPLE = '/home/me/my-notifier';
const INDEX_EXAMPLE = 'https://example.com/marketplace.json';

const ErrorLine = ({ id, text }) => (text ? <Typography id={id} role="alert" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{text}</Typography> : null);

// One "Label: value" line of the preview; the value is plugin or Git content and is not translated.
function Fact({ name, label, children }) {
  return (
    <Box className="h5-market-fact" data-fact={name} sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1, typography: 'body2', minWidth: 0 }}>
      <Box component="span" sx={{ color: 'text.secondary', flex: '0 0 auto' }}>{t(label)}</Box>
      <Box component="span" translate="no" sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

// The confirmation of an install or an update. `request` is { mode: 'install'|'git'|'update', name?, url? }: on open the page asks
// POST /market/prepare (a clone into a temporary folder; nothing is active), shows what was prepared, and only the Install button sends
// POST /market/install { prepareId, confirm: true }. A prepare is good for 10 minutes; after that the dialog offers "Prepare again".
export function ConfirmInstallDialog({ request, onClose, onInstalled }) {
  const open = Boolean(request);
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expired, setExpired] = useState(false);
  const live = useRef(0);

  const prepare = async () => {
    const run = ++live.current;
    setModel(null); setError(''); setExpired(false); setBusy(true);
    try {
      const preview = await api('POST', `${BASE}/market/prepare`, prepareBody(request));
      if (run !== live.current) return;
      setModel(previewModel(preview, { receivedAt: Date.now() }));
      setNow(Date.now());
    } catch (failure) {
      if (run === live.current) setError(`${t('Failed')}: ${errorText(failure)}`);
    } finally { if (run === live.current) setBusy(false); }
  };

  useEffect(() => {
    if (open) void prepare();
    else { live.current += 1; setModel(null); setError(''); setExpired(false); setBusy(false); }
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps -- a new prepare for each request

  // The expiry clock: once a second while a preview is shown.
  useEffect(() => {
    if (!open || !model) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, model]);

  const stale = expired || (model && previewExpired(model, now));
  const install = async () => {
    if (!model || stale) return;
    setBusy(true); setError('');
    const run = live.current;
    try {
      const result = await api('POST', `${BASE}/market/install`, { prepareId: model.prepareId, confirm: true });
      if (run !== live.current) return;
      onInstalled(result, request);
    } catch (failure) {
      if (run !== live.current) return;
      if (isExpiredError(failure)) setExpired(true);
      else setError(`${t('Failed')}: ${errorText(failure)}`);
    } finally { if (run === live.current) setBusy(false); }
  };

  const updating = request && request.mode === 'update';
  const title = updating ? t('Update plugin') : t('Install plugin');
  return (
    <Dialog id="h5-market-confirm" open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm" aria-labelledby="h5-market-confirm-title">
      <DialogTitle id="h5-market-confirm-title" sx={{ fontSize: 18 }}>{title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {!model && busy ? <Hint id="h5-market-preparing">{t('Fetching the plugin and checking it… Nothing is installed yet.')}</Hint> : null}
        <ErrorLine id="h5-market-confirm-error" text={error} />
        {model ? (
          <>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
              <Box component="strong" translate="no" id="h5-market-confirm-name" sx={{ overflowWrap: 'anywhere' }}>{model.name}</Box>
              <Typography variant="caption" component="span" color="text.secondary" translate="no" id="h5-market-confirm-version">
                {model.update && model.update.fromVersion ? `${model.update.fromVersion} → ${model.update.toVersion}` : model.version}
              </Typography>
            </Box>
            {model.description ? <Typography variant="body2" color="text.secondary" translate="no" sx={{ overflowWrap: 'anywhere' }}>{model.description}</Typography> : null}
            <Fact name="source" label="Source:">{model.sourceUrl}{model.subfolder ? ` : ${model.subfolder}` : ''}</Fact>
            <Fact name="commit" label="Commit:">{model.shortCommit}{model.ref ? ` (${model.ref})` : ''}</Fact>
            <Fact name="kind" label="What it can do:">{capabilityText(model, { t })}</Fact>
            {model.configFields.length ? <Fact name="config" label="Settings:">{model.configFields.map(field => field.label).join(', ')}</Fact> : null}
            <Fact name="files" label="Files:">{filesText(model, { t })}</Fact>
            {model.update && model.update.filesChanged !== null ? <Fact name="changed" label="Files changed:">{String(model.update.filesChanged)}</Fact> : null}
            {model.warnings.length || model.dependencyWarning ? (
              <Box id="h5-market-warnings" role="alert" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, p: 1, borderRadius: 1, border: 1, borderColor: 'warning.main', color: 'warning.light' }}>
                <Typography variant="body2" component="strong" sx={{ fontWeight: 700 }}>{t('Warnings')}</Typography>
                {model.warnings.map(warning => <Typography key={warning} variant="body2" className="h5-market-warning" sx={{ overflowWrap: 'anywhere' }}>{t(warning)}</Typography>)}
                {model.dependencyWarning ? (
                  <Typography variant="body2" className="h5-market-warning" data-warning="dependencies" sx={{ overflowWrap: 'anywhere' }}>
                    {t('It lists dependencies that are not installed:')} <span translate="no">{model.dependencies.join(', ')}</span>
                  </Typography>
                ) : null}
              </Box>
            ) : null}
            <Hint>{t('A plugin runs inside T-Agent with its rights. Install only plugins you trust.')}</Hint>
            {stale ? <Typography id="h5-market-expired" role="alert" variant="body2" color="warning.light">{t('This check is older than 10 minutes. Prepare it again before installing.')}</Typography> : null}
          </>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button id="h5-market-confirm-cancel" disabled={busy && Boolean(model)} onClick={onClose}>{t('Cancel')}</Button>
        {stale || (error && !model) ? <Button id="h5-market-prepare-again" disabled={busy} onClick={() => void prepare()}>{t('Prepare again')}</Button> : null}
        <Button id="h5-market-confirm-install" variant="contained" disabled={!model || stale || busy} onClick={() => void install()}>{updating ? t('Update') : t('Install')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// "Install from Git URL…": the address is checked here (https:// or git@, #ref, :subfolder), then the confirmation dialog prepares it.
export function GitUrlDialog({ open, onClose, onContinue }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setText(''); setError(''); } }, [open]);
  const parsed = parseGitSource(text);
  const next = () => {
    if (parsed.error) { setError(t(parsed.error)); return; }
    onContinue(parsed.url);
  };
  return (
    <Dialog id="h5-market-git" open={open} onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="h5-market-git-title">
      <DialogTitle id="h5-market-git-title" sx={{ fontSize: 18 }}>{t('Install from Git URL')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, pt: '8px !important' }}>
        <Field id="h5-market-git-url" label="Git URL" value={text} placeholder={GIT_EXAMPLE} onChange={event => { setText(event.target.value); setError(''); }}
          onKeyDown={event => { if (event.key === 'Enter') next(); }} htmlInput={{ inputMode: 'url' }} />
        <Hint>{t('https:// or git@ address. Add #tag, #branch or #commit to pick a version, and :folder when the plugin is in a subfolder.')}</Hint>
        {!parsed.error && (parsed.ref || parsed.subfolder) ? (
          <Typography id="h5-market-git-parsed" variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {parsed.ref ? <>{t('Version:')} <span translate="no">{parsed.ref}</span> </> : null}
            {parsed.subfolder ? <>{t('Folder:')} <span translate="no">{parsed.subfolder}</span></> : null}
          </Typography>
        ) : null}
        <ErrorLine id="h5-market-git-error" text={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-market-git-next" variant="contained" disabled={!text.trim()} onClick={next}>{t('Check')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// "Link local folder…" (development): POST /market/link { path } with a folder on the machine that runs this Client. The plugin runs from
// that folder and is marked "Dev"; notifiers reload when its files change.
export function LinkDialog({ open, onClose, onLinked }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPath(''); setError(''); setBusy(false); } }, [open]);
  const link = async () => {
    const folder = path.trim();
    if (!/^(\/|[A-Za-z]:[\\/]|~\/)/.test(folder)) { setError(t('Enter the absolute path of the folder')); return; }
    setBusy(true); setError('');
    try { onLinked(await api('POST', `${BASE}/market/link`, { path: folder })); }
    catch (failure) { setError(`${t('Failed')}: ${errorText(failure)}`); }
    finally { setBusy(false); }
  };
  return (
    <Dialog id="h5-market-link" open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="h5-market-link-title">
      <DialogTitle id="h5-market-link-title" sx={{ fontSize: 18 }}>{t('Link local folder')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, pt: '8px !important' }}>
        <Hint>{t('For plugin development: T-Agent runs the plugin straight from a folder on the machine that runs this Client. The folder needs a manifest.json.')}</Hint>
        <Field id="h5-market-link-path" label="Folder" value={path} placeholder={FOLDER_EXAMPLE} onChange={event => { setPath(event.target.value); setError(''); }}
          onKeyDown={event => { if (event.key === 'Enter') void link(); }} />
        <ErrorLine id="h5-market-link-error" text={error} />
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-market-link-save" variant="contained" disabled={busy || !path.trim()} onClick={() => void link()}>{t('Link')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// "Sources": the official index (fixed) and up to 10 extra index URLs (https only), GET / PUT /market/sources { extra }. Each change is saved
// at once; the listing is read again when the dialog closes.
export function SourcesDialog({ open, onClose }) {
  const [sources, setSources] = useState(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = useRef(false);
  useEffect(() => {
    if (!open) return;
    setSources(null); setText(''); setError(''); changed.current = false;
    api('GET', `${BASE}/market/sources`).then(data => setSources(normalizeSources(data)), failure => setError(`${t('Failed')}: ${errorText(failure)}`));
  }, [open]);
  const save = async extra => {
    setBusy(true); setError('');
    try { setSources(normalizeSources(await api('PUT', `${BASE}/market/sources`, { extra }))); changed.current = true; return true; }
    catch (failure) { setError(`${t('Failed')}: ${errorText(failure)}`); return false; }
    finally { setBusy(false); }
  };
  const add = async () => {
    const problem = sourceProblem(text, sources ? sources.extra : []);
    if (problem) { setError(t(problem)); return; }
    if (await save([...sources.extra, text.trim()])) setText('');
  };
  const close = () => onClose(changed.current);
  return (
    <Dialog id="h5-market-sources" open={open} onClose={busy ? undefined : close} fullWidth maxWidth="sm" aria-labelledby="h5-market-sources-title">
      <DialogTitle id="h5-market-sources-title" sx={{ fontSize: 18 }}>{t('Plugin sources')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Hint>{t('Indexes are marketplace.json lists of plugins. The official one comes with T-Agent; you can add your own (https only).')}</Hint>
        {!sources && !error ? <Hint>{t('Loading…')}</Hint> : null}
        {sources ? (
          <Box id="h5-market-sources-list" component="ul" sx={{ m: 0, p: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {sources.official ? (
              <Box component="li" className="h5-market-source" data-official="true" sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 36, minWidth: 0 }}>
                <Box component="span" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, typography: 'body2', overflowWrap: 'anywhere' }}>{sources.official}</Box>
                <Typography variant="caption" color="text.secondary" sx={{ flex: '0 0 auto' }}>{t('Official')}</Typography>
              </Box>
            ) : null}
            {sources.extra.map(url => (
              <Box component="li" key={url} className="h5-market-source" data-url={url} sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                <Box component="span" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, typography: 'body2', overflowWrap: 'anywhere' }}>{url}</Box>
                <IconButton size="small" className="h5-market-source-remove" disabled={busy} onClick={() => void save(sources.extra.filter(entry => entry !== url))} {...named(t('Remove source'))}><Icon name="close" size={18} /></IconButton>
              </Box>
            ))}
          </Box>
        ) : null}
        {sources ? (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
            <Field id="h5-market-source-url" label="Index URL" value={text} placeholder={INDEX_EXAMPLE} onChange={event => { setText(event.target.value); setError(''); }}
              onKeyDown={event => { if (event.key === 'Enter') void add(); }} htmlInput={{ inputMode: 'url' }} />
            <Button id="h5-market-source-add" variant="outlined" disabled={busy || !text.trim()} onClick={() => void add()} sx={{ flex: '0 0 auto', minHeight: 40 }}>{t('Add')}</Button>
          </Box>
        ) : null}
        <ErrorLine id="h5-market-sources-error" text={error} />
      </DialogContent>
      <DialogActions>
        <Button id="h5-market-sources-close" disabled={busy} onClick={close}>{t('Done')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// The remove confirmation. A user plugin's folder is deleted (its stored settings are kept unless "Also delete its settings" is ticked);
// a linked plugin only loses the link, its folder stays.
export function RemoveDialog({ entry, onClose, onRemoved }) {
  const open = Boolean(entry);
  const [purge, setPurge] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPurge(false); setError(''); setBusy(false); } }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps -- reset per entry
  const remove = async () => {
    const { method, path } = removeRequest(entry, { purge });
    setBusy(true); setError('');
    try { onRemoved(await api(method, `${BASE}${path}`), entry); }
    catch (failure) { setError(`${t('Failed')}: ${errorText(failure)}`); }
    finally { setBusy(false); }
  };
  return (
    <Dialog id="h5-market-remove" open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="h5-market-remove-title">
      <DialogTitle id="h5-market-remove-title" sx={{ fontSize: 18 }}>{entry && entry.dev ? t('Unlink plugin') : t('Remove plugin')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="body1" translate="no" component="strong" sx={{ overflowWrap: 'anywhere' }}>{entry ? entry.name : ''}</Typography>
        {entry && entry.dev
          ? <Hint>{t('The link is removed. The folder and its files stay where they are.')}</Hint>
          : (
            <>
              <Hint>{t('The plugin folder is deleted and the plugin stops at once.')}</Hint>
              <FormControlLabel control={<Checkbox checked={purge} disabled={busy} onChange={event => setPurge(event.target.checked)} slotProps={{ input: { id: 'h5-market-remove-purge' } }} />} label={t('Also delete its saved settings')} />
            </>
          )}
        <ErrorLine id="h5-market-remove-error" text={error} />
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-market-remove-confirm" variant="contained" color="error" disabled={busy} onClick={() => void remove()}>{entry && entry.dev ? t('Unlink') : t('Remove')}</Button>
      </DialogActions>
    </Dialog>
  );
}
