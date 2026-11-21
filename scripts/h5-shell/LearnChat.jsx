import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import OutlinedInput from '@mui/material/OutlinedInput';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { api, errorText, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { overlay } from './Columns.jsx';
import TextField from './TextField.jsx';
import { Fmt, TranslatorNotice } from './Learn.jsx';
import { ndjsonLines, textLang } from './learn-model.mjs';
import {
  CHAT_CHIPS, CHAT_FULL, CHAT_MESSAGES_MAX, CHAT_QUESTION_MAX, CHAT_TITLE_MAX, answerParts, cardContext, cardKey, chatLine, chatTopic, chipFill, enterSends,
  mergeChat, putChat, visibleAnswer,
} from './learn-chat.mjs';

// "English chat" ("English chat" in docs/design/learn-english-page.md): the person's own conversations with the translation model about English
// (words, grammar, how to say something, their journal entries and their learning habits), not tied to a card. The server keeps the chats and syncs
// them (/api/learn/chats, docs/design/learn-english.md); a company computer asks its home, like Ask.
// - Phone: a full-screen view of Learn (`{ kind: 'chat', uid? }`): an app bar ("English chat", the chat's title with its Journal tag; Earlier chats,
//   New chat and the chat's menu), the conversation and the input. "Earlier chats" is a view of its own (`{ kind: 'chats', parent }`).
// - Computer: in the right pane of Learn, the 260px chats list ("Chats", New chat) and the conversation.
// The same content in both. A new chat shows the starter chips and the privacy line; an answer streams (NDJSON: the first `chat` line names a new
// chat, `delta` pieces, then `done` with the stored messages and the chat with its title); under an answer its "Add to my cards" chips. Corrections of
// a journal entry are drawn from `[-wrong-]{+right+}`; a trailing `<<meta>>` line never shows (learn-chat.mjs `visibleAnswer`).

const ERROR_STOPPED = 'The answer stopped before it was complete.';
// The 503 of an engine without a translator (any other 503, such as a company computer whose home cannot be reached, shows the server's message).
const NO_TRANSLATOR = 'Translation service not configured yet';
// A company computer whose home cannot answer (GET /chats says `offline` or `home_older`): the same lines as Ask.
const AWAY = { offline: 'Questions are answered by your normal computer, which cannot be reached right now.', older: 'Your normal computer needs an update to answer questions.' };
const HEADERS = { 'X-Requested-With': 'XMLHttpRequest' };
// Unmarking a journal entry can make it one non-journal chat too many: the server prunes it at once and answers it as deleted.
const PRUNED = 'This chat was removed: only the newest 50 chats are kept.';
const chatUrl = uid => `/api/learn/chats/${encodeURIComponent(uid)}`;

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || text || `HTTP ${res.status}`), { data, status: res.status });
  return data || {};
}
const getJson = (url, signal) => fetch(url, { signal, headers: HEADERS }).then(readJson);

