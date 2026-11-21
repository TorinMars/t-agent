import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { errorText, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { overlay } from './Columns.jsx';
import { Fmt, TranslatorNotice, tf } from './Learn.jsx';
import { ASK_QUESTION_MAX, askCaption, askChips, askKind, askState, boldParts, mergeMessages, ndjsonLines, textLang } from './learn-model.mjs';

// "Ask about this question" ("Ask about this question" in docs/design/learn-english-page.md): a conversation with the translation model about the card
// on screen, opened with the Ask button of every practice card. On a phone an MD2 modal bottom sheet over the card (`#h5-learn-ask`,
// data-layout="sheet"); on a computer a 380px side panel right of the card, which stays usable (data-layout="side"). The same content in both:
// the title, a caption (hints only before Check; the person's answer after it), Close, the quick questions (chips, sent at once), the card's earlier
// messages (GET /api/learn/cards/:id/ask), the answer as it streams (POST, NDJSON; a company computer answers plain JSON), and the input.
// Keys typed here never reach the exercise: the page's keyboard and the letter slots belong to the card's field, and Session's keys skip this panel.
// Closing gives the focus back to the exercise field.

export const ASK_WIDTH = 380;
const ERROR_STOPPED = 'The answer stopped before it was complete.';
// The 503 of an engine without a translator (any other 503, such as a company computer whose home cannot be reached, shows the server's message).
const NO_TRANSLATOR = 'Translation service not configured yet';
// A company computer asks its home (the normal computer that keeps the learning data); GET says when that home cannot answer.
const AWAY = { offline: 'Questions are answered by your normal computer, which cannot be reached right now.', older: 'Your normal computer needs an update to answer questions.' };

// The answer of POST /ask: an NDJSON stream read as it comes (`onDelta` per piece) or a plain JSON body. Returns the stored messages.
async function postAsk(cardId, body, { signal, onDelta }) {
  const res = await fetch(`/api/learn/cards/${encodeURIComponent(cardId)}/ask`, {
    method: 'POST', signal, headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const type = String(res.headers.get('content-type') || '');
  if (!res.ok || !type.includes('ndjson') || !res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    if (!res.ok) throw Object.assign(new Error((data && data.error) || text || `HTTP ${res.status}`), { data, status: res.status });
    return (data && data.messages) || [];
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
      if (item && typeof item.delta === 'string') onDelta(item.delta);
      else if (item && item.error) throw Object.assign(new Error(String(item.error)), { status: Number(item.status) || 502 });
      else if (item && item.done) return Array.isArray(item.messages) ? item.messages : [];
    }
    if (done) throw new Error(ERROR_STOPPED);
  }
}

async function getAsk(cardId, signal) {
  const res = await fetch(`/api/learn/cards/${encodeURIComponent(cardId)}/ask`, { signal, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || text || `HTTP ${res.status}`), { data, status: res.status });
  return data || {};
}

// A message: the person's on the right (primary at 16%), the model's on the left (the 8dp surface); `lang` from its text, **bold** drawn, line
// breaks kept, nothing else read as markup (React text only).
function Bubble({ role, text, streaming = false }) {
  const mine = role === 'user';
  return (
    <Box className="h5-learn-ask-msg" data-role={mine ? 'user' : 'assistant'} data-streaming={streaming ? 'true' : undefined} lang={textLang(text)} translate="no"
      sx={theme => ({
        alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', boxSizing: 'border-box', px: 1.5, py: 1, borderRadius: 2, typography: 'body2',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'text.primary',
        ...(mine ? { bgcolor: alpha(theme.palette.primary.main, 0.16) } : { bgcolor: 'background.paper', backgroundImage: overlay(8) }),
      })}>
      {boldParts(text).map((part, index) => {
        if (part.bold) return <Box key={index} component="strong" sx={{ fontWeight: 'fontWeightBold' }}>{part.text}</Box>;
        return part.italic ? <em key={index}>{part.text}</em> : <span key={index}>{part.text}</span>;
      })}
      {streaming && !text ? <Box component="span" sx={{ color: 'text.secondary' }}>…</Box> : null}
    </Box>
  );
}

// `card`, `exercise`: the card and the exercise on screen; `result`: the checked result (null before Check); `answer()`: the person's answer;
// `expected`: what the exercise asks for when it is not the card's English (Fill the gap's word); `gap`: the card shows a sentence with a gap; `field`: the exercise field that gets the focus back; `keys`: a hardware keyboard (on a touch screen
// only a field that never opens the system keyboard is focused again).
export function AskPanel({ open, onClose, phone, card, exercise, result, answer, expected = '', gap = false, field = null, keys = false, openTranslator }) {
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState({ state: 'idle', earlier: null, error: '' }); // state 'idle' | 'loading' | 'ok' | 'error'; `earlier`: the questions stored before the first opening
  const [translator, setTranslator] = useState(true);
  const [away, setAway] = useState(''); // '' | 'offline' | 'older': a company computer whose home cannot answer
  const [pending, setPending] = useState(null); // { question, text }
  const [failed, setFailed] = useState(null); // { question, message }
  const [draft, setDraft] = useState('');
  const busy = Boolean(pending);
  const abort = useRef(null);
  const scroller = useRef(null);
  const input = useRef(null);
  const checked = Boolean(result);
  const kind = askKind(card, exercise);

  // The earlier messages each time it opens (not while an answer is on its way); the request ends with the card.
  const load = () => {
    const control = new AbortController();
    setLoaded(now => ({ ...now, state: 'loading', error: '' }));
    getAsk(card.id, control.signal).then(data => {
      const list = Array.isArray(data.messages) ? data.messages : [];
      setMessages(now => mergeMessages(now, list));
      setTranslator(data.translator !== false);
      setAway(data.offline ? 'offline' : data.home_older ? 'older' : '');
      setLoaded(now => ({ state: 'ok', earlier: now.earlier === null ? list.filter(item => item && item.role === 'user').length : now.earlier, error: '' }));
    }, failure => { if (!control.signal.aborted) setLoaded(now => ({ ...now, state: 'error', error: errorText(failure) || t('Operation failed') })); });
    return control;
  };
  useEffect(() => {
    if (!open || busy) return undefined;
    const control = load();
    return () => control.abort();
  }, [open, card.id]); // eslint-disable-line react-hooks/exhaustive-deps -- once per opening
  useEffect(() => () => { if (abort.current) abort.current.abort(); }, []);

  // The newest message in view as the conversation grows.
  useEffect(() => {
    const el = scroller.current;
    if (el && (pending || failed || messages.length)) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending, failed, open]);

  const send = async (text, { typed = false } = {}) => {
    const question = String(text || '').trim().slice(0, ASK_QUESTION_MAX);
    if (!question || abort.current) return;
    const control = new AbortController();
    abort.current = control;
    setFailed(null);
    // A typed question keeps the focus in the input (the send button that turns off while the answer comes would drop it).
    if (typed) { setDraft(''); if (input.current && document.activeElement !== input.current) input.current.focus({ preventScroll: true }); }
    setPending({ question, text: '' });
    try {
      const stored = await postAsk(card.id, { question, mode: exercise, state: askState(result, answer(), expected) }, {
        signal: control.signal,
        onDelta: piece => setPending(now => (now ? { ...now, text: now.text + piece } : now)),
      });
      setMessages(now => mergeMessages(now, stored));
      setTranslator(true);
      setAway('');
    } catch (failure) {
      if (control.signal.aborted) return;
      // A JSON error before the first piece of the answer (bad key, timeout: 502 / 504; 409 another question runs; 429 too many) or a stream
      // that fails half way shows the server's message with Try again; only the "no translator" 503 shows the translator notice.
      if (failure && failure.status === 503 && failure.message === NO_TRANSLATOR) {
        setTranslator(false);
        if (typed) setDraft(question);
      } else {
        setFailed({ question, message: errorText(failure) || t('Operation failed') });
      }
    } finally {
      if (abort.current === control) abort.current = null;
      if (!control.signal.aborted) setPending(null);
    }
  };

  const close = () => {
    // Closing stops an answer on its way (the server stores nothing for it).
    if (abort.current) { abort.current.abort(); abort.current = null; setPending(null); }
    onClose();
    // The exercise field again (the sheet's own focus restore is off: the Ask button may have had it).
    const el = field && field.current;
    if (el && (keys || el.inputMode === 'none')) setTimeout(() => { if (el.isConnected) el.focus({ preventScroll: true }); }, 0);
  };
  // Escape closes the side panel (on a phone the sheet is a modal, which closes on Escape itself) before Learn closes the mode; keys typed here stay here.
  useEffect(() => {
    if (phone || !open) return undefined;
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps -- `close` of this render
  useEffect(() => {
    if (open && !phone && keys && input.current) input.current.focus({ preventScroll: true });
  }, [open, phone]); // eslint-disable-line react-hooks/exhaustive-deps -- when it opens

  const [template, ...values] = askCaption({ checked, gap, answer: checked ? answer() : '', correct: Boolean(result && result.correct) });
  const chips = askChips({ kind, checked, correct: Boolean(result && result.correct) });
  const earlier = loaded.earlier;
  const contents = (
    <>
      {phone ? (
        <Box aria-hidden="true" sx={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center', pt: 1 }}>
          <Box sx={{ width: 32, height: 4, borderRadius: 2, bgcolor: 'text.disabled' }} />
        </Box>
      ) : null}
      <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', gap: 1, px: 2, pt: phone ? 1 : 2, pb: 1 }}>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography id="h5-learn-ask-title" variant="h6" component="h2">{t('Ask about this question')}</Typography>
          <Typography id="h5-learn-ask-caption" variant="caption" component="p" color="text.secondary"><Fmt template={template} values={values} /></Typography>
        </Box>
        <Button id="h5-learn-ask-close" onClick={close} sx={{ flexShrink: 0, mr: -1 }}>{t('Close')}</Button>
      </Box>
      <Box ref={scroller} className="h5-learn-ask-scroll" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', px: 2, pb: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary" component="p">{t('Try one, or type your own (Chinese or English):')}</Typography>
        <Box id="h5-learn-ask-chips" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {chips.map(chip => (
            <Chip key={chip} className="h5-learn-ask-chip" variant="outlined" label={t(chip)} disabled={busy || !translator || Boolean(away)} onClick={() => send(t(chip))} />
          ))}
        </Box>
        {away ? <Typography id="h5-learn-ask-away" variant="body2" color="text.secondary" component="p">{t(AWAY[away])}</Typography> : null}
        {!translator && !away ? (
          <TranslatorNotice id="h5-learn-ask-no-translator" onOpen={openTranslator} text="Asking about a question needs a translator. Set one up in Settings → Voice and translation." />
        ) : null}
        {loaded.state === 'error' ? (
          <Alert severity="error" id="h5-learn-ask-load-error" action={<Button color="inherit" size="small" onClick={() => load()}>{t('Try again')}</Button>}>{loaded.error}</Alert>
        ) : null}
        <Box id="h5-learn-ask-log" role="log" aria-live="polite" aria-label={t('Conversation')} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {earlier ? (
            <Typography id="h5-learn-ask-earlier" variant="overline" component="p" color="text.secondary" sx={{ lineHeight: 2 }}>
              {earlier === 1 ? t('1 earlier question') : tf('{1} earlier questions', earlier)}
            </Typography>
          ) : null}
          {messages.map(item => <Bubble key={item.uid} role={item.role} text={item.text} />)}
          {pending ? <Bubble role="user" text={pending.question} /> : null}
          {pending ? <Bubble role="assistant" text={pending.text} streaming /> : null}
          {failed ? <Bubble role="user" text={failed.question} /> : null}
        </Box>
        {failed ? (
          <Alert severity="error" id="h5-learn-ask-error" role="alert" action={<Button color="inherit" size="small" id="h5-learn-ask-retry" onClick={() => send(failed.question)}>{t('Try again')}</Button>}>
            {failed.message}
          </Alert>
        ) : null}
      </Box>
      {checked ? null : (
        <Typography id="h5-learn-ask-hints-note" variant="caption" component="p" color="text.secondary" sx={{ flex: '0 0 auto', px: 2, pb: 0.5 }}>
          {t('Before you check, the answer is not given away, only hints.')}
        </Typography>
      )}
      <Box component="form" onSubmit={event => { event.preventDefault(); void send(draft, { typed: true }); }}
        sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', gap: 1, px: 2, pt: 1, pb: phone ? 'calc(12px + env(safe-area-inset-bottom))' : 1.5, borderTop: 1, borderColor: 'divider' }}>
        <OutlinedInput inputRef={input} fullWidth size="small" multiline maxRows={4} value={draft} placeholder={checked ? t('Ask a follow-up') : t('Ask about this word or sentence')}
          onChange={event => setDraft(event.target.value.slice(0, ASK_QUESTION_MAX))}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(draft, { typed: true }); }
          }}
          inputProps={{ id: 'h5-learn-ask-input', 'aria-label': checked ? t('Ask a follow-up') : t('Ask about this word or sentence'), maxLength: ASK_QUESTION_MAX, enterKeyHint: 'send' }}
          sx={{ typography: 'body2' }} />
        <IconButton id="h5-learn-ask-send" type="submit" color="primary" onMouseDown={event => event.preventDefault()} disabled={busy || !draft.trim() || !translator || Boolean(away)} {...named(t('Send'))}><Icon name="send" size={22} /></IconButton>
      </Box>
    </>
  );
  const paper = { display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundImage: overlay(16) };
  if (phone) {
    return (
      <Drawer anchor="bottom" open={open} onClose={close} ModalProps={{ disableScrollLock: true, disableRestoreFocus: true }}
        sx={theme => ({ zIndex: theme.zIndex.modal + 1 })}
        slotProps={{
          backdrop: { sx: { bgcolor: 'rgba(0, 0, 0, 0.32)' } },
          paper: {
            id: 'h5-learn-ask', className: 'h5-learn-ask', 'data-layout': 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'h5-learn-ask-title',
            // The top at about 150px (less on a short screen), the bottom at the bottom of the screen or, with the system keyboard up, at its top.
            sx: { ...paper, top: 'min(150px, 18vh)', bottom: 'auto', height: 'calc(var(--h5-height, 100dvh) - min(150px, 18vh))', maxHeight: 'none', borderTopLeftRadius: 8, borderTopRightRadius: 8 },
          },
        }}>
        {contents}
      </Drawer>
    );
  }
  if (!open) return null;
  return (
    <Box id="h5-learn-ask" className="h5-learn-ask" data-layout="side" role="complementary" aria-labelledby="h5-learn-ask-title"
      sx={{ ...paper, position: 'fixed', top: 0, right: 0, bottom: 0, width: ASK_WIDTH, zIndex: 1, bgcolor: 'background.default', backgroundImage: 'none', borderLeft: 1, borderColor: 'divider' }}>
      {contents}
    </Box>
  );
}
