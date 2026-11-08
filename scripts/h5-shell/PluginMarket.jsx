import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Pill, api, errorText, t } from './common.jsx';
import { Feedback, Field, Hint, useFeedback } from './Form.jsx';
import { BASE } from './attention-feed.mjs';
import { ConfirmInstallDialog, GitUrlDialog, LinkDialog, RemoveDialog, SourcesDialog } from './MarketDialogs.jsx';
import { KINDS, KIND_LABELS, SEARCH_DEBOUNCE_MS, applyUpdates, entryActions, entryBadges, filterEntries, marketQuery, normalizeMarket, updatesSummary, versionText } from './market-model.mjs';

// The "Marketplace" tab of Settings → T-Attention → Plugins (PluginSettings.jsx): the plugins of the official index and the extra sources,
// merged with what is installed (GET /api/attention/market?q=&kind=), a search box (asked again 300 ms after the last key), the kind filter,
// and the Install / Update / Remove actions. Install and Update always go through ConfirmInstallDialog (MarketDialogs.jsx). Plugin names,
// versions, descriptions, authors and tags are plugin content: not translated. `onChanged` reads the Installed tab again.

function MarketCard({ entry, onInstall, onUpdate, onRemove }) {
  const badges = entryBadges(entry);
  const actions = entryActions(entry);
  return (
    <Paper variant="outlined" className="h5-market-card" data-name={entry.name} data-kind={entry.kind} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.25, minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
        <Box component="strong" translate="no" sx={{ overflowWrap: 'anywhere' }}>{entry.name}</Box>
        <Typography variant="caption" component="span" color="text.secondary" translate="no" className="h5-market-version">{versionText(entry)}</Typography>
        {entry.kind ? <Typography variant="caption" component="span" color="text.secondary" className="h5-market-kind">{t(KIND_LABELS[entry.kind])}</Typography> : null}
      </Box>
      {badges.length ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {badges.map(badge => <Pill key={badge.key} className="h5-market-badge" data-badge={badge.key} label={t(badge.label)} tone={badge.tone} />)}
        </Box>
      ) : null}
      {entry.description ? <Typography variant="body2" color="text.secondary" translate="no" sx={{ overflowWrap: 'anywhere' }}>{entry.description}</Typography> : null}
      {entry.author || entry.tags.length || entry.homepage ? (
        <Typography variant="caption" color="text.secondary" className="h5-market-meta" sx={{ overflowWrap: 'anywhere' }}>
          {entry.author ? <>{t('By')} <span translate="no">{entry.author}</span></> : null}
          {entry.author && entry.tags.length ? ' · ' : null}
          {entry.tags.length ? <span translate="no" className="h5-market-tags">{entry.tags.map(tag => `#${tag}`).join(' ')}</span> : null}
          {entry.homepage ? <>{entry.author || entry.tags.length ? ' · ' : null}<Link href={entry.homepage} target="_blank" rel="noopener noreferrer">{t('Homepage')}</Link></> : null}
        </Typography>
      ) : null}
      {actions.install || actions.update || actions.remove ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {actions.install ? <Button size="small" variant="contained" className="h5-market-install" onClick={() => onInstall(entry)}>{t('Install')}</Button> : null}
          {actions.update ? <Button size="small" variant="contained" className="h5-market-update" onClick={() => onUpdate(entry)}>{t('Update')}</Button> : null}
          {actions.remove ? <Button size="small" color="error" className="h5-market-remove" onClick={() => onRemove(entry)}>{entry.dev ? t('Unlink') : t('Remove')}</Button> : null}
        </Box>
      ) : null}
    </Paper>
  );
}