// POST /chats/send: an NDJSON stream read as it comes (`onChat` with the first `chat` line, `onDelta` per piece) or a plain JSON body (a company
// computer). Returns { chat, messages }.
async function postChat(body, { signal, onChat, onDelta }) {
  const res = await fetch('/api/learn/chats/send', { method: 'POST', signal, headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const type = String(res.headers.get('content-type') || '');
  if (!res.ok || !type.includes('ndjson') || !res.body || typeof res.body.getReader !== 'function') {
    const data = await readJson(res);
    return { chat: data.chat || null, messages: Array.isArray(data.messages) ? data.messages : [] };
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
      if (!item) continue;
      if (item.done) return { chat: item.chat || null, messages: Array.isArray(item.messages) ? item.messages : [] };
      if (item.error) throw Object.assign(new Error(String(item.error)), { status: Number(item.status) || 502 });
      if (typeof item.delta === 'string') onDelta(item.delta);
      else if (item.chat && item.chat.uid) onChat(item.chat);
    }
    if (done) throw new Error(t(ERROR_STOPPED));
  }
}

// The Journal tag before a chat's title (a reviewed journal entry, or marked by the person).
function JournalTag() {
  return (
    <Box component="span" className="h5-learn-chat-journal" sx={{
      display: 'inline-flex', alignItems: 'center', flexShrink: 0, height: 18, px: 0.75, borderRadius: 0.5, typography: 'caption', lineHeight: 1,
      fontWeight: 'fontWeightMedium', bgcolor: 'warning.main', color: 'warning.contrastText',
    }}>{t('Journal')}</Box>
  );
}

// A message: the person's on the right (primary at 16%), the model's on the left (the 8dp surface); `lang` from its text; **bold**, line breaks and
// the corrections of a journal entry (`[-x-]` struck through in the error colour, `{+y+}` underlined in the success colour), nothing else as markup.
function Bubble({ role, text, streaming = false }) {
  const mine = role === 'user';
  const shown = mine ? String(text || '') : visibleAnswer(text, { streaming });
  return (
    <Box className="h5-learn-chat-msg" data-role={mine ? 'user' : 'assistant'} data-streaming={streaming ? 'true' : undefined} lang={textLang(shown)} translate="no"
      sx={theme => ({
        alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', boxSizing: 'border-box', px: 1.5, py: 1, borderRadius: 2, typography: 'body2',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'text.primary',
        ...(mine ? { bgcolor: alpha(theme.palette.primary.main, 0.16) } : { bgcolor: 'background.paper', backgroundImage: overlay(8) }),
      })}>
      {mine ? shown : answerParts(shown).map((part, index, parts) => {
        // A deletion right before its insertion keeps a small gap, so "have deployed" and "deployed" read as two words.
        if (part.del) return <Box key={index} component="del" className="h5-learn-chat-del" sx={{ color: 'error.light', textDecorationColor: 'currentColor', mr: parts[index + 1] && parts[index + 1].ins ? 0.5 : 0 }}>{part.text}</Box>;
        if (part.ins) return <Box key={index} component="ins" className="h5-learn-chat-ins" sx={{ color: 'success.light', textDecoration: 'underline', textUnderlineOffset: '2px' }}>{part.text}</Box>;
        if (part.bold) return <Box key={index} component="strong" sx={{ fontWeight: 'fontWeightBold' }}>{part.text}</Box>;
        if (part.italic) return <em key={index}>{part.text}</em>;
        return <span key={index}>{part.text}</span>;
      })}
      {streaming && !shown ? <Box component="span" sx={{ color: 'text.secondary' }}>…</Box> : null}
    </Box>
  );
}

// "Add to my cards" under an answer: an outlined primary chip per expression, "+ <en>" until it is added, then "✓ <en>".
function CardChips({ message, added, adding, error, onAdd }) {
  const cards = Array.isArray(message.cards) ? message.cards.filter(card => card && card.en) : [];
  if (!cards.length) return null;
  return (
    <Box className="h5-learn-chat-cards" data-for={message.uid} sx={{ alignSelf: 'flex-start', maxWidth: '88%', display: 'flex', flexDirection: 'column', gap: 0.75, mt: -0.25 }}>
      <Typography variant="caption" component="p" color="text.secondary">{t('Add to my cards')}</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {cards.map(card => {
          const key = cardKey(card);
          const done = Boolean(card.added) || added.has(key);
          return (
            <Chip key={key} className="h5-learn-chat-card" data-added={done ? 'true' : 'false'} variant="outlined" color="primary" size="small" lang="en" translate="no"
              label={`${done ? '✓' : '+'} ${card.en}`} disabled={!done && adding.has(key)} onClick={done ? undefined : () => onAdd(message, card)}
              sx={{ maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }} />
          );
        })}
      </Box>
      {error ? <Alert severity="error" className="h5-learn-chat-card-error" role="alert" sx={{ py: 0 }}>{error}</Alert> : null}
    </Box>
  );
}

// The rows of the chats (Earlier chats on a phone, the chats list on a computer): the title with its Journal tag, "11-21 22:05 · 6 messages".
function ChatRows({ chats, selected, onPick }) {
  return (
    <List disablePadding className="h5-learn-chat-rows">
      {chats.map(chat => {
        const line = chatLine(chat);
        return (
          <ListItemButton key={chat.uid} className="h5-learn-chat-row" data-uid={chat.uid} selected={chat.uid === selected} aria-current={chat.uid === selected ? 'true' : undefined}
            onClick={() => onPick(chat)} sx={{ display: 'block', px: 2, py: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
              {chat.journal ? <JournalTag /> : null}
              <Typography variant="body2" component="span" className="h5-learn-chat-row-title" noWrap translate="no" lang={textLang(chat.title)} sx={{ fontWeight: 'fontWeightMedium', minWidth: 0 }}>
                {chat.title || t('New chat')}
              </Typography>
            </Box>
            <Typography variant="caption" component="span" color="text.secondary" className="h5-learn-chat-row-line" sx={{ display: 'block' }}>
              {line.time ? `${line.time} · ` : ''}<Fmt template={line.messages[0]} values={line.messages.slice(1)} />
            </Typography>
          </ListItemButton>
        );
      })}
    </List>
  );
}

const KEPT = 'Kept on the server and on your other machines.';

// The chats of this person, read when the view opens: { chats, translator, away, error, reload }.
function useChats() {
  const [state, setState] = useState({ chats: null, translator: true, away: '', error: '' });
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    const control = new AbortController();
    getJson('/api/learn/chats', control.signal).then(data => {
      const list = Array.isArray(data.chats) ? data.chats : [];
      setState(now => ({
        chats: list.reduce((acc, chat) => putChat(acc, chat), (now.chats || []).filter(chat => chat.fresh)), translator: data.translator !== false,
        away: data.offline ? 'offline' : data.home_older ? 'older' : '', error: '',
      }));
    }, failure => { if (!control.signal.aborted) setState(now => ({ ...now, chats: now.chats || [], error: errorText(failure) || t('Operation failed') })); });
    return () => control.abort();
  }, [seq]);
  return { ...state, set: setState, reload: () => setSeq(n => n + 1) };
}

// Earlier chats (a phone's own screen): back to the chat it was opened from, New chat, the rows and where they are kept.
export function EarlierChats({ parent, open }) {
  const list = useChats();
  const current = (parent && parent.uid) || null;
  const toChat = () => open(parent || { kind: 'chat' });
  return (
    <>
      <AppBar position="static" color="default" enableColorOnDark elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Toolbar disableGutters sx={{ minHeight: 56, px: 0.5, gap: 0.5 }}>
          <IconButton id="h5-learn-back" onClick={toChat} {...named(t('Back'))}><Icon name="back" size={22} /></IconButton>
          <Typography id="h5-learn-view-title" variant="subtitle1" component="h2" noWrap sx={{ flex: '1 1 auto', minWidth: 0, fontWeight: 500 }}>{t('Earlier chats')}</Typography>
          <IconButton id="h5-learn-chat-new" onClick={() => open({ kind: 'chat' })} {...named(t('New chat'))}><Icon name="add" size={22} /></IconButton>
        </Toolbar>
      </AppBar>
      <Box id="h5-learn-chats" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', py: 1 }}>
        {list.error ? <Alert severity="error" id="h5-learn-chats-error" sx={{ mx: 2 }} action={<Button color="inherit" size="small" onClick={list.reload}>{t('Try again')}</Button>}>{list.error}</Alert> : null}
        {list.chats === null ? <Typography variant="body2" color="text.secondary" sx={{ px: 2 }}>{t('Loading…')}</Typography> : null}
        {list.chats && !list.chats.length && !list.error ? <Typography id="h5-learn-chats-empty" variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>{t('No chats yet')}</Typography> : null}
        {list.chats && list.chats.length ? <ChatRows chats={list.chats} selected={current} onPick={chat => open({ kind: 'chat', uid: chat.uid })} /> : null}
        <Typography id="h5-learn-chats-note" variant="caption" component="p" color="text.secondary" sx={{ px: 2, pt: 1.5 }}>{t(KEPT)}</Typography>
      </Box>
    </>
  );
}

// `view`: { kind: 'chat', uid?, draft? }; `keys`: a hardware keyboard or a mouse (Enter sends); `back`: to the Learn home.
export function ChatView({ view, phone, keys, ui, open, back, openTranslator }) {
  const list = useChats();
  const [uid, setUid] = useState(view.uid || null);
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState({ state: 'ok', error: '' }); // state 'loading' | 'ok' | 'error'
  const [reloads, setReloads] = useState(0);
  const [pending, setPending] = useState(null); // { question, text }
  const [failed, setFailed] = useState(null); // { question, topic, message, full }
  const [draft, setDraft] = useState(view.draft || '');
  const [added, setAdded] = useState(() => new Set());
  const [adding, setAdding] = useState(() => new Set());
  const [cardError, setCardError] = useState(null); // { uid, message }
  const [menu, setMenu] = useState(null);
  const [renaming, setRenaming] = useState(null); // { title, error, busy }
  const [deleting, setDeleting] = useState(null); // { error, busy }
  const busy = Boolean(pending);
  const abort = useRef(null);
  const created = useRef(null); // the uid of the chat this page has just started (its messages are here already; it is not read again)
  const scroller = useRef(null);
  const input = useRef(null);
  const chat = (list.chats || []).find(item => item.uid === uid) || null;
  const away = list.away;
  const translator = list.translator;
  const setChats = change => list.set(now => ({ ...now, chats: change(now.chats || []) }));
  // A chat that is gone (deleted or pruned on this or another machine, 404 "Chat not found"): out of the list, a new chat in its place, the list read again.
  const leave = gone => {
    if (abort.current) { abort.current.abort(); abort.current = null; setPending(null); }
    created.current = null;
    setFailed(null);
    setChats(now => putChat(now, { uid: gone }, { remove: true }));
    setUid(null);
    list.reload();
  };

  // The messages of the open chat (not for the chat this page has just started).
  useEffect(() => {
    setCardError(null);
    if (!uid) { setMessages([]); setLoaded({ state: 'ok', error: '' }); return undefined; }
    if (created.current === uid) return undefined;
    const control = new AbortController();
    setMessages([]);
    setLoaded({ state: 'loading', error: '' });
    getJson(chatUrl(uid), control.signal).then(data => {
      setMessages(mergeChat(Array.isArray(data.messages) ? data.messages : []));
      if (data.chat && data.chat.uid) setChats(now => putChat(now, data.chat));
      setLoaded({ state: 'ok', error: '' });
    }, failure => {
      if (control.signal.aborted) return;
      if (failure && failure.status === 404) { leave(uid); return; }
      setLoaded({ state: 'error', error: errorText(failure) || t('Operation failed') });
    });
    return () => control.abort();
  }, [uid, reloads]); // eslint-disable-line react-hooks/exhaustive-deps -- setChats writes through the list's setter
  useEffect(() => () => { if (abort.current) abort.current.abort(); }, []);
  useEffect(() => { if (keys && input.current) input.current.focus({ preventScroll: true }); }, [uid]); // eslint-disable-line react-hooks/exhaustive-deps -- when a chat opens

  // The newest message in view as the conversation grows.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, failed, loaded.state]);

  const stop = () => { if (abort.current) { abort.current.abort(); abort.current = null; setPending(null); } };
  const pick = next => {
    if (phone) { open({ kind: 'chat', ...(next ? { uid: next } : {}) }); return; }
    stop();
    created.current = null;
    setFailed(null);
    if (next !== uid) setDraft('');
    setUid(next);
  };
  const newChat = (keepDraft = '') => {
    if (phone) { open({ kind: 'chat', ...(keepDraft ? { draft: keepDraft } : {}) }); return; }
    pick(null);
    setDraft(keepDraft);
    if (input.current) setTimeout(() => input.current && input.current.focus({ preventScroll: true }), 0);
  };

  const send = async (text, { topic = null, typed = false } = {}) => {
    const question = String(text || '').trim().slice(0, CHAT_QUESTION_MAX);
    if (!question || abort.current) return;
    const control = new AbortController();
    abort.current = control;
    const startedNew = !uid;
    const asked = topic || chatTopic(question);
    setFailed(null);
    // A typed question keeps the focus in the input (the send button that turns off while the answer comes would drop it).
    if (typed) { setDraft(''); if (input.current && document.activeElement !== input.current) input.current.focus({ preventScroll: true }); }
    setPending({ question, text: '' });
    const nameChat = next => {
      if (!next || !next.uid) return;
      created.current = next.uid;
      setUid(next.uid);
      setChats(now => putChat(now, { ...next, ...(startedNew ? { fresh: true } : {}) }));
    };
    try {
      const result = await postChat({ chat: uid, question, ...(asked ? { topic: asked } : {}) }, {
        signal: control.signal,
        onChat: nameChat,
        onDelta: piece => setPending(now => (now ? { ...now, text: now.text + piece } : now)),
      });
      if (result.chat) nameChat({ ...result.chat, fresh: false });
      setMessages(now => mergeChat(now, result.messages));
      list.set(now => ({ ...now, translator: true, away: '' }));
    } catch (failure) {
      if (control.signal.aborted) return;
      // Nothing is stored when an answer fails: a chat this question started is gone again.
      if (startedNew && created.current) {
        const gone = created.current;
        created.current = null;
        setChats(now => putChat(now, { uid: gone }, { remove: true }));
        setUid(null);
      }
      const message = errorText(failure) || t('Operation failed');
      if (failure && failure.status === 503 && failure.message === NO_TRANSLATOR) {
        list.set(now => ({ ...now, translator: false }));
        if (typed) setDraft(question);
      } else if (failure && failure.status === 409 && (failure.message === CHAT_FULL || (failure.data && failure.data.full === true))) {
        // A full chat: the question waits in the input for a new chat.
        setFailed({ question, topic: asked, message, full: true });
        setDraft(question);
      } else {
        // A JSON error before the first piece (bad key, timeout: 502 / 504; 409 another answer runs; 429 too many) or a stream that fails half way.
        setFailed({ question, topic: asked, message });
      }
    } finally {
      if (abort.current === control) abort.current = null;
      if (!control.signal.aborted) setPending(null);
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

  const change = async body => {
    const result = await api('PATCH', chatUrl(uid), body);
    if (result && result.chat && result.chat.deleted) { leave(uid); ui.notify(t(PRUNED), 'info'); return; }
    if (result && result.chat) setChats(now => putChat(now, result.chat));
  };
  const gone = failure => failure && failure.status === 404;
  const toggleJournal = async () => {
    setMenu(null);
    try { await change({ journal: !(chat && chat.journal) }); } catch (failure) {
      if (gone(failure)) leave(uid); else ui.notify(errorText(failure) || t('Operation failed'), 'error');
    }
  };
  const saveTitle = async event => {
    event.preventDefault();
    const title = String((renaming && renaming.title) || '').trim().slice(0, CHAT_TITLE_MAX);
    if (!title) return;
    setRenaming(now => ({ ...now, busy: true, error: '' }));
    try { await change({ title }); setRenaming(null); } catch (failure) {
      if (gone(failure)) { setRenaming(null); leave(uid); return; }
      setRenaming(now => (now ? { ...now, busy: false, error: errorText(failure) || t('Operation failed') } : now));
    }
  };
  const remove = async () => {
    setDeleting(now => ({ ...now, busy: true, error: '' }));
    try {
      await api('DELETE', chatUrl(uid));
      setChats(now => putChat(now, { uid }, { remove: true }));
      setDeleting(null);
      newChat();
    } catch (failure) {
      // Already gone on the server: the same as deleted here.
      if (gone(failure)) { setDeleting(null); leave(uid); return; }
      setDeleting(now => (now ? { ...now, busy: false, error: errorText(failure) || t('Operation failed') } : now));
    }
  };

  const fill = chip => {
    const { text, caret } = chipFill(chip, t);
    setDraft(text);
    setTimeout(() => {
      const el = input.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret, caret);
    }, 0);
  };

  const fresh = !uid && !messages.length && !pending && !(failed && !failed.full);
  const full = Boolean(failed && failed.full) || messages.length >= CHAT_MESSAGES_MAX;
  const blocked = busy || !translator || Boolean(away);
  const title = (chat && chat.title) || t('New chat');
  const placeholder = messages.length ? t('Reply or write more') : t('Ask anything about English');
  const moreButton = uid ? (
    <IconButton id="h5-learn-chat-more" aria-haspopup="menu" aria-expanded={menu ? 'true' : 'false'} aria-controls={menu ? 'h5-learn-chat-menu' : undefined}
      onClick={event => setMenu(event.currentTarget)} {...named(t('More'))}><Icon name="taskMore" size={22} /></IconButton>
  ) : null;

  const conversation = (
    <>
      <Box ref={scroller} className="h5-learn-chat-scroll" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', px: phone ? 2 : 3, py: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {away ? <Typography id="h5-learn-chat-away" variant="body2" color="text.secondary" component="p">{t(AWAY[away])}</Typography> : null}
        {!translator && !away ? (
          <TranslatorNotice id="h5-learn-chat-no-translator" onOpen={openTranslator} text="English chat needs a translator. Set one up in Settings → Voice and translation." />
        ) : null}
        {loaded.state === 'error' ? (
          <Alert severity="error" id="h5-learn-chat-load-error" action={<Button color="inherit" size="small" onClick={() => setReloads(n => n + 1)}>{t('Try again')}</Button>}>{loaded.error}</Alert>
        ) : null}
        {loaded.state === 'loading' ? <Typography variant="body2" color="text.secondary" id="h5-learn-chat-loading">{t('Loading…')}</Typography> : null}
        {fresh ? (
          <Box id="h5-learn-chat-start" sx={{ display: 'flex', flexDirection: 'column', gap: 1, pt: phone ? 4 : 6, maxWidth: 560, width: '100%', mx: 'auto' }}>
            <Box aria-hidden="true" sx={{ color: 'primary.main', display: 'flex', justifyContent: 'center' }}><Icon name="learnAsk" size={32} /></Box>
            <Typography variant="h6" component="h3" align="center">{t('Ask anything about English')}</Typography>
            <Typography variant="body2" color="text.secondary" align="center" component="p">
              {t('Words, grammar, how to say something, your journal entries and your learning habits. Ask in Chinese or English.')}
            </Typography>
            <Typography variant="body2" color="text.secondary" component="p" sx={{ mt: 2 }}>{t('Try one:')}</Typography>
            <Box id="h5-learn-chat-chips" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {CHAT_CHIPS.map(chip => (
                <Chip key={chip.id} className="h5-learn-chat-chip" data-chip={chip.id} data-action={chip.action} variant="outlined" label={t(chip.label)} disabled={blocked}
                  onClick={() => (chip.action === 'send' ? send(t(chip.label), { topic: chip.topic }) : fill(chip))} />
              ))}
            </Box>
          </Box>
        ) : null}
        <Box id="h5-learn-chat-log" role="log" aria-live="polite" aria-label={t('Conversation')} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {messages.map(item => (
            <Box key={item.uid} sx={{ display: 'contents' }}>
              <Bubble role={item.role} text={item.text} />
              {item.role === 'assistant' ? (
                <CardChips message={item} added={added} adding={adding} error={cardError && cardError.uid === item.uid ? cardError.message : ''} onAdd={addCard} />
              ) : null}
            </Box>
          ))}
          {pending ? <Bubble role="user" text={pending.question} /> : null}
          {pending ? <Bubble role="assistant" text={pending.text} streaming /> : null}
          {failed && !failed.full ? <Bubble role="user" text={failed.question} /> : null}
        </Box>
        {failed && !failed.full ? (
          <Alert severity="error" id="h5-learn-chat-error" role="alert" action={<Button color="inherit" size="small" id="h5-learn-chat-retry" onClick={() => send(failed.question, { topic: failed.topic })}>{t('Try again')}</Button>}>
            {failed.message}
          </Alert>
        ) : null}
        {full ? (
          <Alert severity="info" id="h5-learn-chat-full" action={<Button color="inherit" size="small" id="h5-learn-chat-full-new" onClick={() => newChat(draft)}>{t('New chat')}</Button>}>
            {failed && failed.full ? failed.message : t(CHAT_FULL)}
          </Alert>
        ) : null}
      </Box>
      {fresh ? (
        <Typography id="h5-learn-chat-privacy" variant="caption" component="p" color="text.secondary" sx={{ flex: '0 0 auto', px: phone ? 2 : 3, pb: 1 }}>
          {t('Your questions and your level go to the translation model you set up. A short summary of your recent mistakes or your journal is added only when you ask about them.')}
        </Typography>
      ) : null}
      <Box component="form" onSubmit={event => { event.preventDefault(); void send(draft, { typed: true }); }}
        sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', gap: 1, px: phone ? 2 : 3, pt: 1, pb: phone ? 'calc(12px + env(safe-area-inset-bottom))' : 1.5, borderTop: 1, borderColor: 'divider' }}>
        <OutlinedInput inputRef={input} fullWidth size="small" multiline maxRows={6} value={draft} placeholder={placeholder} disabled={full && !(failed && failed.full) ? true : undefined}
          onChange={event => setDraft(event.target.value.slice(0, CHAT_QUESTION_MAX))}
          onKeyDown={event => { if (enterSends(event, { keys })) { event.preventDefault(); if (!full) void send(draft, { typed: true }); } }}
          inputProps={{ id: 'h5-learn-chat-input', 'aria-label': placeholder, maxLength: CHAT_QUESTION_MAX, enterKeyHint: keys ? 'send' : 'enter' }}
          sx={{ typography: 'body2' }} />
        <IconButton id="h5-learn-chat-send" type="submit" color="primary" onMouseDown={event => event.preventDefault()} disabled={blocked || full || !draft.trim()} {...named(t('Send'))}>
          <Icon name="send" size={22} />
        </IconButton>
      </Box>
    </>
  );

  const dialogs = (
    <>
      <Menu id="h5-learn-chat-menu" anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <MenuItem id="h5-learn-chat-journal" onClick={toggleJournal}>{chat && chat.journal ? t('Not a journal entry') : t('Mark as journal entry')}</MenuItem>
        <MenuItem id="h5-learn-chat-rename" onClick={() => { setMenu(null); setRenaming({ title: (chat && chat.title) || '', error: '', busy: false }); }}>{t('Rename')}</MenuItem>
        <MenuItem id="h5-learn-chat-delete" onClick={() => { setMenu(null); setDeleting({ error: '', busy: false }); }}>{t('Delete')}</MenuItem>
      </Menu>
      <Dialog open={Boolean(renaming)} onClose={() => setRenaming(null)} maxWidth="sm" fullWidth aria-labelledby="h5-learn-chat-rename-title" slotProps={{ paper: { id: 'h5-learn-chat-rename-dialog' } }}>
        <Box component="form" onSubmit={saveTitle}>
          <DialogTitle id="h5-learn-chat-rename-title">{t('Rename chat')}</DialogTitle>
          <DialogContent>
            <TextField id="h5-learn-chat-title-input" label={t('Title')} fullWidth autoFocus sx={{ mt: 1 }} value={(renaming && renaming.title) || ''} disabled={Boolean(renaming && renaming.busy)}
              onChange={event => { const value = event.target.value.slice(0, CHAT_TITLE_MAX); setRenaming(now => (now ? { ...now, title: value } : now)); }}
              inputProps={{ maxLength: CHAT_TITLE_MAX }} />
            {renaming && renaming.error ? <Alert severity="error" role="alert" id="h5-learn-chat-rename-error" sx={{ mt: 2 }}>{renaming.error}</Alert> : null}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRenaming(null)}>{t('Cancel')}</Button>
            <Button type="submit" variant="contained" id="h5-learn-chat-rename-save" disabled={!String((renaming && renaming.title) || '').trim() || Boolean(renaming && renaming.busy)}>{t('Save')}</Button>
          </DialogActions>
        </Box>
      </Dialog>
      <Dialog open={Boolean(deleting)} onClose={() => setDeleting(null)} maxWidth="xs" fullWidth aria-labelledby="h5-learn-chat-delete-title" slotProps={{ paper: { id: 'h5-learn-chat-delete-dialog' } }}>
        <DialogTitle id="h5-learn-chat-delete-title">{t('Delete this chat?')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t('It is deleted on all your machines. Cards you added from it stay.')}</DialogContentText>
          {deleting && deleting.error ? <Alert severity="error" role="alert" id="h5-learn-chat-delete-error" sx={{ mt: 2 }}>{deleting.error}</Alert> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>{t('Cancel')}</Button>
          <Button color="error" id="h5-learn-chat-delete-confirm" disabled={Boolean(deleting && deleting.busy)} onClick={remove}>{t('Delete')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );

  if (phone) {
    return (
      <>
        <AppBar position="static" color="default" enableColorOnDark elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
          <Toolbar disableGutters sx={{ minHeight: 56, px: 0.5, gap: 0.5 }}>
            <IconButton id="h5-learn-back" onClick={back} {...named(t('Back'))}><Icon name="back" size={22} /></IconButton>
            <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
              <Typography id="h5-learn-view-title" variant="subtitle1" component="h2" noWrap sx={{ fontWeight: 500, lineHeight: 1.3 }}>{t('English chat')}</Typography>
              <Box className="h5-learn-subtitle" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                {chat && chat.journal ? <JournalTag /> : null}
                <Typography id="h5-learn-chat-title" variant="caption" component="p" color="text.secondary" noWrap translate="no" sx={{ minWidth: 0 }}>{title}</Typography>
              </Box>
            </Box>
            <IconButton id="h5-learn-chat-history" onClick={() => open({ kind: 'chats', parent: { kind: 'chat', ...(uid ? { uid } : {}) } })} {...named(t('Earlier chats'))}><Icon name="learnHistory" size={22} /></IconButton>
            <IconButton id="h5-learn-chat-new" onClick={() => newChat()} {...named(t('New chat'))}><Icon name="add" size={22} /></IconButton>
            {moreButton}
          </Toolbar>
        </AppBar>
        <Box id="h5-learn-chat" data-layout="phone" sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>{conversation}</Box>
        {dialogs}
      </>
    );
  }
  return (
    <Box id="h5-learn-chat" data-layout="wide" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', minHeight: 0, height: '100%' }}>
      <Box id="h5-learn-chats" sx={{ flex: '0 0 260px', width: 260, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: 1, borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, pt: 3, pb: 1, minHeight: 40 }}>
          <Typography variant="subtitle2" component="h2" sx={{ flex: '1 1 auto' }}>{t('Chats')}</Typography>
          <Button id="h5-learn-chat-new" size="small" startIcon={<Icon name="add" size={18} />} onClick={() => newChat()}>{t('New chat')}</Button>
        </Box>
        <Box sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
          {list.error ? <Alert severity="error" id="h5-learn-chats-error" sx={{ mx: 2 }} action={<Button color="inherit" size="small" onClick={list.reload}>{t('Try again')}</Button>}>{list.error}</Alert> : null}
          {list.chats && !list.chats.length && !list.error ? <Typography id="h5-learn-chats-empty" variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>{t('No chats yet')}</Typography> : null}
          {list.chats && list.chats.length ? <ChatRows chats={list.chats} selected={uid} onPick={item => pick(item.uid)} /> : null}
          <Typography id="h5-learn-chats-note" variant="caption" component="p" color="text.secondary" sx={{ px: 2, py: 1.5 }}>{t(KEPT)}</Typography>
        </Box>
      </Box>
      <Box sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 3, pr: 2, pt: 3, pb: 1, minHeight: 40 }}>
          {chat && chat.journal ? <JournalTag /> : null}
          <Typography id="h5-learn-view-title" variant="h6" component="h2" noWrap translate="no" sx={{ flex: '1 1 auto', minWidth: 0 }}>{title}</Typography>
          {moreButton}
          <IconButton id="h5-learn-back" size="small" onClick={back} {...named(t('Close'))}><Icon name="close" size={20} /></IconButton>
        </Box>
        {conversation}
      </Box>
      {dialogs}
    </Box>
  );
}
