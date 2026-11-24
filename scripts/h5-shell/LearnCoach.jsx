import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import OutlinedInput from '@mui/material/OutlinedInput';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { api, errorText, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { SwitchRow } from './Form.jsx';
import { Fmt, TranslatorNotice, shortDate } from './Learn.jsx';
import { Bubble, CardChips, ChatView, HEADERS, readJson } from './LearnChat.jsx';
import { ndjsonLines } from './learn-model.mjs';
import { cardContext, cardKey, enterSends } from './learn-chat.mjs';
import { createSeries } from './learn-series.mjs';
import {
  COACH_PAGE, COACH_STARTERS, COACH_TEXT_MAX, NOTES_MAX, NOTE_MAX, NO_TOOLS, STATUS_TEXT, STEP_LABELS, UNDO_MS, cardSections, cardsAction, chipList, cleanNote,
  coachLine, mergeCoach, metaOf, noteLine, planCaption, planOf, practiceLine, practiceOf, proposalType, proposalsOf, rememberedLine, rememberedOf,
  reminderLine, settingRows, suggestionsOf, usageOf, usageParts, zoneLabel,
} from './learn-coach.mjs';

// The English coach ("Learn English: the coach, the page" in docs/design/learn-english-coach-page.md): ONE continuous conversation with the coach
// behind the home entry `#h5-learn-mode-chat` (the server: GET /api/learn/coach, POST /coach/send …). Her answers stream in; proposal cards wait for a
// tap (a practice plan with Start, settings, cards, a reminder, a note to remember); a practice series runs in Learn's mode page (Learn.jsx
// `SeriesSession`) and comes back here with its result, which she answers. An engine without the coach (its GET answers 404) keeps the old English
// chat (LearnChat.jsx) unchanged. No chats list and no New chat; the menu has Reset the summary, Earlier chats (read-only) and Coach settings.

const ERROR_STOPPED = 'The answer stopped before it was complete.';
const NO_TRANSLATOR = 'Translation service not configured yet';
const COACH_URL = '/api/learn/coach';

// Whether this engine has the coach: its GET answers (anything but a 404; an older engine's 404 keeps the old chat). Read once per page load.
let support = null;
let probing = null;
export function useCoachSupport() {
  const [known, setKnown] = useState(support);
  useEffect(() => {
    if (support !== null) return undefined;
    let live = true;
    probing = probing || fetch(`${COACH_URL}?limit=1`, { headers: HEADERS }).then(res => { support = res.status !== 404; return support; }, () => { probing = null; return true; });
    probing.then(value => { if (live) setKnown(value); });
    return () => { live = false; };
  }, []);
  return known;
}

// A coach answer stream (POST /coach/send, /coach/practice-result): NDJSON lines read as they come (`onLine` for every line but the last), or one
// plain JSON body (a company computer asking its home). Returns the `done` line ({ messages, tools, usage }).
async function streamCoach(url, body, { signal, onLine }) {
  const res = await fetch(url, { method: 'POST', signal, headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const type = String(res.headers.get('content-type') || '');
  if (!res.ok || !type.includes('ndjson') || !res.body || typeof res.body.getReader !== 'function') {
    const data = await readJson(res);
    return coachLine({ ...data, type: 'done' });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const { items, rest } = ndjsonLines(done ? `${buffer}\n` : buffer);
    buffer = rest;
    for (const item of items) {
      const line = coachLine(item);
      if (!line) continue;
      if (line.kind === 'done') return line;
      if (line.kind === 'error') throw Object.assign(new Error(line.message), { status: line.status });
      onLine(line);
    }
    if (done) throw new Error(t(ERROR_STOPPED));
  }
}

// "31 Mar" for a note's end date (a date-only value is a day of the person's calendar).
const dayLabel = iso => {
  const text = String(iso || '');
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text);
  if (Number.isNaN(date.getTime())) return text;
  const zh = typeof I18n !== 'undefined' && I18n.get() === 'zh';
  return date.toLocaleDateString(zh ? 'zh-CN' : 'en-GB', { day: 'numeric', month: 'short' });
};
const localZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
const weekdayName = n => {
  const zh = typeof I18n !== 'undefined' && I18n.get() === 'zh';
  return new Date(Date.UTC(2026, 10, 22 + n, 12)).toLocaleDateString(zh ? 'zh-CN' : 'en-US', { weekday: 'short', timeZone: 'UTC' });
};
const numberText = n => Number(n).toLocaleString(typeof I18n !== 'undefined' && I18n.get() === 'zh' ? 'zh-CN' : 'en-US');
const Parts = ({ parts }) => parts.map((part, index) => <span key={index}>{index ? ' · ' : ''}<Fmt template={part[0]} values={part.slice(1)} /></span>);
const timeOf = at => (typeof at === 'number' ? at : Date.parse(at || '') || 0);
const PLAN_ICONS = { mistakes_series: 'learnMistakes', dictation: 'learnDictation', fill_gap: 'learnFill' };
const DONE_TEXT = { settings: 'Changed', reminder: 'Reminder set', memory: 'Remembered' };

// The coach view, or the old English chat on an engine without the coach.
export function CoachView(props) {
  const known = useCoachSupport();
  if (known === false) return <ChatView {...props} />;
  if (known === null) {
    return <Box id="h5-learn-coach-probe" sx={{ p: 3 }}><Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography></Box>;
  }
  return <Coach {...props} />;
}

// One practice result is posted once, also when the view is drawn again (`view.seq`).
const posted = new Set();

function Coach({ view, phone, keys, ui, open, back, openTranslator, data, speech }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState({ state: 'loading', error: '' });
  const [older, setOlder] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [tools, setTools] = useState(true);
  const [translator, setTranslator] = useState(true);
  const [pending, setPending] = useState(null); // { question?, practice?, text, status, proposals }
  const [failed, setFailed] = useState(null); // { text, message, practice? }
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(null);
  const [states, setStates] = useState({}); // proposal id -> open | done | cancelled | undone
  const [undos, setUndos] = useState({}); // proposal id -> undo token (while it can be undone)
  const [working, setWorking] = useState({}); // proposal id -> true while its request runs
  const [errors, setErrors] = useState({}); // proposal id -> error text
  const [empty, setEmpty] = useState({}); // plan proposal id -> true: nothing left of it
  const [fresh, setFresh] = useState({}); // note uid -> { note, undo: true } for the Remembered lines of this view
  const [added, setAdded] = useState(() => new Set());
  const [adding, setAdding] = useState(() => new Set());
  const [cardError, setCardError] = useState(null);
  const abort = useRef(null);
  const scroller = useRef(null);
  const input = useRef(null);
  const keep = useRef(null); // { height, top } before older messages are put in front
  const timers = useRef(new Set());
  const later = (fn, ms) => { const id = setTimeout(() => { timers.current.delete(id); fn(); }, ms); timers.current.add(id); };
  useEffect(() => () => { for (const id of timers.current) clearTimeout(id); if (abort.current) abort.current.abort(); }, []);

  const readPage = async before => {
    const data = await api('GET', `${COACH_URL}?limit=${COACH_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (data && data.tools_ok === false) setTools(false);
    return data || {};
  };
  useEffect(() => {
    let live = true;
    setLoaded({ state: 'loading', error: '' });
    readPage('').then(page => {
      if (!live) return;
      setMessages(now => mergeCoach(now, page.messages));
      setHasMore(page.has_more === true);
      setLoaded({ state: 'ok', error: '' });
    }, failure => { if (live) setLoaded({ state: 'error', error: errorText(failure) || t('Operation failed') }); });
    return () => { live = false; };
  }, [reloads]); // eslint-disable-line react-hooks/exhaustive-deps -- read again on Try again
  useEffect(() => { if (keys && input.current) input.current.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on open

  const loadOlder = async () => {
    if (older || !hasMore || !messages.length) return;
    setOlder(true);
    try {
      const page = await readPage(messages[0].at);
      const el = scroller.current;
      if (el) keep.current = { height: el.scrollHeight, top: el.scrollTop };
      setMessages(now => mergeCoach(page.messages, now));
      setHasMore(page.has_more === true);
    } catch (failure) {
      ui.notify(errorText(failure) || t('Operation failed'), 'error');
    } finally {
      setOlder(false);
    }
  };
  // The newest message in view as the conversation grows; older messages put in front keep what was in view where it was.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current) { el.scrollTop = el.scrollHeight - keep.current.height + keep.current.top; keep.current = null; return; }
    el.scrollTop = el.scrollHeight;
  }, [messages, pending, failed, loaded.state]);
  const onScroll = event => { if (event.currentTarget.scrollTop < 80) void loadOlder(); };

  // A stream's `done`: the stored messages in (a question or a result the server did not send back stays as the page's own copy), the proposals and
  // the Remembered notes that came on the way kept on the answer, the usage on it.
  const settle = (done, local, streamed) => {
    const list = [...done.messages];
    const answer = list.find(one => one.role === 'assistant');
    if (answer) {
      const meta = metaOf(answer);
      if (!Array.isArray(meta.proposals) && streamed.proposals.length) meta.proposals = streamed.proposals;
      if (!meta.remembered && streamed.remembered.length) meta.remembered = streamed.remembered;
      if (!meta.usage && done.usage) meta.usage = done.usage;
      answer.meta = meta;
      if (local && !list.some(one => one.role === local.role)) list.push({ ...local, at: new Date(Math.max(0, timeOf(answer.at) - 1)).toISOString() });
    } else if (local && !list.some(one => one.role === local.role)) list.push(local);
    setMessages(now => mergeCoach(now, list));
    if (!done.tools) setTools(false);
  };
  const run = async (url, body, local) => {
    if (abort.current) return;
    const control = new AbortController();
    abort.current = control;
    setFailed(null);
    const streamed = { proposals: [], remembered: [] };
    setPending({ ...(local.role === 'user' ? { question: local.text } : { practice: practiceOf(local) }), text: '', status: '', proposals: [] });
    try {
      const done = await streamCoach(url, body, {
        signal: control.signal,
        onLine: line => {
          if (line.kind === 'delta') setPending(now => (now ? { ...now, text: now.text + line.text, status: '' } : now));
          else if (line.kind === 'status') setPending(now => (now ? { ...now, status: line.text || STATUS_TEXT } : now));
          else if (line.kind === 'proposals') { streamed.proposals = line.proposals; setPending(now => (now ? { ...now, proposals: line.proposals } : now)); }
          else if (line.kind === 'remembered') {
            streamed.remembered.push(line.note);
            if (line.note.uid) {
              setFresh(now => ({ ...now, [line.note.uid]: { note: line.note, undo: true } }));
              later(() => setFresh(now => (now[line.note.uid] ? { ...now, [line.note.uid]: { ...now[line.note.uid], undo: false } } : now)), UNDO_MS);
            }
          }
        },
      });
      settle(done, local, streamed);
      setTranslator(true);
    } catch (failure) {
      if (control.signal.aborted) return;
      if (failure && failure.status === 503 && failure.message === NO_TRANSLATOR) setTranslator(false);
      // A result that was not taken stays as a line, so it is not lost from view; her answer can be asked for again.
      setFailed({ local, url, body, message: errorText(failure) || t('Operation failed') });
    } finally {
      if (abort.current === control) abort.current = null;
      if (!control.signal.aborted) setPending(null);
    }
  };
  const send = text => {
    const question = String(text || '').trim().slice(0, COACH_TEXT_MAX);
    if (!question || abort.current) return;
    setDraft('');
    void run(`${COACH_URL}/send`, { text: question }, { uid: `local-q-${Date.now()}`, role: 'user', text: question, at: new Date().toISOString() });
  };

  // A practice series that came back (Learn.jsx `SeriesSession`): its result is posted once and she answers it.
  useEffect(() => {
    const result = view.result;
    if (!result || posted.has(view.seq)) return;
    posted.add(view.seq);
    const local = { uid: `local-p-${view.seq}`, role: 'practice', text: '', at: new Date().toISOString(), meta: { practice: { ...result, kind: view.planKind || '' } } };
    void run(`${COACH_URL}/practice-result`, result, local);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the view opens with a result

  const busy = Boolean(pending);
  const blocked = busy || !translator;

  // ── the proposal cards ──
  const mark = (id, patch) => setWorking(now => ({ ...now, [id]: patch }));
  const settingsChanged = () => {
    api('GET', '/api/learn/settings').then(next => { if (next && data && data.setSettings) data.setSettings(next); }, () => {});
    if (data && data.reload) void data.reload();
  };
  const act = async (message, proposal, action) => {
    const id = proposal.id;
    mark(id, true);
    setErrors(now => ({ ...now, [id]: '' }));
    try {
      const result = await api('POST', `${COACH_URL}/proposals/${encodeURIComponent(id)}/${action}`, { message_uid: message.uid });
      const state = (result && result.proposal && result.proposal.state) || (action === 'run' ? 'done' : 'cancelled');
      setStates(now => ({ ...now, [id]: state }));
      if (action === 'run') {
        const undo = result && result.undo;
        if (undo && undo.token) {
          setUndos(now => ({ ...now, [id]: undo.token }));
          const left = undo.expires_at ? Math.min(UNDO_MS, timeOf(undo.expires_at) - Date.now()) : UNDO_MS;
          later(() => setUndos(now => { const next = { ...now }; delete next[id]; return next; }), Math.max(0, left));
        }
        const type = proposalType(proposal);
        if (type === 'settings' || type === 'cards') settingsChanged();
      }
    } catch (failure) {
      setErrors(now => ({ ...now, [id]: errorText(failure) || t('Operation failed') }));
    } finally {
      mark(id, false);
    }
  };
  const undo = async proposal => {
    const id = proposal.id;
    const token = undos[id];
    if (!token) return;
    mark(id, true);
    try {
      await api('POST', `${COACH_URL}/undo`, { token });
      setStates(now => ({ ...now, [id]: 'undone' }));
      setUndos(now => { const next = { ...now }; delete next[id]; return next; });
      settingsChanged();
    } catch (failure) {
      setErrors(now => ({ ...now, [id]: errorText(failure) || t('Operation failed') }));
    } finally {
      mark(id, false);
    }
  };
  const start = async (message, proposal) => {
    const id = proposal.id;
    mark(id, true);
    setErrors(now => ({ ...now, [id]: '' }));
    try {
      const result = await api('POST', `${COACH_URL}/plans/start`, { message_uid: message.uid, proposal_id: id });
      const plan = result && result.plan;
      // An old button reads the queue again: nothing left of it (or nothing this browser can run) says so on the card.
      if (!plan || result.empty || !createSeries(plan, { tts: Boolean(speech && speech.tts) }).steps.some(step => step.items.length)) {
        setEmpty(now => ({ ...now, [id]: true }));
        return;
      }
      open({ kind: 'series', plan, messageUid: message.uid, planKind: planOf(proposal).kind });
    } catch (failure) {
      setErrors(now => ({ ...now, [id]: errorText(failure) || t('Operation failed') }));
    } finally {
      mark(id, false);
    }
  };
  const forget = async note => {
    setFresh(now => ({ ...now, [note.uid]: { note, undo: false, busy: true } }));
    try {
      if (note.undo && note.undo.token) await api('POST', `${COACH_URL}/undo`, { token: note.undo.token });
      else await api('DELETE', `${COACH_URL}/notes/${encodeURIComponent(note.uid)}`);
      setFresh(now => ({ ...now, [note.uid]: { note, undo: false, forgotten: true } }));
    } catch (failure) {
      setFresh(now => ({ ...now, [note.uid]: { note, undo: true } }));
      ui.notify(errorText(failure) || t('Operation failed'), 'error');
    }
  };
  const addCard = async (message, card) => {
    const key = cardKey(card);
    setCardError(null);
    setAdding(now => new Set(now).add(key));
    try {
      await api('POST', '/api/learn/cards', { kind: card.kind === 'sentence' ? 'sentence' : 'word', en: card.en, zh: card.zh || '', context: cardContext(card, message.text), source: 'manual' });
      setAdded(now => new Set(now).add(key));
    } catch (failure) {
      setCardError({ uid: message.uid, message: errorText(failure) || t('Operation failed') });
    } finally {
      setAdding(now => { const next = new Set(now); next.delete(key); return next; });
    }
  };

  const resetSummary = async () => {
    setMenu(null);
    try {
      await api('POST', `${COACH_URL}/summary/reset`, {});
      ui.notify(t('The summary is reset. She writes it again from your messages.'), 'success');
    } catch (failure) {
      ui.notify(errorText(failure) || t('Operation failed'), 'error');
    }
  };
  const earlier = () => { setMenu(null); open(phone ? { kind: 'chats', readOnly: true, parent: { kind: 'chat' } } : { kind: 'oldchat', parent: { kind: 'chat' } }); };
  const coachSettings = () => { setMenu(null); open({ kind: 'settings', focus: 'coach', parent: { kind: 'chat' } }); };

  const lastAnswer = [...messages].reverse().find(one => one.role !== 'practice');
  const cardProps = message => ({
    message, settings: (data && data.settings) || {}, busy: blocked, states, undos, working, errors, empty,
    onRun: proposal => act(message, proposal, 'run'), onCancel: proposal => act(message, proposal, 'cancel'), onUndo: undo, onStart: proposal => start(message, proposal),
  });
  const rememberedLines = (message, notes) => notes.map((note, index) => {
    const state = (note.uid && fresh[note.uid]) || { note, undo: false };
    return <RememberedLine key={note.uid || index} note={note} state={state} onUndo={() => forget(note)} />;
  });

  const conversation = (
    <>
      <Box ref={scroller} onScroll={onScroll} className="h5-learn-chat-scroll" id="h5-learn-coach-scroll"
        sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', px: phone ? 2 : 3, py: 2 }}>
        <Box sx={{ maxWidth: phone ? 'none' : 760, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {older ? <Typography id="h5-learn-coach-older" variant="caption" color="text.secondary" align="center" component="p">{t('Loading earlier messages…')}</Typography> : null}
          {!translator ? <TranslatorNotice id="h5-learn-coach-no-translator" onOpen={openTranslator} text="English chat needs a translator. Set one up in Settings → Voice and translation." /> : null}
          {loaded.state === 'error' ? (
            <Alert severity="error" id="h5-learn-coach-load-error" action={<Button color="inherit" size="small" onClick={() => setReloads(n => n + 1)}>{t('Try again')}</Button>}>{loaded.error}</Alert>
          ) : null}
          {loaded.state === 'loading' ? <Typography variant="body2" color="text.secondary" id="h5-learn-coach-loading">{t('Loading…')}</Typography> : null}
          {loaded.state === 'ok' && !messages.length && !pending && !failed ? (
            <Box id="h5-learn-coach-start" sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: phone ? 4 : 6 }}>
              <Box aria-hidden="true" sx={{ color: 'primary.main', display: 'flex', justifyContent: 'center' }}><Icon name="learnAsk" size={32} /></Box>
              <Typography variant="h6" component="h3" align="center">{t('Your English coach')}</Typography>
              <Typography variant="body2" color="text.secondary" align="center" component="p">
                {t('Ask for a practice, ask how you are doing, or ask anything about English. Nothing changes until you tap.')}
              </Typography>
              <Box id="h5-learn-coach-starters" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2, justifyContent: 'center' }}>
                {COACH_STARTERS.map(text => <Chip key={text} className="h5-learn-coach-starter" variant="outlined" label={t(text)} disabled={blocked} onClick={() => send(t(text))} />)}
              </Box>
            </Box>
          ) : null}
          <Box id="h5-learn-coach-log" role="log" aria-live="polite" aria-label={t('Conversation')} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {messages.map(item => {
              if (item.role === 'practice') return <PracticeDivider key={item.uid} result={{ ...practiceOf(item) }} />;
              if (item.role === 'user') return <Bubble key={item.uid} role="user" text={item.text} />;
              const meta = metaOf(item);
              const suggestions = !busy && item === lastAnswer ? suggestionsOf(item) : [];
              return (
                <Box key={item.uid} className="h5-learn-coach-answer" data-uid={item.uid} sx={{ display: 'contents' }}>
                  {item.text ? <Bubble role="assistant" text={item.text} /> : null}
                  <UsageLine usage={usageOf(item)} />
                  <CardChips message={{ ...item, cards: meta.cards }} added={added} adding={adding} error={cardError && cardError.uid === item.uid ? cardError.message : ''} onAdd={addCard} />
                  {proposalsOf(item, states).map(proposal => <ProposalCard key={proposal.id} proposal={proposal} {...cardProps(item)} />)}
                  {rememberedLines(item, rememberedOf(item))}
                  {suggestions.length ? <Suggestions list={suggestions} disabled={blocked} onPick={send} /> : null}
                </Box>
              );
            })}
            {pending && pending.question ? <Bubble role="user" text={pending.question} /> : null}
            {pending && pending.practice ? <PracticeDivider result={pending.practice} /> : null}
            {pending && pending.status && !pending.text ? (
              <Typography id="h5-learn-coach-status" role="status" variant="body2" color="text.secondary" sx={{ alignSelf: 'flex-start', fontStyle: 'italic' }}>{t(STATUS_TEXT)}</Typography>
            ) : null}
            {pending && (pending.text || !pending.status) ? <Bubble role="assistant" text={pending.text} streaming /> : null}
            {pending ? pending.proposals.filter(one => proposalType(one)).map(proposal => <ProposalCard key={proposal.id} proposal={{ ...proposal, state: 'open' }} {...cardProps({ uid: '' })} busy />) : null}
            {failed && failed.local.role === 'user' ? <Bubble role="user" text={failed.local.text} /> : null}
            {failed && failed.local.role === 'practice' ? <PracticeDivider result={practiceOf(failed.local)} /> : null}
          </Box>
          {failed ? (
            <Alert severity="error" id="h5-learn-coach-error" role="alert" action={<Button color="inherit" size="small" id="h5-learn-coach-retry" disabled={busy} onClick={() => run(failed.url, failed.body, failed.local)}>{t('Try again')}</Button>}>
              {failed.message}
            </Alert>
          ) : null}
        </Box>
      </Box>
      {!tools ? (
        <Typography id="h5-learn-coach-no-tools" variant="caption" component="p" color="text.secondary" sx={{ flex: '0 0 auto', px: phone ? 2 : 3, pt: 1 }}>{t(NO_TOOLS)}</Typography>
      ) : null}
      <Box component="form" onSubmit={event => { event.preventDefault(); send(draft); }}
        sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', gap: 1, px: phone ? 2 : 3, pt: 1, pb: phone ? 'calc(12px + env(safe-area-inset-bottom))' : 1.5, borderTop: 1, borderColor: 'divider' }}>
        <OutlinedInput inputRef={input} fullWidth size="small" multiline maxRows={6} value={draft} placeholder={t('Reply or write more')}
          onChange={event => setDraft(event.target.value.slice(0, COACH_TEXT_MAX))}
          onKeyDown={event => { if (enterSends(event, { keys })) { event.preventDefault(); send(draft); } }}
          inputProps={{ id: 'h5-learn-coach-input', 'aria-label': t('Reply or write more'), maxLength: COACH_TEXT_MAX, enterKeyHint: keys ? 'send' : 'enter' }}
          sx={{ typography: 'body2', borderRadius: '22px' }} />
        <IconButton id="h5-learn-coach-send" type="submit" color="primary" onMouseDown={event => event.preventDefault()} disabled={blocked || !draft.trim()} {...named(t('Send'))}>
          <Icon name="send" size={22} />
        </IconButton>
      </Box>
    </>
  );
  const moreButton = (
    <IconButton id="h5-learn-coach-more" aria-haspopup="menu" aria-expanded={menu ? 'true' : 'false'} aria-controls={menu ? 'h5-learn-coach-menu' : undefined}
      onClick={event => setMenu(event.currentTarget)} {...named(t('More'))}><Icon name="taskMore" size={22} /></IconButton>
  );
  const menuNode = (
    <Menu id="h5-learn-coach-menu" anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
      <MenuItem id="h5-learn-coach-reset" onClick={resetSummary}>{t('Reset the summary')}</MenuItem>
      <MenuItem id="h5-learn-coach-earlier" onClick={earlier}>{t('Earlier chats')}</MenuItem>
      <MenuItem id="h5-learn-coach-settings-open" onClick={coachSettings}>{t('Coach settings')}</MenuItem>
    </Menu>
  );
  if (phone) {
    return (
      <>
        <AppBar position="static" color="default" enableColorOnDark elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
          <Toolbar disableGutters sx={{ minHeight: 56, px: 0.5, gap: 0.5 }}>
            <IconButton id="h5-learn-back" onClick={back} {...named(t('Back'))}><Icon name="back" size={22} /></IconButton>
            <Typography id="h5-learn-view-title" variant="subtitle1" component="h2" noWrap sx={{ flex: '1 1 auto', minWidth: 0, fontWeight: 500 }}>{t('English chat')}</Typography>
            {moreButton}
          </Toolbar>
        </AppBar>
        <Box id="h5-learn-coach" data-layout="phone" sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>{conversation}</Box>
        {menuNode}
      </>
    );
  }
  return (
    <Box id="h5-learn-coach" data-layout="wide" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 3, pr: 2, pt: 3, pb: 1, minHeight: 40 }}>
        <Typography id="h5-learn-view-title" variant="h6" component="h2" noWrap sx={{ flex: '1 1 auto', minWidth: 0 }}>{t('English chat')}</Typography>
        {moreButton}
        <IconButton id="h5-learn-back" size="small" onClick={back} {...named(t('Close'))}><Icon name="close" size={20} /></IconButton>
      </Box>
      {conversation}
      {menuNode}
    </Box>
  );
}

// "Spelling finished · 25 words · 8 min" / "Stopped after 9 of 25": a centred caption between the messages.
function PracticeDivider({ result }) {
  const [template, ...values] = practiceLine(result);
  return (
    <Typography className="h5-learn-coach-divider" data-stopped={result && result.stopped ? 'true' : undefined} variant="caption" component="p" color="text.secondary" align="center" sx={{ alignSelf: 'center', py: 0.5 }}>
      <Fmt template={template} values={values} />
    </Typography>
  );
}

// The caption of an answer that looked things up or whose tokens were counted: "Looked at your data 3 times · 3 calls · 18,400 tokens".
function UsageLine({ usage }) {
  const parts = usageParts(usage, numberText);
  if (!parts.length) return null;
  return <Typography className="h5-learn-coach-usage" variant="caption" component="p" color="text.secondary" sx={{ alignSelf: 'flex-start', mt: -1, px: 0.5 }}><Parts parts={parts} /></Typography>;
}

// "WHAT NEXT?" under her newest answer: each button sends its text as the person's reply.
function Suggestions({ list, disabled, onPick }) {
  return (
    <Card className="h5-learn-coach-suggestions" sx={{ alignSelf: 'flex-start', width: '88%', boxSizing: 'border-box', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="overline" component="p" color="text.secondary" sx={{ lineHeight: 1.6 }}>{t('What next?')}</Typography>
      {list.map((text, index) => (
        <Button key={text} className="h5-learn-coach-suggestion" variant="outlined" color={index ? 'inherit' : 'primary'} disabled={disabled} onClick={() => onPick(text)}
          translate="no" sx={{ minHeight: 44, justifyContent: 'center', ...(index ? { borderColor: 'divider' } : {}) }}>{text}</Button>
      ))}
    </Card>
  );
}

// "Remembered: job interview in March (until 31 Mar) · Undo" (Undo for 10 s after she saved it in this view).
function RememberedLine({ note, state, onUndo }) {
  if (state.forgotten) {
    return <Typography className="h5-learn-coach-remembered" data-state="forgotten" variant="caption" color="text.secondary" sx={{ alignSelf: 'flex-start' }}>{t('Removed from memory')}</Typography>;
  }
  const [template, ...values] = rememberedLine(note, dayLabel);
  return (
    <Box className="h5-learn-coach-remembered" data-state={state.undo ? 'undo' : 'kept'} sx={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 1, minHeight: 32 }}>
      <Typography variant="caption" color="text.secondary"><Fmt template={template} values={values} /></Typography>
      {state.undo ? <Button size="small" className="h5-learn-coach-remembered-undo" disabled={Boolean(state.busy)} onClick={onUndo} sx={{ minHeight: 32 }}>{t('Undo')}</Button> : null}
    </Box>
  );
}

const CARD_SX = { alignSelf: 'flex-start', width: '88%', maxWidth: 520, boxSizing: 'border-box', px: 1.75, py: 1.5, display: 'flex', flexDirection: 'column', gap: 1 };

// A proposal card: the plan with Start, or a change (settings, cards, reminder, memory) with Cancel and its action, then its state.
function ProposalCard({ proposal, settings, busy, states, undos, working, errors, empty, onRun, onCancel, onUndo, onStart }) {
  const type = proposalType(proposal);
  const id = proposal.id;
  const state = states[id] || proposal.state || 'open';
  const running = Boolean(working[id]);
  const error = errors[id] ? <Alert severity="error" role="alert" className="h5-learn-coach-card-error" sx={{ py: 0 }}>{errors[id]}</Alert> : null;
  if (type === 'plan') {
    const plan = planOf(proposal);
    return (
      <Card className="h5-learn-coach-card" data-type="plan" data-id={id} sx={CARD_SX}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <Box aria-hidden="true" sx={theme => ({ flex: '0 0 36px', height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.16) })}>
            <Icon name={PLAN_ICONS[plan.kind] || 'learnSpell'} size={20} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2" component="p" className="h5-learn-coach-plan-title" translate="no">{plan.title || t('Practice')}</Typography>
            <Typography variant="caption" component="p" color="text.secondary" className="h5-learn-coach-plan-caption"><Parts parts={planCaption(plan)} /></Typography>
          </Box>
        </Box>
        {plan.steps.length > 1 ? (
          <Box component="ol" className="h5-learn-coach-plan-steps" sx={{ m: 0, pl: 2.5, typography: 'body2', color: 'text.secondary' }}>
            {plan.steps.map((step, index) => <li key={index} data-mode={step.mode}>{t(STEP_LABELS[step.mode] || 'Practice')}</li>)}
          </Box>
        ) : null}
        {plan.notes ? <Typography variant="body2" color="text.secondary" translate="no" className="h5-learn-coach-plan-notes">{plan.notes}</Typography> : null}
        {empty[id] ? <Typography variant="body2" color="text.secondary" className="h5-learn-coach-plan-empty">{t('Nothing left of this practice')}</Typography> : null}
        {error}
        <Button variant="contained" className="h5-learn-coach-start" disabled={busy || running} onClick={() => onStart(proposal)} sx={{ minHeight: 44 }}>{t('Start')}</Button>
      </Card>
    );
  }
  let overline = null;
  let body = null;
  let action = 'Change';
  let doneText = DONE_TEXT[type] || 'Changed';
  let destructive = false;
  if (type === 'settings') {
    const rows = settingRows(proposal, settings);
    overline = [rows.length === 1 ? 'Setting' : 'Settings'];
    body = rows.map(row => (
      <Typography key={row.key} variant="body2" className="h5-learn-coach-setting" data-key={row.key}>
        {row.label ? t(row.label) : <span translate="no">{row.name}</span>}{': '}
        <Box component="strong" sx={{ fontWeight: 'fontWeightMedium' }}>
          {row.from ? <>{row.from.key ? t(row.from.key) : row.from.text}{' → '}</> : null}{row.to ? (row.to.key ? t(row.to.key) : row.to.text) : ''}
        </Box>
      </Typography>
    ));
  } else if (type === 'cards') {
    const sections = cardSections(proposal);
    action = cardsAction(sections);
    destructive = sections.length === 1 && sections[0].part === 'remove';
    doneText = sections.length === 1 ? { add: 'Added', update: 'Changed', remove: 'Removed' }[sections[0].part] : 'Changed';
    body = sections.map(section => (
      <Box key={section.part} className="h5-learn-coach-cards" data-part={section.part} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Typography variant="overline" component="p" color="text.secondary" sx={{ lineHeight: 1.6 }}><Fmt template={section.title[0]} values={section.title.slice(1)} /></Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {chipList(section.items).map(text => <Chip key={text} size="small" variant="outlined" label={text} translate="no" lang="en" className="h5-learn-coach-chip" />)}
        </Box>
      </Box>
    ));
  } else if (type === 'reminder') {
    overline = ['Reminder in T-Attention'];
    action = 'Set it';
    const [template, ...values] = reminderLine(proposal, { zone: zoneLabel(proposal.time_zone || proposal.tz || localZone()), dayName: weekdayName });
    body = (
      <Typography variant="body2" className="h5-learn-coach-reminder">
        <Fmt template={template} values={values} />{' '}{t('Tapping it opens this chat.')}
      </Typography>
    );
  } else {
    overline = ['Note to remember'];
    action = 'Remember this';
    body = <Typography variant="body2" translate="no" className="h5-learn-coach-memory">{String(proposal.text || '')}</Typography>;
  }
  return (
    <Card className="h5-learn-coach-card" data-type={type} data-id={id} data-state={state} sx={CARD_SX}>
      {overline ? <Typography variant="overline" component="p" color="text.secondary" sx={{ lineHeight: 1.6 }}><Fmt template={overline[0]} values={overline.slice(1)} /></Typography> : null}
      {body}
      {error}
      {state === 'open' ? (
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button className="h5-learn-coach-cancel" color="inherit" disabled={busy || running} onClick={() => onCancel(proposal)} sx={{ minHeight: 40, color: 'text.secondary' }}>{t('Cancel')}</Button>
          <Button className="h5-learn-coach-run" variant="contained" color={destructive ? 'error' : 'primary'} disabled={busy || running} onClick={() => onRun(proposal)} sx={{ minHeight: 40 }}>{t(action)}</Button>
        </Box>
      ) : (
        <Box className="h5-learn-coach-state" sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 40 }}>
          <Typography variant="body2" color="text.secondary">{t(state === 'cancelled' ? 'Cancelled' : state === 'undone' ? 'Undone' : doneText)}</Typography>
          {state === 'done' && undos[id] ? <Button size="small" className="h5-learn-coach-undo" disabled={running} onClick={() => onUndo(proposal)}>{t('Undo')}</Button> : null}
        </Box>
      )}
    </Card>
  );
}

// ── Learn settings: the group "Coach" ──

// The notes the coach keeps (GET /api/learn/coach/notes): edited in place (PATCH), deleted with Undo (the DELETE is sent when the 10 s of Undo are
// over, or when the settings close).
function useNotes() {
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api('GET', `${COACH_URL}/notes`).then(result => { if (live) setNotes(Array.isArray(result && result.notes) ? result.notes : []); }, failure => { if (live) { setNotes([]); setError(errorText(failure) || t('Operation failed')); } });
    return () => { live = false; };
  }, []);
  return { notes, setNotes, error };
}

function NoteRow({ note, onSave, onDelete }) {
  const [editing, setEditing] = useState(null);
  const field = useRef(null);
  useEffect(() => { if (editing !== null && field.current) field.current.focus(); }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps -- when editing starts
  const commit = async () => {
    const text = cleanNote(editing);
    if (!text || text === note.text) { setEditing(null); return; }
    if (await onSave(note, text)) setEditing(null);
  };
  const [line, ...values] = noteLine(note, { short: shortDate, day: dayLabel });
  return (
    <Box className="h5-learn-coach-note" data-uid={note.uid} sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 56, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
      <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
        {editing !== null ? (
          <InputBase inputRef={field} fullWidth value={editing} onChange={event => setEditing(event.target.value.slice(0, NOTE_MAX))} onBlur={commit}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commit(); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); } }}
            inputProps={{ className: 'h5-learn-coach-note-input', 'aria-label': t('Edit the note'), maxLength: NOTE_MAX }} sx={{ typography: 'body1' }} />
        ) : (
          <Box component="button" type="button" className="h5-learn-coach-note-text" onClick={() => setEditing(note.text)}
            sx={{ display: 'block', width: '100%', textAlign: 'left', p: 0, m: 0, border: 0, bgcolor: 'transparent', color: 'text.primary', typography: 'body1', cursor: 'text', minHeight: 24 }}>
            <span translate="no">{note.text}</span>
          </Box>
        )}
        <Typography variant="caption" color="text.secondary" component="p"><Fmt template={line} values={values} /></Typography>
      </Box>
      <IconButton className="h5-learn-coach-note-delete" onClick={() => onDelete(note)} {...named(t('Delete note'))}><Icon name="close" size={20} /></IconButton>
    </Box>
  );
}

export function CoachSettings({ current, busy, save, ui, focus = false }) {
  const { notes, setNotes, error } = useNotes();
  const [deleted, setDeleted] = useState([]); // notes waiting for their DELETE (Undo puts them back)
  const pendingDeletes = useRef(new Map()); // uid -> timer
  const root = useRef(null);
  useEffect(() => { if (focus && root.current) root.current.scrollIntoView({ block: 'start' }); }, [focus]);
  const sendDelete = uid => api('DELETE', `${COACH_URL}/notes/${encodeURIComponent(uid)}`).catch(failure => ui.notify(errorText(failure) || t('Operation failed'), 'error'));
  useEffect(() => () => { for (const [uid, timer] of pendingDeletes.current) { clearTimeout(timer); void sendDelete(uid); } }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on close
  const remove = note => {
    setNotes(now => (now || []).filter(one => one.uid !== note.uid));
    setDeleted(now => [...now, note]);
    pendingDeletes.current.set(note.uid, setTimeout(() => {
      pendingDeletes.current.delete(note.uid);
      setDeleted(now => now.filter(one => one.uid !== note.uid));
      void sendDelete(note.uid);
    }, UNDO_MS));
  };
  const restore = note => {
    clearTimeout(pendingDeletes.current.get(note.uid));
    pendingDeletes.current.delete(note.uid);
    setDeleted(now => now.filter(one => one.uid !== note.uid));
    setNotes(now => [...(now || []), note].sort((a, b) => timeOf(a.created_at) - timeOf(b.created_at)));
  };
  const edit = async (note, text) => {
    try {
      const result = await api('PATCH', `${COACH_URL}/notes/${encodeURIComponent(note.uid)}`, { text });
      const next = (result && result.note) || { ...note, text };
      setNotes(now => (now || []).map(one => (one.uid === note.uid ? { ...one, ...next } : one)));
      return true;
    } catch (failure) {
      ui.notify(errorText(failure) || t('Operation failed'), 'error');
      return false;
    }
  };
  const resetSummary = async () => {
    try {
      await api('POST', `${COACH_URL}/summary/reset`, {});
      ui.notify(t('The summary is reset. She writes it again from your messages.'), 'success');
    } catch (failure) {
      ui.notify(errorText(failure) || t('Operation failed'), 'error');
    }
  };
  const live = notes || [];
  return (
    <>
      <Typography ref={root} id="h5-learn-coach-settings-title" variant="overline" component="h3" color="text.secondary" sx={{ mt: 1, mb: -1, scrollMarginTop: 16 }}>{t('Coach')}</Typography>
      <Card id="h5-learn-coach-settings" sx={{ px: 2, py: 1 }}>
        <SwitchRow inputId="h5-learn-coach-memory" label={t('Remember things about me')} disabled={busy} checked={current.coach_memory !== false} onChange={on => save({ coach_memory: on })}
          secondary={t('Used in every answer; synced to your devices')} />
        <Box id="h5-learn-coach-notes" sx={{ mx: -2, px: 2 }}>
          {notes === null ? <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>{t('Loading…')}</Typography> : null}
          {error ? <Typography variant="body2" color="text.secondary" id="h5-learn-coach-notes-error" sx={{ py: 1 }}>{error}</Typography> : null}
          {live.map(note => <NoteRow key={note.uid} note={note} onSave={edit} onDelete={remove} />)}
          {deleted.map(note => (
            <Box key={note.uid} className="h5-learn-coach-note-deleted" data-uid={note.uid} sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 48, borderTop: 1, borderColor: 'divider' }}>
              <Typography variant="body2" color="text.secondary" sx={{ flex: '1 1 auto' }}>{t('Note deleted')}</Typography>
              <Button className="h5-learn-coach-note-undo" onClick={() => restore(note)}>{t('Undo')}</Button>
            </Box>
          ))}
        </Box>
        <Typography id="h5-learn-coach-notes-count" variant="caption" component="p" color="text.secondary" sx={{ py: 1 }}>
          <Fmt template="{1} of {2} notes. Tap a line to edit it, × deletes it (with Undo). Secrets such as passwords are never kept." values={[live.length, NOTES_MAX]} />
        </Typography>
        <Divider sx={{ mx: -2 }} />
        <SwitchRow inputId="h5-learn-coach-read-answers" label={t('Let the coach read my learning answers')} disabled={busy} checked={current.coach_read_answers !== false}
          onChange={on => save({ coach_read_answers: on })} secondary={t('Your cards, answers, days and mistakes, read only')} />
        <Divider sx={{ mx: -2 }} />
        <SwitchRow inputId="h5-learn-coach-read-text" label={t('Let the coach read my journal and chats')} disabled={busy} checked={current.coach_read_text !== false}
          onChange={on => save({ coach_read_text: on })} secondary={t('Your journal entries and your messages to her and in earlier chats')} />
        <Divider sx={{ mx: -2 }} />
        <SwitchRow inputId="h5-learn-coach-economy" label={t('Save tokens')} disabled={busy} checked={current.coach_economy === true}
          onChange={on => save({ coach_economy: on })} secondary={t('A shorter memory of the conversation and at most 3 lookups per answer')} />
        <Divider sx={{ mx: -2 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 56, py: 1 }}>
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Typography variant="body1">{t('Reset the summary')}</Typography>
            <Typography variant="body2" color="text.secondary">{t('She starts her summary of the older conversation again. No message is deleted.')}</Typography>
          </Box>
          <Button id="h5-learn-coach-reset-summary" sx={{ flexShrink: 0 }} onClick={resetSummary}>{t('Reset')}</Button>
        </Box>
      </Card>
      <Typography variant="caption" component="p" color="text.secondary" id="h5-learn-coach-privacy" sx={{ mt: -1 }}>{t('What she reads is sent to your translation service to write the answer.')}</Typography>
    </>
  );
}
