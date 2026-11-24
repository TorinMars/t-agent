import { Fragment, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import { api, named, t } from './common.jsx';
import { Feedback, Hint, Section, SwitchRow, failure, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { Icon } from './Icons.jsx';
import { TOUCH } from './theme.mjs';
import { useStore } from './use-store.mjs';
import { shallowEqual } from './store.mjs';
import { MEMORY_KINDS, digestHeading, memoryDate, memoryLook, memoryTarget, memoryWhere, openTarget, titleLookup } from './usage-time-model.mjs';

// The Memories tab of Settings > Usage data ("Memories tab" in docs/design/usage-time-page.md; the design's frame 2): a search and the kind chips,
// the switch "Write a weekly digest" with what it sends, the newest digest as a card ("Open the N tasks", "Write it again"), then the timeline, newest
// first: the date, a dot by kind (and the kind in words), the text and where it belongs; a click opens its task or session, a note can be edited and
// deleted (with Undo). More entries load as the end of the list comes into view (`before`). Export and Clear at the end.

// The date in a download's name (the person's day).
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const STATE = state => ({ sources: state.sources, taskList: state.taskList });
const PAGE = 50;
const UNDO_MS = 6000;

export function UsageMemories({ ui, opened, shown }) {
  const state = useStore(ui, STATE, shallowEqual);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [items, setItems] = useState(null);
  const [more, setMore] = useState(false);
  const [digestOn, setDigestOn] = useState(null);
  const [digest, setDigest] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState(null); // { uid, text, busy }
  const [gone, setGone] = useState(() => new Set()); // notes deleted, waiting for Undo
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, say] = useFeedback();
  const seq = useRef(0);
  const end = useRef(null);
  const pending = useRef(new Map()); // uid -> timer of a delete that waits for Undo
  const url = (q, k, before) => `/api/memories?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(k)}${before ? `&before=${encodeURIComponent(before)}` : ''}&limit=${PAGE}`;
  const load = async (q = query, k = kind) => {
    const mine = ++seq.current;
    try {
      const [list, digests] = await Promise.all([api('GET', url(q.trim(), k)), api('GET', url('', 'digest')).catch(() => null)]);
      if (mine !== seq.current) return;
      setItems(Array.isArray(list && list.items) ? list.items : []);
      setMore(Boolean(list && list.has_more));
      setDigestOn(Boolean(list && list.digest_on));
      const newest = digests && Array.isArray(digests.items) ? digests.items.find(item => item.kind === 'digest') : null;
      setDigest(newest || null);
      say('');
    } catch (error) { if (mine === seq.current) say(failure(error), true); }
  };
  const loadMore = async () => {
    if (!more || loadingMore || !items || !items.length) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const list = await api('GET', url(query.trim(), kind, items[items.length - 1].at));
      if (mine !== seq.current) return;
      const known = new Set(items.map(item => item.uid));
      setItems(before => [...before, ...(Array.isArray(list && list.items) ? list.items.filter(item => !known.has(item.uid)) : [])]);
      setMore(Boolean(list && list.has_more));
    } catch (error) { say(failure(error), true); }
    finally { setLoadingMore(false); }
  };
  useEffect(() => { if (opened && shown) void load(); }, [opened, shown]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  // The search waits for a pause in typing.
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) return undefined;
    const timer = setTimeout(() => void load(query, kind), 300);
    return () => clearTimeout(timer);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  // The end of the list in view: the next page.
  useEffect(() => {
    const node = end.current;
    if (!node || !more || typeof IntersectionObserver !== 'function') return undefined;
    const watch = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore(); });
    watch.observe(node);
    return () => watch.disconnect();
  });
  // A delete still waiting for Undo goes now when the page is left.
  useEffect(() => {
    const leave = () => {
      for (const [uid, timer] of pending.current) {
        clearTimeout(timer);
        try { void fetch(`/api/memories/${encodeURIComponent(uid)}`, { method: 'DELETE', keepalive: true, headers: { 'X-Requested-With': 'XMLHttpRequest' } }); } catch { /* lost */ }
      }
      pending.current.clear();
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);
  const pickKind = next => { if (next === kind) return; setKind(next); void load(query, next); };
  const changeDigest = async on => {
    setBusy(true);
    setDigestOn(on);
    try {
      const saved = await api('PUT', '/api/usage-time/settings', { usage_memories_digest: on });
      setDigestOn(Boolean(saved && saved.usage_memories_digest));
    } catch (error) { say(failure(error), true); setDigestOn(!on); }
    finally { setBusy(false); }
  };
  const writeAgain = async () => {
    setWriting(true);
    try { await api('POST', '/api/memories/digest', digest && digest.week ? { week: digest.week } : {}); await load(); say('Digest written again'); }
    catch (error) { say(failure(error), true); }
    finally { setWriting(false); }
  };
  const saveEdit = async () => {
    const text = editing ? editing.text.trim() : '';
    if (!text) return;
    setEditing(current => ({ ...current, busy: true }));
    try {
      const saved = await api('PATCH', `/api/memories/${encodeURIComponent(editing.uid)}`, { text });
      setItems(before => before.map(item => (item.uid === editing.uid ? { ...item, ...(saved && saved.uid ? saved : {}), text: (saved && saved.text) || text } : item)));
      setEditing(null);
    } catch (error) { setEditing(current => (current ? { ...current, busy: false } : current)); say(failure(error), true); }
  };
  const remove = item => {
    setGone(before => new Set([...before, item.uid]));
    const send = async () => {
      pending.current.delete(item.uid);
      try { await api('DELETE', `/api/memories/${encodeURIComponent(item.uid)}`); setItems(before => (before || []).filter(entry => entry.uid !== item.uid)); }
      catch (error) { setGone(before => { const next = new Set(before); next.delete(item.uid); return next; }); say(failure(error), true); }
    };
    pending.current.set(item.uid, setTimeout(() => void send(), UNDO_MS));
    ui.notify('Note deleted', 'info', {
      ms: UNDO_MS,
      action: {
        label: 'Undo',
        run: () => {
          clearTimeout(pending.current.get(item.uid));
          pending.current.delete(item.uid);
          setGone(before => { const next = new Set(before); next.delete(item.uid); return next; });
        },
      },
    });
  };
  const clear = async () => {
    setBusy(true);
    try { await api('DELETE', '/api/usage-time?table=memories'); setConfirming(false); await load(); say('Memories cleared'); }
    catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const lookup = titleLookup(state);
  const heading = digest ? digestHeading(digest, Date.now(), t) : null;
  const tasksCount = digest && digest.sources ? Number(digest.sources.items) || 0 : 0;
  const list = (items || []).filter(item => !gone.has(item.uid) && !(digest && kind === 'all' && item.uid === digest.uid && !query.trim()));
  const openTasks = () => { if (ui.actions.closeSettings) ui.actions.closeSettings(); if (ui.actions.openAttention) ui.actions.openAttention(); };
  const small = { [TOUCH]: { width: 44, height: 44 } };
  return (
    <>
      <Section id="usage-memories">
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
          <TextField
            id="h5-memories-search" size="small" value={query} onChange={event => { typed.current = true; setQuery(event.target.value); }} placeholder={t('Search memories')}
            sx={{ flex: '1 1 14rem', minWidth: 0 }} autoComplete="off"
            slotProps={{ htmlInput: { 'aria-label': t('Search memories'), enterKeyHint: 'search' }, input: { startAdornment: <InputAdornment position="start"><Icon name="search" size={18} /></InputAdornment> } }}
          />
          <Box id="h5-memories-kinds" role="group" aria-label={t('Kind')} sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {MEMORY_KINDS.map(([id, label]) => (
              <Chip
                key={id} id={`h5-memories-kind-${id}`} className="h5-memories-kind" label={t(label)} clickable aria-pressed={kind === id}
                color={kind === id ? 'primary' : 'default'} variant={kind === id ? 'filled' : 'outlined'} onClick={() => pickKind(id)} sx={{ height: 32, [TOUCH]: { minHeight: 44 } }}
              />
            ))}
          </Box>
        </Box>
        {digest ? (
          <Box id="h5-memories-digest" component="section" aria-labelledby="h5-memories-digest-title" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1.75, py: 1.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            <Box sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 1 }}>
              <Typography id="h5-memories-digest-title" variant="overline" component="h4" color="primary.main" sx={{ lineHeight: 1.6, flex: '1 1 auto' }}>{heading.title}</Typography>
              <Typography variant="caption" color="text.secondary" id="h5-memories-digest-when">{heading.written}</Typography>
            </Box>
            <Typography id="h5-memories-digest-text" variant="body2" translate="no" sx={{ lineHeight: 1.6, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{digest.text}</Typography>
            {digest.sources ? (
              <Typography id="h5-memories-digest-sources" variant="caption" color="text.secondary">
                {t(`Written from ${Number(digest.sources.events) || 0} events, ${Number(digest.sources.notes) || 0} notes and ${tasksCount} tasks.`)}
              </Typography>
            ) : null}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mx: -1 }}>
              {tasksCount ? <Button id="h5-memories-digest-open" onClick={openTasks}>{t(tasksCount === 1 ? 'Open the task' : `Open the ${tasksCount} tasks`)}</Button> : null}
              <Button id="h5-memories-digest-again" color="inherit" disabled={writing} onClick={() => void writeAgain()} sx={{ color: 'text.secondary' }}>{t(writing ? 'Writing…' : 'Write it again')}</Button>
            </Box>
          </Box>
        ) : null}
        <Feedback id="h5-memories-feedback" feedback={feedback} />
        {items === null ? <Hint id="h5-memories-loading">{t('Loading…')}</Hint> : null}
        {items !== null && !list.length ? <Hint id="h5-memories-empty">{t(query.trim() ? 'No memories match this search.' : 'Nothing here yet. Use "Remember this" in a session or task menu to keep a note.')}</Hint> : null}
        {list.length ? (
          <Box component="ol" id="h5-memories-list" aria-label={t('Memories')} sx={{ listStyle: 'none', m: 0, mx: -2, p: 0 }}>
            {list.map(item => {
              const look = memoryLook(item);
              const target = memoryTarget(item, state.sources);
              const where = memoryWhere(item, lookup, t);
              const edit = editing && editing.uid === item.uid ? editing : null;
              return (
                <Box component="li" key={item.uid} className="h5-memory" data-uid={item.uid} data-kind={item.kind} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, px: 1, borderTop: 1, borderColor: 'divider' }}>
                  {edit ? (
                    <Box component="form" className="h5-memory-edit" onSubmit={event => { event.preventDefault(); void saveEdit(); }} sx={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 1, py: 1.25, px: 1 }}>
                      <TextField
                        id="h5-memory-edit-text" autoFocus multiline minRows={2} fullWidth size="small" label={t('Note')} value={edit.text}
                        onChange={event => setEditing({ ...edit, text: event.target.value.slice(0, 500) })} helperText={`${edit.text.length} / 500`}
                        slotProps={{ htmlInput: { maxLength: 500 } }}
                      />
                      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
                        <Button id="h5-memory-edit-cancel" onClick={() => setEditing(null)} disabled={edit.busy}>{t('Cancel')}</Button>
                        <Button id="h5-memory-edit-save" type="submit" variant="contained" disabled={edit.busy || !edit.text.trim()}>{t('Save')}</Button>
                      </Box>
                    </Box>
                  ) : (
                    <ButtonBase
                      className="h5-memory-open" disabled={!target} onClick={() => openTarget(ui, target)}
                      sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 1.5, py: 1.25, px: 1, borderRadius: 1, textAlign: 'left', '&:hover': { bgcolor: target ? 'action.hover' : undefined } }}
                    >
                      <Typography variant="caption" color="text.secondary" className="h5-memory-date" sx={{ width: 40, flex: '0 0 40px', pt: 0.25, fontVariantNumeric: 'tabular-nums' }}>{memoryDate(item.at)}</Typography>
                      <Box component="span" aria-hidden="true" className="h5-memory-dot" sx={{ width: 8, height: 8, flex: '0 0 8px', borderRadius: '50%', mt: 0.875, bgcolor: look.color }} />
                      <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <Typography component="span" variant="body2" className="h5-memory-text" translate={item.kind === 'event' ? undefined : 'no'} sx={{ lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-line', ...(item.kind === 'digest' ? { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}) }}>{item.text}</Typography>
                        <Typography component="span" variant="caption" color="text.secondary" className="h5-memory-where" sx={{ overflowWrap: 'anywhere' }}>
                          {where.map((part, index) => (
                            <Fragment key={index}>
                              {index ? (part.join || ' · ') : null}
                              <Box component="span" translate={part.name ? 'no' : undefined}>{part.text}</Box>
                            </Fragment>
                          ))}
                        </Typography>
                      </Box>
                    </ButtonBase>
                  )}
                  {item.kind === 'note' && !edit ? (
                    <Box sx={{ display: 'flex', flex: '0 0 auto', pt: 0.5 }}>
                      <IconButton className="h5-memory-edit-button" size="small" {...named(t('Edit note'))} onClick={() => setEditing({ uid: item.uid, text: String(item.text || ''), busy: false })} sx={small}><Icon name="edit" size={18} /></IconButton>
                      <IconButton className="h5-memory-delete" size="small" {...named(t('Delete note'))} onClick={() => remove(item)} sx={small}><Icon name="delete" size={18} /></IconButton>
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        ) : null}
        {more ? (
          <Box ref={end} sx={{ display: 'flex', justifyContent: 'center' }}>
            <Button id="h5-memories-more" disabled={loadingMore} onClick={() => void loadMore()}>{t(loadingMore ? 'Loading…' : 'Show older')}</Button>
          </Box>
        ) : null}
      </Section>
      <Section id="usage-digest">
        <SwitchRow
          inputId="h5-memories-digest-enabled" label={t('Write a weekly digest')} checked={Boolean(digestOn)} disabled={digestOn === null || busy} onChange={on => void changeDigest(on)}
          secondary={t('The digest is written by your translation service from event lines, your notes and task titles and results. No terminal text or code is sent.')}
          aside={<ScopeLabel id="usage-digest" scope="shared" />}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ flex: '1 1 16rem', minWidth: 0 }}>{t('Memories are kept until you delete them, on your own machines.')}</Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, ml: 'auto' }}>
            <Button id="h5-memories-clear" color="error" disabled={busy} onClick={() => setConfirming(true)}>{t('Clear')}</Button>
            <Button id="h5-memories-export-csv" component="a" href="/api/usage-time/export?table=memories&format=csv" download={`t-agent-memories-${today()}.csv`}>{t('Export CSV')}</Button>
            <Button id="h5-memories-export" component="a" href="/api/usage-time/export?table=memories&format=json" download={`t-agent-memories-${today()}.json`}>{t('Export JSON')}</Button>
          </Box>
        </Box>
      </Section>
      <Dialog id="h5-memories-clear-dialog" open={confirming} onClose={() => setConfirming(false)} fullWidth maxWidth="xs" aria-labelledby="h5-memories-clear-title" aria-describedby="h5-memories-clear-text">
        <DialogTitle id="h5-memories-clear-title">{t('Clear memories?')}</DialogTitle>
        <DialogContent>
          <DialogContentText id="h5-memories-clear-text" variant="body2">{t('Every event, note and digest is deleted, here and on the linked machines that keep the same data. This cannot be undone.')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button id="h5-memories-clear-cancel" onClick={() => setConfirming(false)}>{t('Cancel')}</Button>
          <Button id="h5-memories-clear-confirm" color="error" disabled={busy} onClick={() => void clear()}>{t('Clear')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
