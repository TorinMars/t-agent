import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import { api, errorText, named, t } from './common.jsx';
import { Feedback, Hint, Section, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import CloseIcon from '@mui/icons-material/Close';

// "Site library", a part of the Settings group "Tasks and files" (`#h5-sec-browser-sites`): the site capability library (what the model has learnt
// about each website; services/browser-sites.js, "Site library" in DESIGN.md). It is read-only here plus delete; agents write it with `tcli site`.
// The entries are shared across linked devices (scope "shared"). GET /api/browser-sites lists them; opening one reads GET /api/browser-sites/:site
// and shows its summary, pages, actions and APIs; the Delete button calls DELETE /api/browser-sites/:site. Hosts, selectors and URLs are not
// translated; the headings are. The summary is shown as its Markdown source (kept readable, never rendered as HTML, so nothing a site stored can run).
const BASE = '/api/browser-sites';

function EntryDialog({ site, onClose, onDeleted, say }) {
  const [entry, setEntry] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      try { const answer = await api('GET', `${BASE}/${encodeURIComponent(site)}`); if (live) setEntry(answer.site); }
      catch (error) { if (live) { say(`${t('Failed')}: ${errorText(error)}`, true); onClose(); } }
    })();
    return () => { live = false; };
  }, [site]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async () => {
    setBusy(true);
    try { await api('DELETE', `${BASE}/${encodeURIComponent(site)}`); say(`${t('Deleted')} ${site}`); onDeleted(); onClose(); }
    catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open fullWidth maxWidth="sm" onClose={busy ? undefined : onClose} aria-labelledby="h5-site-entry-title" slotProps={{ paper: { className: 'h5-site-entry' } }}>
      <DialogTitle id="h5-site-entry-title" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, pr: 1 }}>
        <Box component="span" translate="no" sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{entry && entry.title ? entry.title : site}</Box>
        <IconButton {...named(t('Close'))} edge="end" onClick={onClose} disabled={busy}><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {!entry ? <Hint id="h5-site-entry-loading">{t('Loading…')}</Hint> : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" translate="no">{site}</Typography>
            {entry.summary ? <Typography component="pre" className="h5-site-summary" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{entry.summary}</Typography> : <Hint>{t('No summary yet.')}</Hint>}
            {Array.isArray(entry.pages) && entry.pages.length ? (
              <Box className="h5-site-pages"><Typography variant="subtitle2">{t('Pages')}</Typography>
                {entry.pages.map((page, i) => <Typography key={i} variant="body2" translate="no" sx={{ overflowWrap: 'anywhere' }}>{page.pattern}{page.purpose ? ` — ${page.purpose}` : ''}</Typography>)}
              </Box>
            ) : null}
            {Array.isArray(entry.actions) && entry.actions.length ? (
              <Box className="h5-site-actions"><Typography variant="subtitle2">{t('Actions')}</Typography>
                {entry.actions.map((action, i) => (
                  <Box key={i} sx={{ mb: 0.5 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}><Box component="span" translate="no">{action.name}</Box>{action.description ? ` — ${action.description}` : ''}</Typography>
                    {(action.steps || []).map((step, j) => <Typography key={j} variant="caption" color="text.secondary" component="div" translate="no" sx={{ pl: 1.5, overflowWrap: 'anywhere' }}>{step}</Typography>)}
                  </Box>
                ))}
              </Box>
            ) : null}
            {Array.isArray(entry.apis) && entry.apis.length ? (
              <Box className="h5-site-apis"><Typography variant="subtitle2">{t('APIs')}</Typography>
                {entry.apis.map((apiEntry, i) => (
                  <Box key={i} sx={{ mb: 0.5 }}>
                    <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}><Box component="span" sx={{ fontWeight: 600 }} translate="no">{apiEntry.name}</Box>{apiEntry.method || apiEntry.url ? <Box component="span" translate="no" sx={{ fontFamily: 'monospace', ml: 1 }}>{[apiEntry.method, apiEntry.url].filter(Boolean).join(' ')}</Box> : null}</Typography>
                    {apiEntry.description ? <Typography variant="caption" color="text.secondary" component="div" sx={{ pl: 1.5 }}>{apiEntry.description}</Typography> : null}
                    {apiEntry.auth ? <Typography variant="caption" color="text.secondary" component="div" sx={{ pl: 1.5 }}>{t('Auth')}: <Box component="span" translate="no">{apiEntry.auth}</Box></Typography> : null}
                  </Box>
                ))}
              </Box>
            ) : null}
            {entry.notes ? <Box className="h5-site-notes"><Typography variant="subtitle2">{t('Notes')}</Typography><Typography component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{entry.notes}</Typography></Box> : null}
            <Typography variant="caption" color="text.secondary">{t('Edit entries from an agent session with the tcli site command.')}</Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button className="h5-site-delete" color="error" onClick={remove} disabled={busy || !entry}>{t('Delete')}</Button>
        <Button onClick={onClose} disabled={busy}>{t('Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function BrowserSitesSection({ opened }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try { setData(await api('GET', BASE)); } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group is opened
  const sites = data && Array.isArray(data.sites) ? data.sites : [];
  return (
    <Section id="browser-sites" title="Site library" aside={<ScopeLabel id="browser-sites" scope="shared" />}>
      <Hint>{t('What agent sessions have learnt about each website, read and written with tcli site. Shared across your linked devices.')}</Hint>
      <Box id="h5-browser-sites" aria-busy={data ? 'false' : 'true'} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {!data ? <Hint id="h5-browser-sites-loading">{t('Loading…')}</Hint> : sites.length ? sites.map(item => (
          <Box
            key={item.site} component="button" type="button" className="h5-browser-site" data-site={item.site} onClick={() => setOpen(item.site)}
            sx={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 0.25, p: 1.25, borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: 'transparent', color: 'inherit', cursor: 'pointer', minWidth: 0, '&:hover': { borderColor: 'primary.main' } }}
          >
            <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}><Box component="span" translate="no" sx={{ fontFamily: 'monospace' }}>{item.site}</Box>{item.title && item.title !== item.site ? ` · ${item.title}` : ''}</Typography>
            {item.summary ? <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{item.summary}</Typography> : null}
            <Typography variant="caption" color="text.secondary" className="h5-browser-site-counts">{item.actions} {t('actions')} · {item.apis} {t('APIs')}</Typography>
          </Box>
        )) : <Hint id="h5-browser-sites-empty">{t('No sites yet. Agent sessions add entries as they explore the web with the browser extension.')}</Hint>}
      </Box>
      <Feedback id="h5-browser-sites-feedback" feedback={feedback} />
      {open ? <EntryDialog site={open} onClose={() => setOpen(null)} onDeleted={() => void load()} say={say} /> : null}
    </Section>
  );
}