export default function PluginMarket({ refresh = 0, onChanged }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(null); // the request of ConfirmInstallDialog
  const [removing, setRemoving] = useState(null);
  const [dialog, setDialog] = useState(''); // 'git' | 'link' | 'sources'
  const [feedback, say] = useFeedback();
  const [checking, setChecking] = useState(false);
  const updates = useRef(null); // the last answer of GET /market/updates, laid over each listing
  const filter = useRef({ q: '', kind: '' });
  const seq = useRef(0);

  const load = async (q = filter.current.q, k = filter.current.kind) => {
    const run = ++seq.current;
    setLoading(true);
    try {
      const answer = normalizeMarket(await api('GET', `${BASE}/market${marketQuery({ q, kind: k })}`), { q, kind: k });
      if (run !== seq.current) return;
      setData({ ...answer, plugins: applyUpdates(answer.plugins, updates.current) }); setError('');
    } catch (failure) {
      if (run === seq.current) setError(`${t('Failed')}: ${errorText(failure)}`);
    } finally { if (run === seq.current) setLoading(false); }
  };

  // The first read, and again on the section's Refresh button.
  useEffect(() => { void load(); }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps -- read on mount and on Refresh
  // The search waits for a pause in typing; the kind filter asks at once.
  useEffect(() => {
    if (filter.current.q === query && filter.current.kind === kind) return undefined;
    const now = filter.current.kind !== kind;
    filter.current = { q: query, kind };
    if (now) { void load(query, kind); return undefined; }
    const timer = setTimeout(() => void load(query, kind), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, kind]); // eslint-disable-line react-hooks/exhaustive-deps -- load reads the refs

  // "Check for updates": a `git ls-remote` per index or Git install on the server.
  const checkUpdates = async () => {
    setChecking(true);
    try { updates.current = await api('GET', `${BASE}/market/updates`); say(updatesSummary(updates.current, { t })); await load(); }
    catch (failure) { say(`${t('Failed')}: ${errorText(failure)}`, true); }
    finally { setChecking(false); }
  };
  const changed = message => { updates.current = null; say(message); void load(); if (onChanged) onChanged(); };
  const installed = (result, request) => {
    setConfirming(null);
    const name = (result && result.plugin && result.plugin.name) || request.name || '';
    changed(`${request.mode === 'update' ? t('Updated') : t('Installed')}: ${name}`);
  };
  const shown = data ? filterEntries(data.plugins, { q: query, kind }) : [];

  return (
    <Box id="h5-market" aria-busy={loading ? 'true' : 'false'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0 }}>
      <Field id="h5-market-search" label="Search plugins" type="search" value={query} onChange={event => setQuery(event.target.value)} />
      <Box id="h5-market-kinds" role="group" aria-label={t('Kind')} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
        {KINDS.map(option => (
          <Button key={option.key || 'all'} size="small" className="h5-market-kind-filter" data-kind={option.key} aria-pressed={kind === option.key ? 'true' : 'false'}
            variant={kind === option.key ? 'contained' : 'outlined'} onClick={() => setKind(option.key)} sx={{ borderRadius: 999, minWidth: 44, px: 1.5 }}>{t(option.label)}</Button>
        ))}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button size="small" variant="outlined" id="h5-market-git-open" onClick={() => setDialog('git')}>{t('Install from Git URL…')}</Button>
        <Button size="small" variant="outlined" id="h5-market-link-open" onClick={() => setDialog('link')}>{t('Link local folder…')}</Button>
        <Button size="small" id="h5-market-updates" disabled={checking} onClick={() => void checkUpdates()}>{t('Check for updates')}</Button>
        <Button size="small" id="h5-market-sources-open" onClick={() => setDialog('sources')}>{t('Sources')}</Button>
      </Box>
      <Feedback id="h5-market-feedback" feedback={feedback} />
      {error ? <Typography id="h5-market-error" role="alert" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{error}</Typography> : null}
      {data && data.errors.length ? (
        <Box id="h5-market-source-errors" sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          {data.errors.map(text => <Typography key={text} variant="body2" color="warning.light" sx={{ overflowWrap: 'anywhere' }}>{t(text)}</Typography>)}
        </Box>
      ) : null}
      {!data && loading ? <Hint id="h5-market-loading">{t('Loading…')}</Hint> : null}
      {data ? (
        <Box id="h5-market-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {shown.map(entry => (
            <MarketCard key={`${entry.name}:${entry.inIndex}`} entry={entry}
              onInstall={item => setConfirming({ mode: 'install', name: item.name })}
              onUpdate={item => setConfirming({ mode: 'update', name: item.name })}
              onRemove={item => setRemoving(item)} />
          ))}
          {!shown.length ? <Hint id="h5-market-empty">{query || kind ? t('No plugins match the search') : t('No plugins in the indexes')}</Hint> : null}
        </Box>
      ) : null}
      <ConfirmInstallDialog request={confirming} onClose={() => setConfirming(null)} onInstalled={installed} />
      <RemoveDialog entry={removing} onClose={() => setRemoving(null)} onRemoved={(_, entry) => { setRemoving(null); changed(`${entry.dev ? t('Unlinked') : t('Removed')}: ${entry.name}`); }} />
      <GitUrlDialog open={dialog === 'git'} onClose={() => setDialog('')} onContinue={url => { setDialog(''); setConfirming({ mode: 'git', url }); }} />
      <LinkDialog open={dialog === 'link'} onClose={() => setDialog('')} onLinked={result => { setDialog(''); changed(`${t('Linked')}: ${(result && result.plugin && result.plugin.name) || ''}`); }} />
      <SourcesDialog open={dialog === 'sources'} onClose={edited => { setDialog(''); if (edited) void load(); }} />
    </Box>
  );
}
