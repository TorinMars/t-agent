import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import OutlinedInput from '@mui/material/OutlinedInput';
import Slide from '@mui/material/Slide';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { api, errorText, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import './learn-icons.mjs';
import { NAV_WIDTH } from './columns.mjs';
import { overlay } from './Columns.jsx';
import { SwitchRow } from './Form.jsx';
import TextField from './TextField.jsx';
import { TOUCH } from './theme.mjs';
import { BACKSPACE, Keyboard, SHIFT, chars, rowsFor } from './Osk.jsx';
import { AUTO_CHECK_MS, alignSpelling, diffWords, hintText, mistakeTag, nearMiss, normWord, partsOf, spellCheck, spellingNote, spellingPattern, suggestedGrade, typedInFull } from './learn-grade.mjs';
import { BUILD_HIDDEN, SENTENCE_EXERCISE, availableModes, builtAnswer, exerciseFor, exerciseKey, gapFor, goalProgress, hintTile, levelNote, maskedContext, minutesFor, mixCards, modeOf, pickedNote, sentenceGap, slotLayout, tilesFor } from './learn-model.mjs';
import { attachVoice, canSpeak, isSpeaking, speakOnce, stopSpeaking, voiceWay } from './learn-speech.mjs';
import { audioOptions, autoPlays, createPlayer } from './learn-audio.mjs';
import { MistakesView, NewReportLine, ReportView, ReportsView } from './LearnMistakes.jsx';
import { ASK_WIDTH, AskPanel } from './LearnAsk.jsx';
import { ChatView, EarlierChats } from './LearnChat.jsx';
import { CoachSettings, CoachView, useCoachSupport } from './LearnCoach.jsx';
import { createSeries, exerciseCard, seriesAnswer, seriesCurrent, seriesDone, seriesProgress, seriesResult } from './learn-series.mjs';
import { ProgressView } from './LearnProgress.jsx';
import { gradeIntervals } from './learn-progress.mjs';
import { PRACTICE_FLASH_MS, PRACTICE_ROUND_MS, practiceChange, practiceClearFlash, practiceNewRound, practiceSlots, practiceStart, practiceText } from './learn-practice.mjs';
import { cleanTyped, createComposer, hasImeText, inputSourceBridge, isImeKey, keyLetter } from './learn-input.mjs';

// The Learn page (the "Learn" destination of the navigation rail and the bottom navigation; a chunk of its own, screen-learn.jsx). English practice
// with the person's own material: the sentences sent with "Chinese -> English" and the words looked up in the chat (the server's /api/learn, see
// docs/design/learn-english.md), plus an optional starter list.
// - Computer: a page right of the rail (like Settings): the home on the left (today's due cards, the goal, the streak, Start review, the practice modes
//   with their counts, Mistakes, English chat, Your material, Learn settings) and the open mode on the right ("How learning works" while none is open). Escape closes
//   the open mode, then the page; the back button closes the page (entry.jsx).
// - Phone: a full-screen page above the bottom navigation (a modal, so back.mjs closes it), and each mode a page over it with a back arrow. Both end
//   at the bottom navigation and, while the system keyboard is up, at the top of the keyboard (`--h5-height`, h5.js `fitViewport`), so the answer
//   field and the Check button stay in sight.
// - Touch screen (no hardware keyboard seen): the answer fields never open the system keyboard; T-Agent's own keyboard sits at the bottom of the mode
//   instead (`useLearnKeys`), and the bottom navigation steps aside while it is open (`state.learnKeys`).
// Grading runs in the browser (learn-grade.mjs); each answer is sent with POST /api/learn/cards/:id/answer and the grade the person chose (Again /
// Hard / Good, keys 1 / 2 / 3 on a computer; Enter checks, Enter again takes the offered grade). See "The Learn page" in docs/design/learn-english-page.md.

// A translated template with its values put in as user content (never translated: a word of a card could be a dictionary key).
export function Fmt({ template, values = [] }) {
  const parts = t(template).split(/(\{\d\})/);
  return (
    <>
      {parts.map((part, index) => {
        const slot = /^\{(\d)\}$/.exec(part);
        return slot ? <Box key={index} component="span" translate="no">{values[Number(slot[1]) - 1]}</Box> : <span key={index}>{part}</span>;
      })}
    </>
  );
}
export const tf = (template, ...values) => t(template).replace(/\{(\d)\}/g, (all, number) => String(values[Number(number) - 1]));
// "42 words": the number and a translated noun (exact dictionary keys, not a "{1} words" template that would match any text ending in "words").
const count = (n, one, many) => `${n} ${t(n === 1 ? one : many)}`;

const SOURCE_LABELS = { translation: 'from your translations', lookup: 'from words you looked up', starter: 'from the starter list', manual: 'added by you' };
const sourceLabel = card => t(SOURCE_LABELS[card && card.source] || SOURCE_LABELS.manual);
export const shortDate = iso => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
// A phone page: from the top of the window to the bottom navigation, or to the top of the system keyboard while it is up (the bar is away then).
const PHONE_ROOT = { top: 0, bottom: 'auto', height: 'calc(var(--h5-height, 100dvh) - var(--h5-bnav-space, 0px))', transform: 'translateZ(0)' };
const PAPER = { backgroundImage: 'none', bgcolor: 'background.default' };
const modalOpen = () => [...document.body.children].some(el => el.classList && el.classList.contains('MuiModal-root') && !el.classList.contains('MuiModal-hidden') && el.id !== 'h5-learn' && el.id !== 'h5-learn-mode');

export function LearnPage({ state, ui }) {
  if (!state.learnOpen) return null;
  return <Learn state={state} ui={ui} />;
}

function useLearnData() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(null);
  // Resolves with the new summary (null on a failure): the end of a round reads `minutes_today` from it.
  const reload = useCallback(() => api('GET', '/api/learn/summary').then(
    data => { setSummary(data || {}); setError(''); return data || {}; },
    failure => { setError(errorText(failure) || t('Could not load your study cards.')); return null; },
  ), []);
  useEffect(() => {
    void reload();
    api('GET', '/api/learn/settings').then(data => {
      setSettings(data || {});
      // Mistake reports are written in the language this page shows; the server keeps the last one for the weekly report (shared setting). Only a
      // server that has the setting is told.
      const lang = typeof I18n !== 'undefined' && I18n.get() === 'zh' ? 'zh' : 'en';
      if (data && typeof data.report_lang === 'string' && data.report_lang !== lang) api('PUT', '/api/learn/settings', { report_lang: lang }).then(next => { if (next) setSettings(next); }, () => {});
    }, () => setSettings({}));
  }, [reload]);
  return { summary, error, reload, settings, setSettings };
}

// Speech output (Hear it, Dictation) and the way Say it hears the person, read when the page opens (the voices may come a moment later).
function useSpeech() {
  const [tts, setTts] = useState(canSpeak);
  const [voice] = useState(voiceWay);
  useEffect(() => {
    const speech = window.speechSynthesis;
    if (!speech || typeof speech.addEventListener !== 'function') return undefined;
    const update = () => setTts(canSpeak());
    speech.addEventListener('voiceschanged', update);
    return () => { speech.removeEventListener('voiceschanged', update); stopSpeaking(); };
  }, []);
  return { tts, voice: Boolean(voice) };
}

function Learn({ state, ui }) {
  const phone = !state.wide;
  const keys = state.input === 'pointer' || Boolean(state.hasKeyboard);
  const data = useLearnData();
  const speech = useSpeech();
  // 'chat': the coach (LearnCoach.jsx; the old English chat on an engine without it), 'chats' / 'oldchat': earlier chats, 'series': a practice series of the coach.
  const [view, setView] = useState(null); // { kind: 'session' | 'material' | 'settings' | 'mistakes' | 'reports' | 'report' | 'how' | 'chat' | 'chats' | 'oldchat' | 'series' | 'progress', mode?, preset?, uid?, seq }
  const viewRef = useRef(null);
  viewRef.current = view;
  const close = () => ui.actions.closeLearn();
  const back = () => { setView(null); void data.reload(); };
  const open = next => setView({ ...next, seq: Date.now() });
  const openTranslator = () => { ui.actions.closeLearn(); ui.actions.openSettings('voice-translate'); };
  const modes = availableModes(speech);
  // Leaving a practice series (back arrow, back button, Escape) goes through the series, which posts what was answered and returns to the coach.
  const seriesLeave = useRef(null);
  // Back (the back button, Escape) from a view: a series ends, an earlier chat returns to its list (phone) or the coach, a view opened from the
  // coach (its settings, its earlier chats) returns there; every other view goes to the home.
  const leaveView = () => {
    const now = viewRef.current;
    if (!now) return;
    if (now.kind === 'series' && seriesLeave.current) { seriesLeave.current(); return; }
    if (now.kind === 'oldchat') { open(phone ? { kind: 'chats', readOnly: true, parent: now.parent || { kind: 'chat' } } : now.parent || { kind: 'chat' }); return; }
    if (now.kind === 'chats' || (now.kind === 'settings' && now.parent && now.parent.kind === 'chat')) { open(now.parent || { kind: 'chat' }); return; }
    back();
  };
  const common = { ui, phone, keys, speech, openTranslator, data, open, back, seriesLeave };
  const input = useLearnInputState();

  // Computer: Escape closes the open mode, then the page (unless something above takes it); the focus goes into the page and back to the opener.
  const root = useRef(null);
  useEffect(() => {
    if (phone) return undefined;
    const opener = document.activeElement;
    const title = document.getElementById('h5-learn-title');
    if (title && root.current && !root.current.contains(document.activeElement)) title.focus({ preventScroll: true });
    const onKey = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || modalOpen()) return;
      event.preventDefault();
      if (viewRef.current) leaveView(); else close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected && typeof opener.focus === 'function') setTimeout(() => opener.focus({ preventScroll: true }), 0);
    };
  }, [phone]); // eslint-disable-line react-hooks/exhaustive-deps -- close and back read the store and the ref

  const home = <Home {...common} modes={modes} current={view && view.kind === 'session' ? view.mode : view && view.kind} />;
  if (!phone) {
    // The coach fills the pane (LearnCoach.jsx; the old English chat with its chats list on an engine without it); Earlier chats is a phone's screen,
    // on a computer the read-only chats list and conversation (`oldchat`) are there. A practice series opens in the pane like any mode.
    const chat = view && (view.kind === 'chat' || view.kind === 'chats' || view.kind === 'oldchat');
    return (
      <LearnInput.Provider value={input}>
      <Box ref={root} id="h5-learn" role="region" aria-labelledby="h5-learn-title" data-layout="wide"
        sx={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: state.pane ? 0 : NAV_WIDTH, zIndex: 1255, display: 'flex', bgcolor: 'background.default', color: 'text.primary' }}>
        <Box className="h5-learn-home" sx={{ flex: '0 0 420px', width: 420, boxSizing: 'border-box', overflowY: 'auto', p: 3, display: 'flex', flexDirection: 'column', gap: 1.5, borderRight: 1, borderColor: 'divider', '& > *': { flexShrink: 0 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography id="h5-learn-title" variant="h5" component="h1" tabIndex={-1} sx={{ flex: '1 1 auto', outline: 'none' }}>{t('Learn English')}</Typography>
            <IconButton id="h5-learn-close" edge="end" onClick={close} {...named(t('Close'))}><Icon name="close" size={20} /></IconButton>
          </Box>
          {home}
        </Box>
        {/* The Ask side panel (LearnAsk.jsx) lies at the right of the window; on a window wide enough the card makes room for it, else the panel covers its right part. */}
        {chat ? (
          <Box className="h5-learn-pane" sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex' }}>
            {view.kind === 'oldchat' ? <ChatView key={view.seq} view={view} readOnly {...common} />
              : view.kind === 'chats' ? <ChatView key={view.seq} view={view.parent || { kind: 'chat' }} {...common} />
                : <CoachView key={view.seq} view={view} {...common} />}
          </Box>
        ) : (
          <Box className="h5-learn-pane" sx={{ flex: '1 1 auto', minWidth: 0, overflowY: 'auto', px: 4, py: 3, '@media (min-width: 1200px)': { '&:has(#h5-learn-ask[data-layout="side"])': { pr: `${ASK_WIDTH + 32}px` } } }}>
            <Box sx={{ maxWidth: 880 }}>
              {view ? <ViewBody key={view.seq} view={view} {...common} /> : <HowView frame={{ phone: false, title: t('How learning works') }} />}
            </Box>
          </Box>
        )}
      </Box>
      </LearnInput.Provider>
    );
  }
  return <LearnInput.Provider value={input}><PhoneLearn {...common} view={view} close={close} home={home} leave={leaveView} /></LearnInput.Provider>;
}

// ── English input while spelling ("English input" in docs/design/learn-spell-practice.md) ──
// The Mac app's input source switch (learn-input.mjs `inputSourceBridge`: 'english' while a Spell answer field or the practice row has the focus,
// 'restore' after it, and when Learn closes or the page goes away; nothing outside the app). The notice that an input method is on shows from the
// first composition of this Learn session until OK, and not again after OK while Learn stays open (state of this page only: nothing is stored); never
// in the Mac app, which switches the input source instead.
const inputSource = inputSourceBridge();
const LearnInput = createContext({ notice: false, seen: () => {}, dismiss: () => {} });
function useLearnInputState() {
  const [notice, setNotice] = useState('off'); // off | shown | dismissed
  useEffect(() => {
    const away = () => inputSource.close();
    window.addEventListener('pagehide', away);
    return () => { window.removeEventListener('pagehide', away); inputSource.close(); };
  }, []);
  return useMemo(() => ({
    notice: notice === 'shown',
    seen: () => { if (!inputSource.available()) setNotice(now => (now === 'off' ? 'shown' : now)); },
    dismiss: () => setNotice('dismissed'),
  }), [notice]);
}

// A field that takes English letters even while an input method composes: during a composition the field keeps the input method's own text (so it
// keeps working) while `change` gets the letters typed (createComposer); the text it commits (Chinese characters) is dropped; a value an input method
// changed without a composition is mended (cleanTyped). `change(text, { composing })`. Returns the field's `value`, its `onChange` and the native
// `props` (keydown and the composition events) for inputProps.
function useLatinInput({ value, change, onIme }) {
  const composer = useRef(null);
  const pending = useRef(''); // letters of input method keys pressed outside a composition (the keydown that starts one comes first)
  const ended = useRef(null);
  const [raw, setRaw] = useState(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const props = {
    onKeyDown: event => {
      if (!isImeKey(event)) { pending.current = ''; return; }
      onIme();
      const letter = keyLetter(event);
      const back = event.key === 'Backspace' || event.code === 'Backspace';
      if (composer.current) composer.current.key({ letter, back });
      else if (letter) pending.current += letter;
      else if (back) pending.current = pending.current.slice(0, -1);
    },
    onCompositionStart: event => {
      onIme();
      const el = event.target;
      composer.current = createComposer(valueRef.current, el.selectionStart, el.selectionEnd, pending.current);
      pending.current = '';
      setRaw(el.value);
    },
    onCompositionUpdate: event => { if (composer.current) change(composer.current.update(event.data), { composing: true }); },
    onCompositionEnd: event => {
      const current = composer.current;
      if (!current) return;
      composer.current = null;
      const final = current.end(event.data);
      // Safari sends the input event of the committed text after compositionend: a value with the input method's text is taken as this same text.
      ended.current = final;
      setRaw(null);
      change(final, { composing: false });
    },
  };
  const onChange = event => {
    const dom = event.target.value;
    if (composer.current) { setRaw(dom); return; }
    const final = ended.current;
    ended.current = null;
    if (final !== null && hasImeText(dom)) { change(final, { composing: false }); return; }
    const clean = cleanTyped(dom, pending.current);
    if (clean.ime) onIme();
    pending.current = '';
    change(clean.text, { composing: false });
  };
  return { value: raw !== null ? raw : value, onChange, props, composing: raw !== null };
}
const Kbd = ({ children }) => (
  <Box component="kbd" sx={theme => ({ fontFamily: MONO, fontSize: '0.85em', px: 0.5, borderRadius: 0.5, bgcolor: alpha(theme.palette.text.primary, 0.12), whiteSpace: 'nowrap' })}>{children}</Box>
);
// Key names stay as printed on the keys (not translated).
const CTRL_SPACE = <><Kbd>Ctrl</Kbd>+<Kbd>Space</Kbd></>;
// The notice above the letters (an MD2 inline banner in the info colour, role=status so it is read without taking the focus).
function ImeNotice({ onOk, field }) {
  return (
    <Alert severity="info" role="status" id="h5-learn-ime-notice" sx={{ mb: 1, alignItems: 'center' }}
      action={<Button color="inherit" id="h5-learn-ime-ok" onClick={onOk} {...keepFocus(field)}>{t('OK')}</Button>}>
      <Fmt template="Chinese input is on. Your letters still count; to switch, press {1} (on a Mac {2} or {1})." values={[CTRL_SPACE, <Kbd key="caps">{'Caps Lock'}</Kbd>]} />
    </Alert>
  );
}

function PhoneLearn({ view, close, home, back, leave, ...common }) {
  const last = useRef(null);
  if (view) last.current = view;
  // Back (and Escape) on Earlier chats returns to the chat it was opened from, a series to the coach (`leaveView` of Learn); others to the home.
  return (
    <>
      <Dialog id="h5-learn" open fullScreen onClose={close} aria-labelledby="h5-learn-title" sx={PHONE_ROOT} slotProps={{ paper: { className: 'h5-learn-page', sx: PAPER } }}>
        <AppBar position="static" color="default" enableColorOnDark elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
          <Toolbar disableGutters sx={{ minHeight: 56, px: 0.5, gap: 0.5 }}>
            <IconButton id="h5-learn-close" onClick={close} {...named(t('Back'))}><Icon name="back" size={22} /></IconButton>
            <Typography id="h5-learn-title" variant="h6" component="h1" noWrap sx={{ flex: '1 1 auto', minWidth: 0 }}>{t('Learn English')}</Typography>
          </Toolbar>
        </AppBar>
        <Box className="h5-learn-home" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, '& > *': { flexShrink: 0 } }}>{home}</Box>
      </Dialog>
      <Dialog id="h5-learn-mode" open={Boolean(view)} fullScreen onClose={leave} aria-labelledby="h5-learn-view-title" sx={PHONE_ROOT}
        slots={{ transition: Slide }} slotProps={{ transition: { direction: 'left', onExited: () => { last.current = null; } }, paper: { className: 'h5-learn-mode-page', sx: PAPER } }}>
        {last.current ? <ViewBody key={last.current.seq} view={last.current} back={back} {...common} /> : null}
      </Dialog>
    </>
  );
}

function ViewBody({ view, phone, back, open, data, seriesLeave, ...common }) {
  // A report opened from the Mistakes page (or the list of reports) goes back there (`parent`); every other view back to the home.
  const frame = title => ({ phone, title, onBack: view.parent ? () => open(view.parent) : back });
  if (view.kind === 'session') {
    return <Session mode={view.mode} extra={view.extra || ''} preset={view.preset} phone={phone} onBack={back} onRestart={(mode, extra = '') => open({ kind: 'session', mode, extra })}
      onDone={data.reload} settings={data.settings} {...common} />;
  }
  if (view.kind === 'material') return <MaterialView frame={frame(t('Your material'))} ui={common.ui} source={view.source || ''} />;
  if (view.kind === 'series') {
    // The coach's practice series: back in the coach with the result when it ends or is left ("The practice series" in docs/design/learn-english-coach-page.md).
    const toCoach = result => open(result ? { kind: 'chat', result, planKind: view.planKind || '' } : { kind: 'chat' });
    return <SeriesSession series={view} phone={phone} leaveRef={seriesLeave} onEnd={toCoach} onDone={data.reload} settings={data.settings} {...common} />;
  }
  if (view.kind === 'settings') return <SettingsView frame={frame(t('Learn settings'))} ui={common.ui} data={data} openTranslator={common.openTranslator} open={open} focus={view.focus || ''} />;
  if (view.kind === 'mistakes') return <MistakesView frame={frame(t('Mistakes'))} ui={common.ui} open={open} openTranslator={common.openTranslator} />;
  if (view.kind === 'reports') return <ReportsView frame={frame(t('Mistake reports'))} ui={common.ui} open={open} />;
  if (view.kind === 'report') return <ReportView frame={frame(t('Mistake report'))} view={view} ui={common.ui} open={open} data={data} />;
  if (view.kind === 'chat') return <CoachView view={view} phone={phone} back={back} open={open} data={data} {...common} />;
  if (view.kind === 'oldchat') return <ChatView view={view} phone={phone} back={back} open={open} readOnly {...common} />;
  if (view.kind === 'chats') return <EarlierChats parent={view.parent} open={open} readOnly={Boolean(view.readOnly)} />;
  if (view.kind === 'progress') return <ProgressView frame={frame(t('Progress'))} />;
  return <HowView frame={frame(t('How learning works'))} />;
}

// The frame of a mode: on a phone an app bar (back arrow, title, "7 / 20 · from your translations") over the page that scrolls and the actions pinned
// at its bottom; on a computer a title row with the counter, the progress bar and a close button, then the content.
// `keyboard`: the page's own keyboard (useLearnKeys), under the page on a phone, at the bottom of the pane on a computer-sized touch screen.
// `action`: a text button at the right of the bar (Table of the Progress view).
// `lead`: a line above the content (the "Back to chat when done" chip of a practice series).
export function ViewFrame({ phone, title, counter = '', source = '', progress = null, onBack = null, footer = null, keyboard = null, action = null, lead = null, children }) {
  if (phone) {
    const subtitle = [counter, source].filter(Boolean).join(' · ');
    return (
      <>
        <AppBar position="static" color="default" enableColorOnDark elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
          <Toolbar disableGutters sx={{ minHeight: 56, px: 0.5, gap: 0.5 }}>
            <IconButton id="h5-learn-back" onClick={onBack} {...named(t('Back'))}><Icon name="back" size={22} /></IconButton>
            <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
              <Typography id="h5-learn-view-title" variant="subtitle1" component="h2" noWrap sx={{ fontWeight: 500, lineHeight: 1.3 }}>{title}</Typography>
              {subtitle ? <Typography variant="caption" component="p" color="text.secondary" noWrap className="h5-learn-subtitle">{subtitle}</Typography> : null}
            </Box>
            {action ? <Box sx={{ flexShrink: 0, mr: 1 }}>{action}</Box> : null}
          </Toolbar>
        </AppBar>
        <Box className="h5-learn-scroll" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>{lead}{children}</Box>
          {footer ? <Box className="h5-learn-footer" sx={{ mt: 'auto', position: 'sticky', bottom: 0, px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'background.default' }}>{footer}</Box> : null}
        </Box>
        {keyboard}
      </>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minHeight: 40 }}>
        <Typography id="h5-learn-view-title" variant="h6" component="h2" noWrap sx={{ flex: '1 1 auto', minWidth: 0 }}>{title}</Typography>
        {counter ? <Typography variant="body2" color="text.secondary" className="h5-learn-subtitle">{counter}</Typography> : null}
        {action}
        {progress !== null ? <LinearProgress className="h5-learn-progress" variant="determinate" value={Math.round(progress * 100)} aria-label={t('Progress')} sx={{ width: 160, height: 6, borderRadius: 3 }} /> : null}
        {onBack ? <IconButton id="h5-learn-back" size="small" onClick={onBack} {...named(t('Close'))}><Icon name="close" size={20} /></IconButton> : null}
      </Box>
      {lead}
      {children}
      {keyboard}
    </Box>
  );
}

// ── Home ──

// On a company computer whose home (the normal machine that keeps the learning data) cannot be reached ("Company computer" in
// docs/design/learn-english.md): `device` of GET /api/learn/summary says `cache_only` and not `home_online`. The answers wait here and move over by
// themselves once the home is back, so the page only says so; with the home online nothing is shown.
const homeAway = summary => Boolean(summary && summary.device && summary.device.cache_only === true && summary.device.home_online === false);
function HomeAway({ device }) {
  const name = device.home_name;
  return (
    <Alert severity="info" id="h5-learn-home-away">
      {name ? <Fmt template="{1} can't be reached. Your answers are kept on this computer for now and moved to {1} when it is back." values={[name]} />
        : t("Your other computer can't be reached. Your answers are kept on this computer for now and moved there when it is back.")}
    </Alert>
  );
}

function Home({ ui, phone, data, modes, current, open }) {
  const { summary, error, reload, settings, setSettings } = data;
  const [busy, setBusy] = useState(false);
  const chats = useChatCount(summary);
  // With the coach there is one conversation: the card has no count of chats.
  const coach = useCoachSupport();
  if (error && !summary) {
    return <Alert severity="error" id="h5-learn-error" action={<Button color="inherit" size="small" onClick={() => reload()}>{t('Retry')}</Button>}>{error}</Alert>;
  }
  if (!summary) return <Typography id="h5-learn-loading" variant="body2" color="text.secondary">{t('Loading…')}</Typography>;
  const words = Number(summary.words) || 0;
  const sentences = Number(summary.sentences) || 0;
  const due = Number(summary.due) || 0;
  const done = Number(summary.done_today) || 0;
  const goal = Number(summary.goal) || Number(settings && settings.daily_goal) || 20;
  const streak = Number(summary.streak) || 0;
  const mistakes = Number(summary.mistakes) || 0;
  const addStarter = async () => {
    setBusy(true);
    try {
      const result = await api('POST', '/api/learn/starter', { list: 'dev' });
      const next = await api('PUT', '/api/learn/settings', { starter: 'dev' }).catch(() => null);
      if (next) setSettings(next);
      ui.notify(tf('Added {1} words', (result && result.added) || 0), 'success');
      await reload();
    } catch (failure) {
      ui.notify(errorText(failure), 'error');
    } finally {
      setBusy(false);
    }
  };
  const countOf = mode => (mode.kind === 'word' ? count(words, 'word', 'words') : count(sentences, 'sentence', 'sentences'));
  const away = homeAway(summary);
  return (
    <>
      {away ? <HomeAway device={summary.device} /> : null}
      {!words && !sentences ? (
        <Card id="h5-learn-empty" sx={{ p: 2 }}>
          <Typography variant="h6" component="h2">{t('No study cards yet')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('Sentences you send with "Chinese → English" and words you look up by tapping in the chat will appear here.')}</Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
            <Button variant="contained" id="h5-learn-add-starter" disabled={busy} onClick={addStarter}>{t('Add the starter list')}</Button>
            <Button id="h5-learn-how-empty" onClick={() => open({ kind: 'how' })}>{t('How learning works')}</Button>
          </Box>
        </Card>
      ) : (
        <Card id="h5-learn-today" sx={{ p: 2 }}>
          {due > 0 ? (
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="h4" component="p" id="h5-learn-due" sx={{ fontWeight: 500 }}>{due}</Typography>
              <Typography variant="body2" color="text.secondary" id="h5-learn-estimate">
                <Fmt template={due === 1 ? 'card due today · about {1} min' : 'cards due today · about {1} min'} values={[minutesFor(due)]} />
              </Typography>
            </Box>
          ) : <Typography variant="h6" component="p" id="h5-learn-due">{t('Nothing due today')}</Typography>}
          <NewWordsLine summary={summary} />
          <LinearProgress id="h5-learn-goal" variant="determinate" value={Math.round(goalProgress(done, goal) * 100)} aria-label={tf('{1} of {2} done', done, goal)} sx={{ height: 6, borderRadius: 3, my: 1.5 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" color="text.secondary" id="h5-learn-streak" sx={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
              <Box component="span" sx={{ color: 'warning.main', display: 'inline-flex' }}><Icon name="learnStreak" size={16} /></Box>
              <span><Fmt template={streak === 1 ? '1-day streak · {2} of {3} done' : '{1}-day streak · {2} of {3} done'} values={[streak, done, goal]} /></span>
            </Typography>
            {due > 0
              ? <Button variant="contained" id="h5-learn-start" onClick={() => open({ kind: 'session', mode: 'review' })}>{t('Start review')}</Button>
              : <Button variant="outlined" id="h5-learn-free" onClick={() => open({ kind: 'session', mode: 'mixed' })}>{t('Practise anyway')}</Button>}
          </Box>
          {/* Progress: the charts of the answers, the memory and what is due ("Progress" in docs/design/learn-english-page.md). */}
          <Button id="h5-learn-progress" startIcon={<Icon name="learnChart" size={18} />} onClick={() => open({ kind: 'progress' })}
            aria-current={current === 'progress' ? 'page' : undefined} sx={{ mt: 1, ml: -1 }}>{t('Progress')}</Button>
        </Card>
      )}
      {summary.new_report && summary.new_report.uid ? <NewReportLine report={summary.new_report} onView={() => open({ kind: 'report', uid: summary.new_report.uid })} /> : null}
      {away && summary.device.offline_copy_at && summary.device.home_name ? (
        <Typography id="h5-learn-offline-counts" variant="caption" component="p" color="text.secondary" sx={{ m: 0 }}>
          <Fmt template="The counts are those of the last copy from {1} plus what you answered here." values={[summary.device.home_name]} />
        </Typography>
      ) : null}
      <Typography variant="overline" component="h2" color="text.secondary" sx={{ mt: 0.5, lineHeight: 2 }}>{t('Practice')}</Typography>
      {modes.map(mode => (
        <ModeCard key={mode.id} id={`h5-learn-mode-${mode.id}`} icon={mode.icon} title={t(mode.label)} note={t(mode.note)} count={countOf(mode)}
          selected={current === mode.id} onClick={() => open({ kind: 'session', mode: mode.id })} />
      ))}
      <ModeCard id="h5-learn-mode-mistakes" icon="learnMistakes" title={t('Mistakes')} note={t('Words and sentences you got wrong')}
        count={count(mistakes, 'card', 'cards')} selected={current === 'mistakes' || current === 'report' || current === 'reports'} onClick={() => open({ kind: 'mistakes' })} />
      <Typography variant="overline" component="h2" color="text.secondary" sx={{ mt: 0.5, lineHeight: 2 }}>{t('Ask')}</Typography>
      <ModeCard id="h5-learn-mode-chat" icon="learnAsk" title={t('English chat')}
        note={coach ? t('Your coach: practice, your progress and any English question') : t('Ask anything about English: words, grammar, how to say something')}
        count={coach || chats === null ? '' : count(chats, 'chat', 'chats')} selected={current === 'chat' || current === 'chats'} onClick={() => open({ kind: 'chat' })} />
      <Typography variant="overline" component="h2" color="text.secondary" sx={{ mt: 0.5, lineHeight: 2 }}>{t('Your material')}</Typography>
      <Card sx={theme => (current === 'material' ? { bgcolor: alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity) } : {})}>
        <CardActionArea id="h5-learn-material" onClick={() => open({ kind: 'material' })} sx={{ p: 2 }}>
          <Typography variant="body1" component="span" sx={{ display: 'block' }}>
            {t('From your translations')} <Box component="span" sx={{ color: 'text.secondary' }}>{'· '}<Fmt template="{1} sentences, {2} words" values={[sentences, words]} /></Box>
          </Typography>
          <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {summary.collecting === false ? t('Collecting is off: new sentences and words are not saved.') : t('Every message you send with "Chinese → English" can be saved as a study card. Words you look up by tapping are added too.')}
          </Typography>
        </CardActionArea>
      </Card>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', pb: phone ? 1 : 0 }}>
        <Button id="h5-learn-settings" startIcon={<Icon name="setting" size={18} />} onClick={() => open({ kind: 'settings' })}>{t('Learn settings')}</Button>
        <Button id="h5-learn-how" startIcon={<Icon name="learnHow" size={18} />} onClick={() => open({ kind: 'how' })}>{t('How learning works')}</Button>
      </Box>
    </>
  );
}

// The new words of today under the due count ("New words a day" in docs/design/learn-english-page.md): `new_left`, `new_today` and `new_per_day` of
// the summary. Today's count is what was learned plus what is left, so 5 more new words raise it too. An older server sends none: no line.
function NewWordsLine({ summary }) {
  if (typeof summary.new_left !== 'number' || typeof summary.new_today !== 'number') return null;
  const left = Math.max(0, summary.new_left);
  const learned = Math.max(0, summary.new_today);
  return (
    <Typography variant="body2" color="text.secondary" id="h5-learn-new-words" sx={{ mt: 0.5 }}>
      {left > 0 ? (
        <>
          <Box component="span" sx={{ color: 'text.primary' }}><Fmt template={left === 1 ? '1 new word left today' : '{1} new words left today'} values={[left]} /></Box>
          {' · '}<Fmt template="{1} of {2} learned" values={[learned, learned + left]} />
        </>
      ) : <Fmt template="Today's {1} new words are learned" values={[learned]} />}
    </Typography>
  );
}

// The count of English chats on the home: `chats` of the summary when the server sends it, else read from GET /api/learn/chats when the home opens
// (null while unknown or on a failure: the card shows no count).
function useChatCount(summary) {
  const given = summary && typeof summary.chats === 'number' ? summary.chats : null;
  const [read, setRead] = useState(null);
  // Read again with each new summary (the home reloads it when a view closes).
  useEffect(() => {
    if (!summary || given !== null) return undefined;
    let live = true;
    api('GET', '/api/learn/chats').then(result => { if (live) setRead(Array.isArray(result && result.chats) ? result.chats.length : null); }, () => {});
    return () => { live = false; };
  }, [summary, given]);
  return given !== null ? given : read;
}

function ModeCard({ id, icon, title, note, count, selected, onClick }) {
  return (
    <Card className="h5-learn-mode" sx={theme => (selected ? { bgcolor: alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity) } : {})}>
      <CardActionArea id={id} onClick={onClick} aria-current={selected ? 'true' : undefined} sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 1.75 }}>
        <Box aria-hidden="true" sx={theme => ({ flex: '0 0 40px', height: 40, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.14) })}>
          <Icon name={icon} size={22} />
        </Box>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography variant="subtitle1" component="span" sx={{ display: 'block', fontWeight: 500, lineHeight: 1.3 }}>{title}</Typography>
          <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block' }}>{note}</Typography>
        </Box>
        <Typography variant="body2" component="span" color="text.secondary" className="h5-learn-count" sx={{ flexShrink: 0 }}>{count}</Typography>
      </CardActionArea>
    </Card>
  );
}

// ── A practice session ──

const TITLES = { review: 'Daily review', mistakes: 'Mistakes', mixed: 'Practice' };
const titleOf = mode => t(TITLES[mode] || (modeOf(mode) || {}).label || 'Practice');
const EMPTY = {
  review: ['Nothing due today', 'Every card you have is done for today. Practise anyway, or come back tomorrow.'],
  mixed: ['No study cards yet', 'Sentences you send with "Chinese → English" and words you look up by tapping in the chat will appear here.'],
  spell: ['No words yet', 'Words you look up by tapping in the chat become word cards. You can also add the starter list in Learn settings.'],
  mistakes: ['No mistakes to review', 'Words and sentences you get wrong show up here.'],
  sentence: ['No sentences yet', 'Messages you send with "Chinese → English" become sentence cards.'],
};

// `extra`: 'practice' asks for cards that are not due (words already learned) on top of the due ones; without it a queue has the due cards and the
// new words up to today's count, and nothing more ("Done for today" in docs/design/learn-english-page.md). Practice (mixed) always asks for it.
async function loadQueue(mode, extra = '') {
  if (mode === 'mixed') {
    const [words, sentences] = await Promise.all([api('GET', '/api/learn/queue?mode=spell&limit=10&extra=practice'), api('GET', `/api/learn/queue?mode=${SENTENCE_EXERCISE}&limit=10&extra=practice`)]);
    return mixCards([words && words.cards, sentences && sentences.cards], 20);
  }
  const limit = (modeOf(mode) || { limit: 20 }).limit;
  const data = await api('GET', `/api/learn/queue?mode=${encodeURIComponent(mode)}&limit=${limit}${extra ? `&extra=${encodeURIComponent(extra)}` : ''}`);
  return (data && Array.isArray(data.cards) ? data.cards : []).filter(card => card && !card.suspended);
}
// The modes whose empty queue can mean "done for today" (due words reviewed, today's new words learned) rather than "nothing at all".
const PACED = new Set(['spell', 'review', 'mixed']);
// The break note of Round done: after this many minutes of study today.
const BREAK_MINUTES = 20;

// The keys of a computer (exerciseKey): Enter checks, Enter again takes the offered grade, 1 / 2 / 3 grade a checked answer.
function useExerciseKeys(register) {
  useEffect(() => {
    const onKey = event => {
      // A key an input method takes (Safari's Enter that commits a composition has keyCode 229 and no isComposing) is never a grade.
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !register.current) return;
      const target = event.target || document.body;
      // Keys typed in "Ask about this question" are its own; while the phone's sheet is open the card's keys are off.
      if ((target.closest && target.closest('.h5-learn-ask')) || document.querySelector('#h5-learn-ask[data-layout="sheet"]')) return;
      const tag = target.tagName;
      if (event.key === 'Enter' && (tag === 'BUTTON' || tag === 'A')) return; // the focused button answers Enter itself
      if (event.key === 'Enter' && tag === 'TEXTAREA' && event.shiftKey) return;
      if (target !== document.body && !(target.closest && target.closest('#h5-learn, #h5-learn-mode'))) return;
      const inField = (tag === 'INPUT' || tag === 'TEXTAREA') && !target.readOnly;
      // The "Type it yourself" row takes letters only: Enter and 1 / 2 / 3 still grade there.
      const practice = Boolean(target.dataset && target.dataset.practice === 'true');
      const action = exerciseKey({ key: event.key, checked: register.current.checked, inField, practice, modifiers: event.altKey || event.ctrlKey || event.metaKey });
      if (!action) return;
      event.preventDefault();
      if (action.action === 'check') register.current.check(); else register.current.grade(action.grade);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

function Session({ mode, extra = '', preset, phone, keys, speech, ui, onBack, onRestart, onDone, openTranslator, settings }) {
  const audio = useAudio(settings, speech.tts);
  const [cards, setCards] = useState(preset || null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  // The answers of this round, for Round done: { id, en, correct, near, leech, answer }.
  const [round, setRound] = useState([]);
  // The summary read when the queue comes back empty (is it done for today?) or when the round ends (the minutes of today).
  const [summary, setSummary] = useState(null);
  const [loads, setLoads] = useState(0);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const register = useRef(null);
  useEffect(() => {
    if (preset && !loads) return undefined;
    let live = true;
    loadQueue(mode, extra).then(async list => {
      // An empty queue waits for the summary, so "Done for today" is told apart from "nothing at all" before either is shown.
      const info = !list.length && PACED.has(mode) ? await api('GET', '/api/learn/summary').catch(() => null) : null;
      if (!live) return;
      setSummary(info);
      setCards(list);
      setIndex(0);
      setRound([]);
    }, failure => { if (live) setError(errorText(failure)); });
    return () => { live = false; };
  }, [mode, extra, preset, loads]);
  const finished = Boolean(cards) && cards.length > 0 && index >= cards.length;
  useEffect(() => {
    if (!finished) return;
    Promise.resolve(onDone()).then(data => { if (data && typeof data === 'object') setSummary(data); }, () => {});
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps -- once at the end
  useExerciseKeys(register);
  const card = cards && cards[index];
  const exercise = card ? exerciseFor(card, mode, speech) : null;
  const answer = async ({ grade, correct, answer: text, helped = false, gaveUp = false, near = false, detail = null }) => {
    if (busyRef.current || !card) return;
    busyRef.current = true;
    setBusy(true);
    const body = { mode: exercise, grade, correct: Boolean(correct), answer: String(text || '').slice(0, 500) };
    // A wrong answer keeps what was asked for, the first tag of the checker and whether help was used ("Mistakes" in learn-english-page.md).
    if (!correct) {
      body.expected = (detail && detail.expected) || card.en;
      body.tag = (detail && detail.tag) || mistakeTag({ mode: exercise, expected: card.en, answer: text, gaveUp });
      body.hinted = Boolean(helped && !gaveUp);
    }
    try {
      await api('POST', `/api/learn/cards/${encodeURIComponent(card.id)}/answer`, body);
      setRound(now => [...now, { id: card.id, en: (detail && detail.expected) || card.en, correct: Boolean(correct), near: Boolean(near && !correct), leech: Boolean(card.leech && exercise === 'spell'), answer: gaveUp ? '' : String(text || '') }]);
      register.current = null;
      setIndex(now => now + 1);
    } catch (failure) {
      ui.notify(errorText(failure), 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const skip = () => { register.current = null; setIndex(now => now + 1); };
  // 5 more new words: today's count of new words is raised on the server, then the queue is read again.
  const moreWords = async () => {
    setAdding(true);
    try {
      await api('POST', '/api/learn/new-words', { count: 5 });
      setCards(null);
      setSummary(null);
      setLoads(now => now + 1);
      void onDone();
    } catch (failure) {
      ui.notify(errorText(failure), 'error');
    } finally {
      setAdding(false);
    }
  };
  const total = cards ? cards.length : 0;
  const frame = {
    phone, title: titleOf(mode), onBack,
    counter: card ? `${index + 1} / ${total}` : '', source: card ? sourceLabel(card) : '', progress: card ? (index + 1) / total : null,
  };
  if (error) return <ViewFrame {...frame}><Alert severity="error" id="h5-learn-session-error">{error}</Alert></ViewFrame>;
  if (!cards) return <ViewFrame {...frame}><Typography variant="body2" color="text.secondary" id="h5-learn-session-loading">{t('Loading…')}</Typography></ViewFrame>;
  if (!cards.length) {
    // Done for today: the queue is empty while words exist and the server counts today's new words (an older server keeps the texts below).
    const paced = PACED.has(mode) && summary && typeof summary.new_left === 'number' && Number(summary.words) > 0;
    if (paced) {
      const learned = Math.max(0, Number(summary.new_today) || 0);
      return (
        <ViewFrame {...frame}>
          <Card id="h5-learn-session-empty" data-kind="done-today" sx={{ p: 2 }}>
            <Typography variant="h6" component="p">{t('Done for today')}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {learned > 0 ? <Fmt template="Every due word is reviewed and today's {1} new words are learned." values={[learned]} /> : t('Every due word is reviewed.')}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
              <Button variant="outlined" id="h5-learn-session-free" onClick={() => onRestart(mode, 'practice')}>{t('Practise anyway')}</Button>
              <Button id="h5-learn-more-words" disabled={adding} onClick={moreWords}>{t('5 more new words')}</Button>
            </Box>
          </Card>
        </ViewFrame>
      );
    }
    const [title, text] = EMPTY[mode] || (modeOf(mode) && modeOf(mode).kind === 'sentence' ? EMPTY.sentence : EMPTY.mixed);
    return (
      <ViewFrame {...frame}>
        <Card id="h5-learn-session-empty" sx={{ p: 2 }}>
          <Typography variant="h6" component="p">{t(title)}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t(text)}</Typography>
          {mode === 'review' ? <Button variant="outlined" id="h5-learn-session-free" sx={{ mt: 2 }} onClick={() => onRestart('mixed')}>{t('Practise anyway')}</Button> : null}
        </Card>
      </ViewFrame>
    );
  }
  if (finished) {
    return (
      <ViewFrame {...frame} progress={1}>
        <RoundDone round={round} minutes={summary && typeof summary.minutes_today === 'number' ? summary.minutes_today : null} onBack={onBack}
          onNext={() => onRestart(mode === 'mistakes' ? 'mixed' : mode, extra)} />
      </ViewFrame>
    );
  }
  const Exercise = EXERCISES[exercise];
  return (
    <Exercise key={`${card.id}-${index}-${loads}`} ui={ui} card={card} cards={cards} frame={frame} phone={phone} keys={keys} tts={speech.tts} busy={busy} register={register}
      onAnswer={answer} onSkip={skip} openTranslator={openTranslator} audio={audio} exercise={exercise} />
  );
}

// ── A practice series of the coach ("The practice series" in docs/design/learn-english-coach-page.md) ──
// The plan of POST /api/learn/coach/plans/start (`series.plan`) run step after step with the same exercises and the same answer endpoint as a session
// (learn-series.mjs decides the exercise of each card, the progress and the misses that come back at the end). The header: the exercise's title and
// "Step 2 of 4 · 7 / 9 · from your chat"; the back arrow leaves (the answers are kept) and the end returns by itself, both to the coach with the result.
const SERIES_TITLES = { spell: 'Spell the word', fill: 'Fill the gap', dictation: 'Dictation', retest: 'Final retest' };
function SeriesSession({ series, phone, keys, speech, ui, openTranslator, settings, leaveRef, onEnd, onDone }) {
  const audio = useAudio(settings, speech.tts);
  const [run, setRun] = useState(() => createSeries(series.plan, { tts: speech.tts }));
  const runRef = useRef(run);
  runRef.current = run;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const register = useRef(null);
  const ended = useRef(false);
  useExerciseKeys(register);
  const end = stopped => {
    if (ended.current) return;
    ended.current = true;
    const now = runRef.current;
    void onDone();
    // Nothing answered: nothing to tell her.
    onEnd(now.answers.length ? seriesResult(now, { messageUid: series.messageUid || '', stopped }) : null);
  };
  useEffect(() => {
    leaveRef.current = () => end(!seriesDone(runRef.current));
    return () => { leaveRef.current = null; };
  });
  const done = seriesDone(run);
  useEffect(() => { if (done) end(false); }, [done]); // eslint-disable-line react-hooks/exhaustive-deps -- once at the end
  const current = seriesCurrent(run);
  const card = current ? exerciseCard(current.card, current.exercise) : null;
  const answer = async ({ grade, correct, answer: text, helped = false, gaveUp = false, detail = null }) => {
    if (busyRef.current || !current) return;
    busyRef.current = true;
    setBusy(true);
    const body = { mode: current.exercise, grade, correct: Boolean(correct), answer: String(text || '').slice(0, 500) };
    if (!correct) {
      body.expected = (detail && detail.expected) || card.en;
      body.tag = (detail && detail.tag) || mistakeTag({ mode: current.exercise, expected: card.en, answer: text, gaveUp });
      body.hinted = Boolean(helped && !gaveUp);
    }
    try {
      await api('POST', `/api/learn/cards/${encodeURIComponent(current.card.id)}/answer`, body);
      register.current = null;
      setRun(now => seriesAnswer(now, { correct: Boolean(correct), answer: gaveUp ? '' : String(text || '') }));
    } catch (failure) {
      ui.notify(errorText(failure), 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const skip = () => { register.current = null; setRun(now => seriesAnswer(now, { skipped: true })); };
  const progress = seriesProgress(run);
  const where = progress.steps > 1 ? tf('Step {1} of {2} · {3} / {4}', progress.step, progress.steps, progress.at, progress.of) : `${progress.at} / ${progress.of}`;
  const frame = {
    phone, title: t(SERIES_TITLES[current ? current.mode : 'spell']), onBack: () => end(!seriesDone(runRef.current)), counter: `${where} · ${t('from your chat')}`, progress: progress.share,
    lead: (
      <Chip id="h5-learn-series-note" variant="outlined" color="primary" size="small" label={t('Back to chat when done')} sx={{ alignSelf: 'flex-start' }} />
    ),
  };
  if (!current) return <ViewFrame {...frame}><Typography variant="body2" color="text.secondary" id="h5-learn-series-ending">{t('Back to the chat…')}</Typography></ViewFrame>;
  const Exercise = EXERCISES[current.exercise];
  return (
    <Box id="h5-learn-series" data-step={current.mode} data-exercise={current.exercise} sx={{ display: 'contents' }}>
      <Exercise key={`${current.step}-${current.at}`} ui={ui} card={card} cards={[card]} frame={frame} phone={phone} keys={keys} tts={speech.tts} busy={busy} register={register}
        onAnswer={answer} onSkip={skip} openTranslator={openTranslator} audio={audio} exercise={current.exercise} />
    </Box>
  );
}

// Round done ("Round done" in docs/design/learn-english-page.md): the counts of the round (right, almost: one letter off, again: the rest), a thin bar
// with a segment per answer in those colours and its legend, the words answered wrong this round with what was written, and after BREAK_MINUTES of
// study today (`minutes_today` of the summary) a note to take a break.
const OUTCOMES = [['right', 'success.main'], ['almost', 'warning.main'], ['again', 'error.main']];
const outcomeOf = entry => (entry.correct ? 'right' : entry.near ? 'almost' : 'again');
function RoundDone({ round, minutes, onBack, onNext }) {
  const counts = { right: 0, almost: 0, again: 0 };
  for (const entry of round) counts[outcomeOf(entry)] += 1;
  const ordered = OUTCOMES.flatMap(([kind, color]) => Array.from({ length: counts[kind] }, () => [kind, color]));
  const wrong = round.filter(entry => !entry.correct);
  return (
    <>
      <Card id="h5-learn-done" sx={{ p: 2 }}>
        <Typography variant="h6" component="p">{t('Round done')}</Typography>
        <Typography variant="body2" color="text.secondary" id="h5-learn-done-counts" sx={{ mt: 0.5 }}>
          <Fmt template="{1} answered · {2} right · {3} almost" values={[round.length, counts.right, counts.almost]} />
        </Typography>
        {round.length ? (
          <>
            <Box id="h5-learn-done-bar" role="img" aria-label={tf('{1} right, {2} almost, {3} again', counts.right, counts.almost, counts.again)}
              sx={{ display: 'flex', gap: '2px', height: 6, mt: 1.5 }}>
              {ordered.map(([kind, color], at) => <Box key={at} data-kind={kind} sx={{ flex: '1 1 0', minWidth: 2, borderRadius: '1px', bgcolor: color }} />)}
            </Box>
            <Typography variant="caption" component="p" color="text.secondary" id="h5-learn-done-legend" aria-hidden="true" sx={{ mt: 0.5, display: 'flex', alignItems: 'center', columnGap: 0.5, flexWrap: 'wrap' }}>
              {OUTCOMES.map(([kind, color], at) => (
                <Box component="span" key={kind} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  {at ? <span>{'· '}</span> : null}
                  <Box component="span" sx={{ width: 8, height: 8, borderRadius: '1px', bgcolor: color }} />
                  {t(kind)}
                </Box>
              ))}
            </Typography>
          </>
        ) : null}
      </Card>
      {wrong.length ? (
        <Card id="h5-learn-work-on" sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
          <Typography variant="body2" color="text.secondary" component="h3">{t('Words to work on')}</Typography>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {wrong.map((entry, at) => {
              const status = entry.leech ? ['Keeps slipping', 'warning.main'] : entry.near ? ['Almost', 'warning.main'] : ['Again', 'error.main'];
              return (
                <Box component="li" key={`${entry.id}-${at}`} className="h5-learn-work-row" data-status={status[0]}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
                  <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                    <Typography variant="body1" translate="no" noWrap className="h5-learn-work-word">{entry.en}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap className="h5-learn-work-note">
                      {entry.leech ? t('Learned in parts') : entry.answer ? <Fmt template="You wrote {1}" values={[entry.answer]} /> : t("I don't know")}
                    </Typography>
                  </Box>
                  <Typography variant="caption" className="h5-learn-work-status" sx={{ color: status[1], flexShrink: 0 }}>{t(status[0])}</Typography>
                </Box>
              );
            })}
          </Box>
        </Card>
      ) : null}
      {minutes !== null && minutes >= BREAK_MINUTES ? (
        <Alert severity="info" id="h5-learn-break"><Fmt template="{1} min today. A short break now helps you remember more." values={[minutes]} /></Alert>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button variant="contained" id="h5-learn-finish" onClick={onBack}>{t('Back to Learn')}</Button>
        <Button id="h5-learn-again" onClick={onNext}>{t('Next round')}</Button>
      </Box>
    </>
  );
}
// A mode the browser cannot run, or a hidden one, falls back to Fill the gap (Build while it is shown): `exerciseFor` in learn-model.mjs.

// ── Shared parts of the exercises ──

const GRADES = [['again', 'Again', '1'], ['hard', 'Hard', '2'], ['good', 'Good', '3']];
// `next`: when each grade brings the card back (the queue card's `next` of the FSRS server, milliseconds), shown under each label in caption size
// ("Again · 10 min", "Grade intervals" in docs/design/learn-english-page.md); without it (an older server) the buttons are the plain labels.
// `focus`: the offered grade takes the focus (Spell gives it to its "Type it yourself" row instead; Enter there takes the offered grade).
function Grades({ suggested, onGrade, busy, keys, next = null, focus = true }) {
  const intervals = gradeIntervals(next);
  return (
    <Box className="h5-learn-grades" role="group" aria-label={t('How well did you know it?')}
      sx={{ display: 'flex', gap: 1, flexWrap: intervals ? 'nowrap' : 'wrap', ...(intervals ? { flex: '1 1 auto', minWidth: 0 } : {}) }}>
      {GRADES.map(([grade, label, key]) => {
        const when = intervals ? tf(intervals[grade][0], intervals[grade][1]) : '';
        return (
          <Button key={grade} id={`h5-learn-grade-${grade}`} data-grade={grade} variant={grade === suggested ? 'contained' : 'outlined'} autoFocus={focus && grade === suggested}
            disabled={busy} onClick={() => onGrade(grade)} aria-keyshortcuts={keys ? key : undefined} aria-label={intervals ? `${t(label)}, ${when}` : undefined}
            sx={intervals ? { flex: '1 1 0', minWidth: 0, maxWidth: 200, flexDirection: 'column', py: 0.5, lineHeight: 1.3 } : undefined}>
            <span>{t(label)}{keys ? <Box component="span" aria-hidden="true" sx={{ ml: 1, opacity: 0.7, typography: 'caption' }}>{key}</Box> : null}</span>
            {intervals ? <Box component="span" className="h5-learn-grade-when" sx={{ typography: 'caption', lineHeight: 1.3, opacity: 0.8, whiteSpace: 'nowrap' }}>{when}</Box> : null}
          </Button>
        );
      })}
    </Box>
  );
}

const DEL = theme => ({ color: theme.palette.error.light, bgcolor: alpha(theme.palette.error.main, 0.16), textDecoration: 'line-through', borderRadius: 0.5, px: 0.25 });
const INS = theme => ({ color: theme.palette.success.light, bgcolor: alpha(theme.palette.success.main, 0.16), textDecoration: 'none', borderRadius: 0.5, px: 0.25 });
// The word-by-word diff: the right sentence, with each wrong or extra word of the answer struck out and each missing or right one marked.
function DiffLine({ ops, sentence }) {
  const tail = (String(sentence || '').trim().match(/[.!?…]+$/) || [''])[0];
  return (
    <Typography variant="body1" component="p" translate="no" className="h5-learn-diff" sx={{ overflowWrap: 'break-word', lineHeight: 1.9 }}>
      {ops.map((op, index) => (
        <span key={index} data-op={op.type}>
          {index ? ' ' : ''}
          {op.type === 'same' ? op.expected : null}
          {op.type === 'wrong' || op.type === 'extra' ? <Box component="del" className="h5-learn-del" sx={DEL}>{op.answer}</Box> : null}
          {op.type === 'wrong' ? ' ' : null}
          {op.type === 'wrong' || op.type === 'missing' ? <Box component="ins" className="h5-learn-ins" sx={INS}>{op.expected}</Box> : null}
        </span>
      ))}
      {tail}
    </Typography>
  );
}
function Hints({ hints }) {
  return hints.map((hint, index) => {
    const [template, ...values] = hintText(hint);
    return <span key={index} className="h5-learn-hint">{' · '}<Fmt template={template} values={values} /></span>;
  });
}
// The title of a checked answer: Right, Almost (a typed word one letter off, in the warning colour: "Almost" in docs/design/learn-english-page.md) or
// Not quite. `right`: the word for a right answer (Spell's sentence layout says Correct).
function ResultTitle({ correct, near = false, right = 'Right', sx = null }) {
  const [text, color] = correct ? [right, 'success.light'] : near ? ['Almost', 'warning.main'] : ['Not quite', 'error.light'];
  return <Typography variant="body2" className="h5-learn-result-title" data-near={near && !correct ? 'true' : undefined} sx={{ color, fontWeight: 500, ...sx }}>{t(text)}</Typography>;
}
// The one-line note under a wrong typed word: the card's tip when it has one, else the known spelling pattern ("-sion, not -tion here"), shown only
// when the mistake matches a pattern (spellingPattern). The right part is in medium weight.
function PatternNote({ expected, answer, tip = '' }) {
  const pattern = spellingPattern(expected, answer);
  if (!pattern) return null;
  const tipText = String(tip || '').trim();
  return (
    <Box id="h5-learn-pattern" sx={theme => ({ mt: 1, px: 1.5, py: 1, borderRadius: 1, bgcolor: alpha(theme.palette.text.primary, 0.06) })}>
      <Typography variant="body2" translate={tipText ? 'no' : undefined}>
        {tipText || <Fmt template={pattern.template} values={pattern.values.map((value, at) => (at ? value : <Box component="strong" key={at} sx={{ fontWeight: 'fontWeightMedium' }}>{value}</Box>))} />}
      </Typography>
    </Box>
  );
}
// The result of a checked answer, with the grades on a computer (a phone has them in its pinned actions). `practice`: Spell's "Type it yourself"
// row, between the result (the status that is read out) and the grades. `focus`: the offered grade takes the focus.
function Feedback({ correct, near = false, phone, keys, busy, suggested, onGrade, next = null, practice = null, focus = true, children }) {
  return (
    <Card id="h5-learn-feedback" data-correct={correct ? 'true' : 'false'} data-near={near && !correct ? 'true' : undefined} sx={{ p: 2 }}>
      <Box role="status">
        <ResultTitle correct={correct} near={near} />
        <Box sx={{ mt: 0.75 }}>{children}</Box>
      </Box>
      {practice}
      {phone ? null : <Box sx={{ mt: 1.5, display: 'flex' }}><Grades suggested={suggested} onGrade={onGrade} busy={busy} keys={keys} next={next} focus={focus} /></Box>}
    </Card>
  );
}
function SentenceResult({ card, result }) {
  return (
    <>
      <DiffLine ops={result.ops} sentence={card.en} />
      <Typography variant="body2" color="text.secondary" className="h5-learn-summary" sx={{ mt: 0.5 }}>
        <Fmt template="Word by word: {1} of {2} right" values={[result.right, result.total]} /><Hints hints={result.hints} />
      </Typography>
    </>
  );
}
function Prompt({ label, badge = null, children, footer = null }) {
  const title = <Typography variant="body2" color="text.secondary">{label}</Typography>;
  return (
    <Card className="h5-learn-prompt" sx={{ p: 2 }}>
      {badge ? <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 1, flexWrap: 'wrap' }}>{title}{badge}</Box> : title}
      {children}
      {footer}
    </Card>
  );
}
// Where the Chinese of a sentence card came from: "From your message on 11-19 · SELF-TAGENT".
function Origin({ card }) {
  const date = shortDate(card.created_at);
  const context = String(card.context || '').trim();
  return (
    <Typography variant="caption" component="p" color="text.secondary" className="h5-learn-origin" sx={{ mt: 1 }}>
      {card.source === 'translation' && date ? <Fmt template="From your message on {1}" values={[date]} /> : sourceLabel(card)}
      {context ? <Box component="span" translate="no">{` · ${context}`}</Box> : null}
    </Typography>
  );
}
const ChineseText = ({ card, id }) => (
  <Typography variant="h5" component="p" lang="zh" translate="no" id={id} sx={{ mt: 0.75, overflowWrap: 'break-word' }}>{card.zh || '—'}</Typography>
);
// The actions under an answer: before Check the exercise's own buttons, after it the grades (on a phone, pinned at the bottom).
// `detail()`: what a wrong answer was asked for and its tag, when the exercise knows better than the card's text (Fill the gap).
function useChecked({ register, onAnswer, check, answerText, detail = null }) {
  const [result, setResult] = useState(null); // { correct, helped, ... }
  const suggested = result ? suggestedGrade({ correct: result.correct, helped: result.helped, near: result.near }) : null;
  const grade = choice => {
    if (!result) return;
    onAnswer({ grade: choice || suggested, correct: result.correct, answer: answerText(), helped: Boolean(result.helped), gaveUp: Boolean(result.gaveUp), near: Boolean(result.near), detail: detail && !result.correct ? detail() : null });
  };
  register.current = { checked: Boolean(result), check: () => { if (!result) check(setResult); }, grade };
  return { result, setResult, suggested, grade };
}
const fieldProps = { autoCapitalize: 'none', autoCorrect: 'off', autoComplete: 'off', spellCheck: false };
const focusOnStart = (ref, keys) => { if (keys && ref.current) ref.current.focus({ preventScroll: true }); };
const actionsRow = children => <Box className="h5-learn-actions" sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: '1 1 auto', flexWrap: 'wrap' }}>{children}</Box>;
// The buttons that play or help (Hear it, Play, Slow, Show first letter, Hint) never take the focus from the answer field, so the caret stays where it
// was: the press is cancelled (no focus moves, as with the terminal's keys) and, should a browser move the focus anyway, a pointer press gives it back
// to the field that had it. A button reached with Tab keeps its focus.
const keepFocus = field => ({
  onMouseDown: event => event.preventDefault(),
  onPointerDown: event => { event.currentTarget.dataset.field = document.activeElement === field.current ? '1' : ''; },
  onClickCapture: event => {
    const el = field.current;
    if (event.detail > 0 && el && event.currentTarget.dataset.field === '1' && document.activeElement !== el) el.focus({ preventScroll: true });
  },
});

// "Ask about this question" (LearnAsk.jsx): the text button Ask at the end of the card's button row (it keeps the field's focus like the other helper
// buttons) and the sheet or side panel it opens. `answer()`: the person's answer; `expected`: what is asked for when it is not the card's English
// (Fill the gap's word); `gap`: the card shows a sentence with a gap.
function useAsk({ card, exercise, result, answer, expected = '', gap = false, field, phone, keys, openTranslator }) {
  const [open, setOpen] = useState(false);
  const button = (
    <Button id="h5-learn-ask-open" startIcon={<Icon name="learnAsk" size={20} />} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open ? 'true' : 'false'} {...keepFocus(field)}
      sx={{ flexShrink: 0, ml: 'auto' }}>
      {t('Ask')}
    </Button>
  );
  const panel = <AskPanel open={open} onClose={() => setOpen(false)} phone={phone} card={card} exercise={exercise} result={result} answer={answer} expected={expected} gap={gap} field={field} keys={keys} openTranslator={openTranslator} />;
  return { button, panel, row: <Box className="h5-learn-ask-row" sx={{ display: 'flex', mt: 1, mr: -1 }}>{button}</Box> };
}

// ── Audio ("Audio" in docs/design/learn-english-page.md) ──
// One player per session (learn-audio.mjs): a card plays by itself as the Learn settings say (`autoPlays`), Hear it / Play plays again with the same
// repeat, typing skips the rest of the repeats (when "Stop when I start typing" is on), and leaving the card, answering or Stop cancels what is
// pending, so nothing of one card is heard over the next. A browser that refuses sound before the first tap shows "Tap to play" once per page load.
let tapToPlayShown = false;
function useAudio(settings, tts) {
  const options = audioOptions(settings);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ttsRef = useRef(tts);
  ttsRef.current = tts;
  const [state, setState] = useState({ playing: false, text: '', index: 0, total: 0, blocked: false });
  const player = useMemo(() => createPlayer({
    speakOnce, cancel: stopSpeaking, speaking: isSpeaking,
    onChange: next => { if (next.blocked) tapToPlayShown = true; setState(next); },
  }), []);
  useEffect(() => () => player.stop(), [player]);
  return useMemo(() => ({
    options, state,
    // `once`: a single reading (a word after its answer); `auto`: started by the page (only the first of those can show "Tap to play").
    play: (text, { once = false, slow, auto = false } = {}) => {
      if (!ttsRef.current) return;
      const current = optionsRef.current;
      player.play(text, { repeat: once ? 1 : current.repeat, pauseMs: current.pauseMs, slow: slow === undefined ? current.slow : slow, auto: auto && !tapToPlayShown });
    },
    stop: () => player.stop(),
    typed: () => { if (optionsRef.current.stopOnTyping) player.skipRest(); },
  }), [player, state, options.words, options.sentences, options.sentencesAt, options.repeat, options.pauseMs, options.slow, options.stopOnTyping]); // eslint-disable-line react-hooks/exhaustive-deps -- the options by value
}
// The plays of a card by itself: at the start (when it appears) and after the answer, as `autoPlays` says for the exercise.
function useCardAudio(audio, exercise, text, result) {
  const plays = autoPlays(exercise, audio.options);
  useEffect(() => {
    if (plays.includes('start')) audio.play(text, { auto: true });
    return () => audio.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per card (an exercise is drawn again for each card)
  const checked = Boolean(result);
  useEffect(() => {
    if (!checked) return;
    audio.stop();
    if (plays.includes('after')) audio.play(text, { once: exercise === 'spell' });
  }, [checked]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the answer is checked
}
// Hear it / Play: while this text plays, "Playing 1 of 2" with Stop; when the browser refused the first play, "Tap to play".
function AudioButton({ audio, text, phone, field, id = 'h5-learn-hear', label = 'Hear it', slow, onPress = null }) {
  const press = () => { if (onPress) onPress(); audio.play(text, slow === undefined ? {} : { slow }); };
  const { state } = audio;
  if (state.blocked && state.text === text) {
    return <Button id="h5-learn-tap-play" variant="outlined" startIcon={<Icon name="learnSound" size={20} />} onClick={press}>{t('Tap to play')}</Button>;
  }
  const playing = state.playing && state.text === text && slow === undefined;
  const name = playing ? tf('Playing {1} of {2}', state.index, state.total) : t(label);
  const stop = playing ? <Button id="h5-learn-stop" onClick={() => audio.stop()} {...keepFocus(field)}>{t('Stop')}</Button> : null;
  const sx = theme => (playing ? { bgcolor: alpha(theme.palette.primary.main, 0.12) } : {});
  if (phone) {
    return (
      <>
        <IconButton id={id} data-playing={playing ? 'true' : undefined} onClick={press} {...keepFocus(field)} {...named(name)} sx={theme => ({ color: 'primary.main', ...sx(theme) })}><Icon name="learnSound" size={22} /></IconButton>
        {stop}
      </>
    );
  }
  return (
    <>
      <Button id={id} data-playing={playing ? 'true' : undefined} startIcon={<Icon name="learnSound" size={20} />} onClick={press} {...keepFocus(field)} sx={sx}>{name}</Button>
      {stop}
    </>
  );
}
// The phonetic transcription of a word (IPA, American English), shown with the word; nothing when none is known.
function Phonetic({ text, id, sx }) {
  if (!text) return null;
  return <Typography component="span" variant="body2" color="text.secondary" translate="no" lang="en-US-fonipa" id={id} className="h5-learn-phonetic" sx={{ whiteSpace: 'nowrap', ...sx }}>{text}</Typography>;
}
// A word with its transcription after it on the same line when there is room.
// `children`: more on the same line (the meaning, in Spell's sentence layout).
function WordLine({ word, phonetic, variant = 'body1', className, sx, phoneticId, children = null }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', columnGap: 1, flexWrap: 'wrap', minWidth: 0 }}>
      <Typography variant={variant} component="p" translate="no" className={className} sx={{ overflowWrap: 'break-word', minWidth: 0, ...sx }}>{word}</Typography>
      <Phonetic text={phonetic} id={phoneticId} />
      {children}
    </Box>
  );
}
// The automatic check of Spell and Fill the gap: AUTO_CHECK_MS after the typed letters reach the word's length, so the last letter is seen; any
// change in that pause (Backspace) starts over, and a shorter answer waits for Check.
function useAutoCheck({ register, ready, value, result }) {
  useEffect(() => {
    if (result || !ready) return undefined;
    const timer = setTimeout(() => { if (register.current && !register.current.checked) register.current.check(); }, AUTO_CHECK_MS);
    return () => clearTimeout(timer);
  }, [ready, value, result, register]);
}

// ── The page's own keyboard (touch screen) ──
// On a touch screen without a hardware keyboard (`keys` false; a computer, or a hardware key seen, types as before) the answer fields of Spell, Fill the
// gap, Dictation and Build the sentence have inputmode="none", like the terminal's textarea, so the system keyboard never opens; T-Agent's keyboard
// (Osk.jsx `Keyboard`, the terminal's) sits at the bottom of the mode, where the system keyboard would be. Single words get the letters (a-z, Shift,
// Backspace, apostrophe, hyphen, Hide); sentences the terminal's full layout with Hide where Enter is (Check is right above it). It opens by itself
// when a card starts (not in Build, where the tiles come first: a tap on the answer opens it); Hide closes it, a tap on the field opens it again.
// A key edits the field at its caret through the exercise's own `change` (the same handling as typing) and the field keeps the focus. While it is
// open on a phone the bottom navigation steps aside (`state.learnKeys`, BottomNav.jsx) and the actions stay right above it.
const hideKey = () => ({ send: 'Hide', label: t('Hide'), span: 5, fn: true, col: 16, click: true });
const LETTER_ROWS = () => [chars('qwertyuiop'), chars('asdfghjkl', 2), [SHIFT, ...chars('zxcvbnm'), BACKSPACE],
  [{ ch: "'", aria: 'Apostrophe', span: 3, fn: true }, { ch: '-', aria: 'Hyphen', span: 3, fn: true }, hideKey()]];
const FULL_ROWS = layer => rowsFor(layer, hideKey());

function LearnKeys({ letters, onKey }) {
  return (
    <Box className="h5-learn-keys-bar" sx={{ flexShrink: 0, position: 'sticky', bottom: 0, zIndex: 1, bgcolor: 'background.paper', backgroundImage: overlay(1), borderTop: 1, borderColor: 'divider', pb: 'env(safe-area-inset-bottom)' }}>
      <Keyboard id="h5-learn-keys" aria-label={t('On-screen keyboard')} data-kind={letters ? 'letters' : 'full'} rows={letters ? LETTER_ROWS : FULL_ROWS} onKey={onKey} sx={{ pb: 1 }} />
    </Box>
  );
}

// `field`: the answer field's ref; `change(text)`: the exercise's change handling; `letters`: the letter keyboard; `atStart`: open when the card
// starts; `emptyBack`: Backspace in the empty field (Build takes the last tile back).
function useLearnKeys({ ui, keys, field, change, letters = false, atStart = true, emptyBack = null }) {
  const touch = !keys;
  const [open, setOpen] = useState(atStart);
  const shown = touch && open;
  useEffect(() => {
    if (!shown) return undefined;
    ui.set({ learnKeys: true });
    return () => ui.set({ learnKeys: false });
  }, [shown, ui]);
  // The caret after a key: put back once React has drawn the new value.
  const caret = useRef(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (caret.current === null || !el) return;
    const at = Math.min(caret.current, el.value.length);
    caret.current = null;
    if (document.activeElement === el) el.setSelectionRange(at, at);
  });
  const onKey = key => {
    if (key === 'Hide') { setOpen(false); return; }
    const el = field.current;
    if (!el || el.readOnly) return;
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    const text = el.value;
    // The "Type it yourself" field types only at its end (data-practice).
    const atEnd = el.dataset.practice === 'true';
    let start = atEnd ? text.length : el.selectionStart ?? text.length;
    const end = atEnd ? text.length : el.selectionEnd ?? start;
    if (key === 'Backspace') {
      if (start === end && !start) { if (!text && emptyBack) emptyBack(); return; }
      if (start === end) start -= 1;
      caret.current = start;
      change(text.slice(0, start) + text.slice(end));
      return;
    }
    const ch = key === 'Space' ? ' ' : key;
    if (ch.length !== 1) return;
    caret.current = start + 1;
    change(text.slice(0, start) + ch + text.slice(end));
  };
  return {
    touch,
    show: () => { if (touch) setOpen(true); },
    inputProps: touch ? { inputMode: 'none' } : null,
    node: shown ? <LearnKeys letters={letters} onKey={onKey} /> : null,
  };
}

// ── Spell the word ──

// The width a box has for its letter slots (slotLayout), measured again when it changes. `on`: the box is drawn.
function useRoom(ref, on = true) {
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return undefined;
    const measure = () => setRoom(el.clientWidth);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [on, ref]);
  return room;
}

// "Type it yourself" (learn-practice.mjs; "Type it yourself" in docs/design/learn-spell-practice.md): after a Spell answer, empty slots of the right
// word typed letter by letter; a wrong key shows in its slot in the error colour for PRACTICE_FLASH_MS and is not kept, the word typed in full counts
// a round and the row empties after PRACTICE_ROUND_MS. Not graded and never sent. The field is a hidden input over the slots, like the answer's:
// `field` and `change` also serve the page's keyboard (useLearnKeys) and the input method handling (useLatinInput).
function usePractice({ word, onIme }) {
  const [state, setState] = useState(() => practiceStart(word));
  const stateRef = useRef(state);
  const field = useRef(null);
  const before = useRef(''); // the field text the last change was taken from (while an input method composes, its letters, wrong ones too)
  const composing = useRef(false);
  const commit = next => { stateRef.current = next; setState(next); };
  const change = (text, { composing: now = false } = {}) => {
    const next = practiceChange(stateRef.current, before.current, text);
    composing.current = now;
    before.current = now ? text : practiceText(next);
    commit(next);
  };
  const latin = useLatinInput({ value: practiceText(state), change, onIme });
  useEffect(() => {
    if (!state.flash) return undefined;
    const timer = setTimeout(() => commit(practiceClearFlash(stateRef.current)), PRACTICE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [state.flash]);
  useEffect(() => {
    if (!state.done) return undefined;
    const timer = setTimeout(() => {
      if (!stateRef.current.done) return;
      const next = practiceNewRound(stateRef.current);
      if (!composing.current) before.current = practiceText(next);
      commit(next);
    }, PRACTICE_ROUND_MS);
    return () => clearTimeout(timer);
  }, [state.done, state.count]);
  return { state, field, change, latin };
}

// The row under the result: "TYPE IT YOURSELF" with the count at the right (read out politely), the slots, and the note under them ("Practice only,
// not graded", on a computer with the keys that grade; "Not that letter" after a wrong key; "Again? Just keep typing" after a round).
const PRACTICE_SLOT = {
  kept: { tone: 'success.light', line: 'success.light' },
  flash: { tone: 'error.light', line: 'error.light', tint: 'error' },
  caret: { line: 'primary.main' },
  empty: {},
  auto: { line: 'transparent' },
};
function PracticeRow({ practice, keys, suggested, kb, onFocus, onBlur }) {
  const { state, field, latin } = practice;
  const box = useRef(null);
  const room = useRoom(box);
  const [focused, setFocused] = useState(false);
  const layout = slotLayout(state.letters.length, room);
  const slots = practiceSlots(state);
  const rows = [];
  layout.rows.reduce((at, size) => { rows.push([at, size]); return at + size; }, 0);
  const done = state.note === 'again' || state.done;
  const grade = suggested ? t(GRADES.find(([id]) => id === suggested)[1]) : '';
  // One template for the computer's line (a template is matched against any text by the translation layer, so it stays specific).
  const note = state.note === 'wrong' ? t('Not that letter') : state.note === 'again' ? t('Again? Just keep typing') : keys && grade ? (
    <Fmt template="Practice only, not graded · {1} takes {2} · {3} {4} {5} grade" values={[<Kbd key="enter">Enter</Kbd>, grade, <Kbd key="1">1</Kbd>, <Kbd key="2">2</Kbd>, <Kbd key="3">3</Kbd>]} />
  ) : t('Practice only, not graded');
  const keepCaret = event => {
    const el = event.target;
    if (latin.composing) return;
    const end = el.value.length;
    if (el.selectionStart !== end || el.selectionEnd !== end) el.setSelectionRange(end, end);
  };
  return (
    <Box className="h5-learn-practice" role="group" aria-label={t('Type the word yourself')}
      onClick={() => { if (field.current) field.current.focus({ preventScroll: true }); kb.show(); }}
      sx={theme => ({ mt: 1.5, px: 1.5, py: 1, borderRadius: 1, bgcolor: alpha(theme.palette.text.primary, 0.05), cursor: 'text' })}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="overline" component="p" color="text.secondary" aria-hidden="true" sx={{ flex: '1 1 auto', lineHeight: 2 }}>{t('Type it yourself')}</Typography>
        <Typography variant="caption" id="h5-learn-practice-count" role="status" aria-live="polite" data-done={done ? 'true' : undefined}
          sx={{ color: done ? 'success.light' : 'text.secondary' }}>
          {state.count ? <Fmt template={state.count === 1 ? 'Typed right {1} time' : 'Typed right {1} times'} values={[state.count]} /> : null}
        </Typography>
      </Box>
      <Box ref={box} className="h5-learn-practice-letters" translate="no" data-rows={layout.rows.length}
        sx={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', rowGap: 1, mt: 0.5 }}>
        {rows.map(([from, size]) => (
          <Box key={from} className="h5-learn-letter-row" sx={{ display: 'flex', flexWrap: 'nowrap', justifyContent: 'center', columnGap: `${layout.gap}px` }}>
            {slots.slice(from, from + size).map((slot, offset) => {
              const look = PRACTICE_SLOT[slot.kind];
              const line = slot.kind === 'caret' && !focused ? 'text.disabled' : look.line || 'text.disabled';
              return (
                <Box key={from + offset} className="h5-learn-practice-slot" data-kind={slot.kind} aria-hidden="true" sx={theme => ({
                  ...theme.typography.h5, fontSize: layout.font, width: layout.slot, height: layout.height, flex: '0 0 auto', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontFamily: MONO, color: look.tone || 'text.primary', borderBottom: 2, borderBottomStyle: 'solid', borderColor: line,
                  borderRadius: '4px 4px 0 0', bgcolor: look.tint ? alpha(theme.palette[look.tint].main, 0.16) : 'transparent',
                })}>{slot.ch}</Box>
              );
            })}
          </Box>
        ))}
        <InputBase inputRef={field} value={latin.value}
          onFocus={() => { setFocused(true); onFocus(); }} onBlur={() => { setFocused(false); onBlur(); }} onChange={latin.onChange}
          inputProps={{ id: 'h5-learn-practice-input', 'aria-label': t('Type the word yourself'), 'data-practice': 'true', 'aria-describedby': 'h5-learn-practice-note',
            onSelect: keepCaret, onKeyUp: keepCaret, onClick: keepCaret, ...fieldProps, ...latin.props, ...kb.inputProps }}
          sx={{ position: 'absolute', inset: 0, opacity: 0, '& input': { height: '100%', cursor: 'text', p: 0 } }} />
      </Box>
      <Typography variant="caption" component="p" align="center" id="h5-learn-practice-note" data-note={state.note}
        sx={{ mt: 0.5, color: state.note === 'wrong' ? 'error.light' : 'text.secondary' }}>
        {note}
      </Typography>
    </Box>
  );
}

// The meaning of a word card: its own, else looked up once (POST /api/learn/meaning). `state`: ok, loading, none or no-translator.
function useMeaning(card, word) {
  const [meaning, setMeaning] = useState({ zh: card.zh || '', phonetic: card.phonetic || '', state: card.zh ? 'ok' : 'loading' });
  useEffect(() => {
    if (card.zh) return undefined;
    let live = true;
    api('POST', '/api/learn/meaning', { word }).then(
      data => { if (live) setMeaning({ zh: (data && data.zh) || '', phonetic: card.phonetic || (data && data.phonetic) || '', state: data && data.zh ? 'ok' : 'none' }); },
      failure => { if (live) setMeaning({ zh: '', phonetic: card.phonetic || '', state: failure && failure.status === 503 ? 'no-translator' : 'none' }); },
    );
    return () => { live = false; };
  }, [card]); // eslint-disable-line react-hooks/exhaustive-deps -- one card
  return meaning;
}

// A word that keeps slipping (`leech` of the queue card) is learned in parts; any other word is spelled letter by letter.
function SpellOrParts(props) {
  return props.card.leech ? <PartsExercise {...props} /> : <SpellExercise {...props} />;
}

function SpellExercise({ ui, card, frame, phone, keys, tts, busy, register, onAnswer, openTranslator, audio, exercise }) {
  const word = String(card.en || '').trim();
  const [value, setValue] = useState('');
  const [helped, setHelped] = useState(false);
  const [focused, setFocused] = useState(false);
  const meaning = useMeaning(card, word);
  const input = useRef(null);
  useEffect(() => { focusOnStart(input, true); }, [card]); // on a touch screen too: the page's keyboard types into it (no system keyboard)
  const { result, setResult, suggested, grade } = useChecked({
    register, onAnswer, answerText: () => value,
    check: set => { if (!value.trim()) return; const check = spellCheck(word, value); set({ ...check, correct: check.ok, helped, near: !check.ok && nearMiss(word, value) }); },
  });
  // A word asked inside its sentence (the sentence layout below) is heard in that whole sentence, at the start, after Check and on Hear it; any
  // other word card plays the word. See "Spell the word" in docs/design/learn-english-page.md.
  const cloze = sentenceGap(card);
  const spoken = cloze ? `${cloze.before}${cloze.word}${cloze.after}` : word;
  useCardAudio(audio, exercise, spoken, result);
  useAutoCheck({ register, ready: typedInFull(value, word), value, result });
  const change = next => { if (!result) { audio.typed(); setValue(next.replace(/\s+/g, '').slice(0, word.length)); } };
  // English letters even with an input method on (useLatinInput), and in the Mac app an English input source while the field has the focus.
  const learnInput = useContext(LearnInput);
  const latin = useLatinInput({ value, change, onIme: learnInput.seen });
  // "Type it yourself" under the result: it takes the focus at once, and the page's keyboard types into it once the answer is checked.
  const practice = usePractice({ word, onIme: learnInput.seen });
  const checked = Boolean(result);
  const kb = useLearnKeys({ ui, keys, field: checked ? practice.field : input, change: checked ? practice.change : change, letters: true });
  useEffect(() => {
    const el = practice.field.current;
    if (!checked || !el) return;
    el.focus({ preventScroll: true });
    // Into sight once its slots are measured and drawn: on a phone above the pinned grades (scrollIntoView does not know the sticky footer).
    const row = el.closest('.h5-learn-practice');
    requestAnimationFrame(() => {
      const scroller = row && row.isConnected && row.closest('.h5-learn-scroll, .h5-learn-pane');
      if (!scroller) return;
      const footer = scroller.querySelector('.h5-learn-footer');
      const box = row.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const bottom = view.bottom - (footer ? footer.offsetHeight : 0) - 8;
      if (box.bottom > bottom) scroller.scrollTop += box.bottom - bottom;
      else if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
    });
  }, [checked]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the answer is checked
  const ask = useAsk({ card, exercise, result, answer: () => value, gap: Boolean(cloze), field: input, phone, keys, openTranslator });
  const giveUp = () => { if (!result) setResult({ ...spellCheck(word, value), ok: false, correct: false, helped: true, gaveUp: true }); };
  const showFirst = () => { setHelped(true); setValue(now => (now ? now : word.slice(0, 1))); if (input.current) input.current.focus({ preventScroll: true }); };
  // A word from the person's translations is asked inside its sentence (sentenceGap: the card has the Chinese of the sentence and the word is in it):
  // the sentence with a gap, its Chinese, then the word's meaning; after Check the word fills the gap. Any other card keeps the meaning first, with its
  // context as a hint ("Used in"). See "Spell the word" in docs/design/learn-english-page.md.
  const context = cloze ? '' : maskedContext(card);
  // The letter slots on one line (slotLayout): the width of the box is measured, and the slots shrink together for a long word.
  const letters = useRef(null);
  const room = useRoom(letters);
  // After a wrong answer (not "I don't know") the slots become two rows, the right spelling above what was typed, lined up letter by letter by the
  // closest match (alignSpelling), so the column count can exceed the word's length; a long word wraps the two rows as pairs. See "Spell the word" in
  // docs/design/learn-english-page.md.
  const aligned = result && !result.correct && !result.gaveUp ? alignSpelling(word, value) : null;
  // "N of M letters right" counts the letters the two rows agree on, so it says the same as the rows (one missing letter is 10 of 11, not 6).
  const rightLetters = aligned ? aligned.columns.filter(column => column.kind === 'same').length : result ? result.right : 0;
  const note = aligned ? spellingNote(aligned) : null;
  const layout = slotLayout(aligned ? aligned.columns.length : word.length, room);
  const rows = [];
  layout.rows.reduce((at, size) => { rows.push([at, size]); return at + size; }, 0);
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} next={card.next} focus={false} /> : actionsRow(<>
    <Button id="h5-learn-dont-know" onClick={giveUp}>{t("I don't know")}</Button>
    <Box sx={{ flex: '1 1 auto' }} />
    <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  const cell = ({ key, shown, tone, line = 'text.disabled', dashed = false, className = '', kind }) => (
    <Box key={key} className={`h5-learn-letter${className ? ` ${className}` : ''}`} data-kind={kind} aria-hidden="true" sx={theme => ({
      ...theme.typography.h5, fontSize: layout.font, width: layout.slot, height: layout.height, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: tone, borderBottom: 2, borderBottomStyle: dashed ? 'dashed' : 'solid', borderColor: line,
    })}>{shown}</Box>
  );
  const slot = at => {
    const char = word[at];
    const shown = result && result.gaveUp ? char : value[at] || '';
    const tone = !result ? 'text.primary' : result.gaveUp ? 'primary.main' : result.letters[at].ok ? 'success.light' : 'error.light';
    const caret = !result && focused && at === Math.min(value.length, word.length - 1);
    return cell({ key: at, shown, tone, line: caret ? 'primary.main' : 'text.disabled' });
  };
  // The two rows of a wrong answer. Top: an agreeing letter in the text colour over a quiet line, a differing (or missing) one in green over a green
  // line, an empty dashed slot over an extra letter. Bottom: right letters green, wrong and extra ones red, a missing letter an empty red dashed slot.
  const WANT = { same: { tone: 'text.primary' }, wrong: { tone: 'success.light', line: 'success.light' }, missing: { tone: 'success.light', line: 'success.light' }, extra: { dashed: true } };
  const GOT = { same: { tone: 'success.light' }, wrong: { tone: 'error.light' }, extra: { tone: 'error.light' }, missing: { line: 'error.light', dashed: true } };
  const pairRow = (from, size, side) => (
    <Box className={`h5-learn-letter-row h5-learn-letter-row-${side}`} sx={{ display: 'flex', flexWrap: 'nowrap', justifyContent: 'center', columnGap: `${layout.gap}px` }}>
      {aligned.columns.slice(from, from + size).map((column, offset) => cell({
        key: from + offset, shown: column[side], kind: column.kind, className: `h5-learn-letter-${side}`, ...(side === 'want' ? WANT : GOT)[column.kind],
      }))}
    </Box>
  );
  const helpers = (
    <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap', alignItems: 'center', ml: -1 }}>
      {tts ? <AudioButton audio={audio} text={spoken} field={input} /> : null}
      <Button id="h5-learn-first" disabled={Boolean(result) || Boolean(value)} onClick={showFirst} {...keepFocus(input)}>{t('Show first letter')}</Button>
      {ask.button}
    </Box>
  );
  const practiceRow = result && word ? (
    <PracticeRow practice={practice} keys={keys} suggested={suggested} kb={kb} onFocus={() => inputSource.focus()} onBlur={() => inputSource.blur()} />
  ) : null;
  const meaningState = <>
    {meaning.state === 'loading' ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{t('Looking up the meaning…')}</Typography> : null}
    {meaning.state === 'none' ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{tts ? t('No meaning found. Listen to the word instead.') : t('No meaning found for this word.')}</Typography> : null}
    {meaning.state === 'no-translator' ? <TranslatorNotice onOpen={openTranslator} sx={{ mt: 1 }} /> : null}
  </>;
  return (
    <ViewFrame {...frame} footer={phone ? actions : null} keyboard={kb.node}>
      {cloze ? (
        <Prompt label={t('Fill in the word')} badge={<Chip size="small" id="h5-learn-from-translation" label={t('your translation')} sx={CHIP_SX} />} footer={result ? ask.row : helpers}>
          <SentenceWithGap cloze={cloze} result={result} />
          <Typography variant="body2" color="text.secondary" component="p" lang="zh" translate="no" id="h5-learn-sentence-zh" sx={{ mt: 1, overflowWrap: 'break-word' }}>{cloze.zh}</Typography>
          <Divider sx={{ my: 1.5 }} />
          {result ? (
            <WordLine word={word} phonetic={meaning.phonetic} className="h5-learn-word" phoneticId="h5-learn-feedback-phonetic">
              {meaning.zh ? <Typography variant="body1" component="span" lang="zh" translate="no" id="h5-learn-meaning" sx={{ overflowWrap: 'break-word', minWidth: 0 }}>{meaning.zh}</Typography> : null}
            </WordLine>
          ) : meaning.zh ? (
            <Typography variant="body2" color="text.secondary" component="p" id="h5-learn-word-meaning" sx={{ overflowWrap: 'break-word' }}>
              {t('The word:')}{' '}<Box component="span" lang="zh" translate="no" id="h5-learn-meaning" sx={{ typography: 'body1', color: 'text.primary' }}>{meaning.zh}</Box>
            </Typography>
          ) : null}
          {result ? null : meaningState}
        </Prompt>
      ) : (
      <Prompt label={t('Meaning')} footer={helpers}>
        {meaning.zh ? <Typography variant="h5" component="p" lang="zh" translate="no" id="h5-learn-meaning" sx={{ mt: 0.75, overflowWrap: 'break-word' }}>{meaning.zh}</Typography> : null}
        {/* The transcription next to Hear it: the sound is offered there already, so it gives nothing more away. */}
        {tts && meaning.phonetic ? <Box sx={{ mt: 0.5 }}><Phonetic text={meaning.phonetic} id="h5-learn-phonetic" /></Box> : null}
        {meaningState}
        {context ? <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.75 }}><Fmt template={'Used in "{1}"'} values={[context]} /></Typography> : null}
      </Prompt>
      )}
      <Box>
        {learnInput.notice ? <ImeNotice onOk={learnInput.dismiss} field={checked ? practice.field : input} /> : null}
        <Box ref={letters} className="h5-learn-letters" translate="no" data-rows={layout.rows.length} onClick={() => { if (input.current) input.current.focus(); kb.show(); }}
          data-aligned={aligned ? 'true' : undefined}
          sx={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', rowGap: aligned ? 2 : 1, py: 1 }}>
          {rows.map(([from, size]) => (aligned ? (
            <Box key={from} className="h5-learn-letter-pair" sx={{ display: 'flex', flexDirection: 'column', rowGap: 0.5 }}>
              {pairRow(from, size, 'want')}
              {pairRow(from, size, 'got')}
            </Box>
          ) : (
            <Box key={from} className="h5-learn-letter-row" sx={{ display: 'flex', flexWrap: 'nowrap', justifyContent: 'center', columnGap: `${layout.gap}px` }}>
              {Array.from({ length: size }, (_, offset) => slot(from + offset))}
            </Box>
          )))}
          <InputBase inputRef={input} value={latin.value} onFocus={() => { setFocused(true); inputSource.focus(); }} onBlur={() => { setFocused(false); inputSource.blur(); }}
            onChange={latin.onChange}
            inputProps={{ id: 'h5-learn-spell-input', 'aria-label': t('Type the word'), maxLength: latin.composing ? undefined : word.length, readOnly: Boolean(result), ...fieldProps, ...latin.props, ...kb.inputProps }}
            sx={{ position: 'absolute', inset: 0, opacity: 0, '& input': { height: '100%', cursor: 'text', p: 0 } }} />
        </Box>
        {cloze && result ? (
          // The sentence layout says the result under the letters (the word is in the sentence already); a computer grades right under it.
          <Box id="h5-learn-feedback" data-correct={result.correct ? 'true' : 'false'} role="status" sx={{ mt: 1, textAlign: 'center' }}>
            <ResultTitle correct={result.correct} near={result.near} right="Correct" />
            {!result.correct && value ? <Typography variant="body2" color="text.secondary"><Fmt template="You wrote: {1}" values={[value]} /></Typography> : null}
            {!result.correct && !result.gaveUp ? <Typography variant="body2" color="text.secondary"><Fmt template="{1} of {2} letters right" values={[rightLetters, result.total]} /></Typography> : null}
            {!result.correct && !result.gaveUp ? <Box sx={{ textAlign: 'left' }}><PatternNote expected={word} answer={value} tip={card.tip} /></Box> : null}
          </Box>
        ) : note ? (
          <Typography variant="body2" color="text.secondary" align="center" id="h5-learn-spell-note" sx={{ mt: 1 }}>
            <Fmt template={note.template} values={note.values} />
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 1 }}>
            <Fmt template="{1} letters · type with the keyboard" values={[word.length]} />
          </Typography>
        )}
        {cloze ? practiceRow : null}
        {phone || (result && !cloze) ? null : <Box sx={{ mt: 2 }}>{actions}</Box>}
      </Box>
      {result && !cloze ? (
        <Feedback correct={result.correct} near={result.near} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade} next={card.next}
          practice={practiceRow} focus={false}>
          <WordLine word={word} phonetic={meaning.phonetic} variant="h6" className="h5-learn-word" sx={{ color: 'success.light' }} phoneticId="h5-learn-feedback-phonetic" />
          {!result.correct && value ? <Typography variant="body2" color="text.secondary"><Fmt template="You wrote: {1}" values={[value]} /></Typography> : null}
          {!result.gaveUp ? <Typography variant="body2" color="text.secondary"><Fmt template="{1} of {2} letters right" values={[rightLetters, result.total]} /></Typography> : null}
          {!result.correct && !result.gaveUp ? <PatternNote expected={word} answer={value} tip={card.tip} /> : null}
        </Feedback>
      ) : null}
      {ask.panel}
    </ViewFrame>
  );
}

// ── Keeps slipping: learn it in parts ("Keeps slipping" in docs/design/learn-english-page.md) ──
// A word missed again and again (`leech`, with `missed` times) gets two steps instead of the letter slots. Step 1, "Learn it in parts": the meaning, the
// word in its parts (the card's `parts` from the translator, else splitParts) in alternating colours, the transcription, Hear it and Slowly, the card's
// tip, and the word copied once (Next only when the copy matches). Step 2, "Now from memory": the word hidden, the meaning and the sound kept, the
// number of parts; Show parts and Hint count as help (Hard). Check grades step 2 like Spell (Right, Almost, Not quite); step 1 is never graded.
const WARN_CHIP_SX = theme => ({ height: 24, typography: 'caption', fontWeight: 'fontWeightMedium', color: 'warning.main', bgcolor: alpha(theme.palette.warning.main, 0.12), '& .MuiChip-label': { px: 1 } });
function SlippingChip({ card }) {
  const missed = Number(card.missed) || 0;
  return <Box><Chip id="h5-learn-slipping" size="small" label={missed > 0 ? tf('Keeps slipping · missed {1} times', missed) : t('Keeps slipping')} sx={WARN_CHIP_SX} /></Box>;
}
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
function PartsWord({ parts, word }) {
  return (
    <Typography variant="h4" component="p" translate="no" id="h5-learn-parts" aria-label={word} sx={theme => ({ ...theme.typography.h5, fontFamily: MONO, textAlign: 'center', my: 1.5 })}>
      {/* A long word wraps only between its parts. */}
      {parts.map((part, at) => (
        <span key={at} aria-hidden="true">
          {at ? <Box component="span" sx={{ color: 'text.secondary' }}>{'\u00b7'}</Box> : null}
          <Box component="span" className="h5-learn-part" sx={{ color: at % 2 ? 'primary.main' : 'text.primary', whiteSpace: 'nowrap' }}>{part}</Box>
        </span>
      ))}
    </Typography>
  );
}
function TipBox({ tip }) {
  const text = String(tip || '').trim();
  if (!text) return null;
  return (
    <Box id="h5-learn-tip" sx={theme => ({ mt: 1.5, px: 1.5, py: 1, borderRadius: 1, bgcolor: alpha(theme.palette.text.primary, 0.06) })}>
      <Typography variant="body2" translate="no">{text}</Typography>
    </Box>
  );
}

function PartsExercise({ ui, card, frame, phone, keys, tts, busy, register, onAnswer, openTranslator, audio, exercise }) {
  const word = String(card.en || '').trim();
  const parts = useMemo(() => partsOf(card), [card]);
  const meaning = useMeaning(card, word);
  const [step, setStep] = useState('copy'); // copy | recall
  const [copy, setCopy] = useState('');
  const [value, setValue] = useState('');
  const [helped, setHelped] = useState(false);
  const [shown, setShown] = useState(false);
  const input = useRef(null);
  useEffect(() => { focusOnStart(input, true); }, [step]);
  const copied = normWord(copy) === normWord(word);
  const { result, suggested, grade } = useChecked({
    register, onAnswer, answerText: () => value,
    check: set => {
      if (step === 'copy') { if (copied) setStep('recall'); return; }
      if (!value.trim()) return;
      const check = spellCheck(word, value);
      set({ ...check, correct: check.ok, helped, near: !check.ok && nearMiss(word, value) });
    },
  });
  useCardAudio(audio, exercise, word, result);
  useAutoCheck({ register, ready: step === 'recall' && typedInFull(value, word), value, result });
  const change = next => {
    if (result) return;
    audio.typed();
    if (step === 'copy') setCopy(next); else setValue(next);
  };
  const kb = useLearnKeys({ ui, keys, field: input, change, letters: true });
  const ask = useAsk({ card, exercise, result, answer: () => value, field: input, phone, keys, openTranslator });
  // Hint: the next part after those already typed right.
  const hint = () => {
    if (result) return;
    let typed = 0;
    while (typed < parts.length && value.toLowerCase().startsWith(parts.slice(0, typed + 1).join('').toLowerCase())) typed += 1;
    setHelped(true);
    setValue(parts.slice(0, Math.min(parts.length, typed + 1)).join(''));
    if (input.current) input.current.focus({ preventScroll: true });
  };
  const showParts = () => { setHelped(true); setShown(true); };
  const recall = step === 'recall';
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} next={card.next} /> : actionsRow(<>
    <Box sx={{ flex: '1 1 auto' }} />
    {recall ? <Button id="h5-learn-hint" onClick={hint} {...keepFocus(input)}>{t('Hint')}</Button> : null}
    {recall
      ? <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
      : <Button id="h5-learn-next" variant="contained" disabled={!copied} onClick={() => register.current.check()}>{t('Next step')}</Button>}
  </>);
  const audioRow = (
    <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap', alignItems: 'center', justifyContent: recall ? 'flex-start' : 'center', ml: recall ? -1 : 0 }}>
      {tts ? <AudioButton audio={audio} text={word} field={input} /> : null}
      {tts && !recall ? <AudioButton audio={audio} text={word} field={input} id="h5-learn-slow" label="Slowly" slow /> : null}
      {recall ? <Button id="h5-learn-show-parts" disabled={shown || Boolean(result)} onClick={showParts} {...keepFocus(input)}>{t('Show parts')}</Button> : null}
      {ask.button}
    </Box>
  );
  const meaningText = meaning.zh
    ? <Typography variant="h5" component="p" lang="zh" translate="no" id="h5-learn-meaning" sx={{ mt: 0.75, overflowWrap: 'break-word' }}>{meaning.zh}</Typography>
    : meaning.state === 'loading' ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{t('Looking up the meaning…')}</Typography> : null;
  return (
    <ViewFrame {...frame} footer={phone ? actions : null} keyboard={kb.node}>
      <SlippingChip card={card} />
      <Prompt label={recall ? t('Now from memory') : t('Learn it in parts')} footer={<>{audioRow}{recall ? null : <TipBox tip={card.tip} />}</>}>
        {meaningText}
        {meaning.state === 'no-translator' && !meaning.zh ? <TranslatorNotice onOpen={openTranslator} sx={{ mt: 1 }} /> : null}
        {recall ? (
          <>
            {shown && !result ? <PartsWord parts={parts} word={word} /> : null}
            <Typography variant="body2" color="text.secondary" id="h5-learn-parts-count" sx={{ mt: 0.5, display: 'flex', columnGap: 0.5, flexWrap: 'wrap' }}>
              {meaning.phonetic ? <><Phonetic text={meaning.phonetic} id="h5-learn-phonetic" /><span>{'·'}</span></> : null}
              <span><Fmt template="{1} parts" values={[parts.length]} /></span>
            </Typography>
          </>
        ) : (
          <>
            <PartsWord parts={parts} word={word} />
            {meaning.phonetic ? <Box sx={{ textAlign: 'center' }}><Phonetic text={meaning.phonetic} id="h5-learn-phonetic" /></Box> : null}
          </>
        )}
      </Prompt>
      <Card sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TextField key={step} id={recall ? 'h5-learn-recall-input' : 'h5-learn-copy-input'} label={recall ? t('Type the word') : t('Copy it once')} fullWidth
          inputRef={input} value={recall ? value : copy} onChange={event => change(event.target.value)} onClick={kb.show}
          inputProps={{ readOnly: Boolean(result), translate: 'no', ...fieldProps, ...kb.inputProps }}
          sx={theme => ({ '& input': { ...theme.typography.h6, fontFamily: MONO } })} />
        {phone || result ? null : actions}
      </Card>
      {result ? (
        <Feedback correct={result.correct} near={result.near} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade} next={card.next}>
          <WordLine word={word} phonetic={meaning.phonetic} variant="h6" className="h5-learn-word" sx={{ color: 'success.light' }} phoneticId="h5-learn-feedback-phonetic" />
          {!result.correct ? <Typography variant="body2" color="text.secondary"><Fmt template="You wrote: {1}" values={[value]} /></Typography> : null}
          {!result.correct ? <PatternNote expected={word} answer={value} tip={card.tip} /> : null}
        </Feedback>
      ) : null}
      {ask.panel}
    </ViewFrame>
  );
}

// The small "your translation" chip of the sentence layout: the primary colour on its 12% tint (MD2 chip, caption type).
const CHIP_SX = theme => ({ height: 20, typography: 'caption', fontWeight: 'fontWeightMedium', color: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.12), '& .MuiChip-label': { px: 1 } });
// The gap is about as wide as the word (its letters are counted in the slots anyway).
const gapWidth = word => `${Math.min(12, Math.max(2.5, [...word].length * 0.55)).toFixed(2)}em`;
// The sentence of Spell's sentence layout, in the h6 size: a primary underline where the word goes; after Check the word in it (the success colour
// when right, the error colour when wrong: the right word either way).
function SentenceWithGap({ cloze, result }) {
  const tone = result && result.correct ? 'success.light' : 'error.light';
  return (
    <Typography variant="h6" component="p" lang="en" translate="no" id="h5-learn-sentence" sx={{ mt: 1, fontWeight: 'fontWeightRegular', lineHeight: 1.6, overflowWrap: 'break-word' }}>
      {cloze.before}
      {result ? <Box component="span" id="h5-learn-sentence-word" data-correct={result.correct ? 'true' : 'false'} sx={{ color: tone, fontWeight: 'fontWeightMedium', borderBottom: 2, borderColor: tone }}>{cloze.word}</Box>
        : <Box component="span" id="h5-learn-gap" role="img" aria-label={t('blank')} sx={{ display: 'inline-block', width: gapWidth(cloze.word), height: 0, mx: 0.25, borderBottom: 2, borderColor: 'primary.main', verticalAlign: '-0.15em' }} />}
      {cloze.after}
    </Typography>
  );
}

// `text`: what needs the translator (an English dictionary key); word meanings unless told otherwise.
export function TranslatorNotice({ onOpen, sx, id = 'h5-learn-no-translator', text = 'Word meanings need a translator. Set one up in Settings → Voice and translation.' }) {
  return (
    <Alert severity="info" id={id} sx={sx} action={<Button color="inherit" size="small" id="h5-learn-open-translator" onClick={onOpen}>{t('Open Settings')}</Button>}>
      {t(text)}
    </Alert>
  );
}

// ── Build the sentence ──
// Hidden on purpose for now (BUILD_HIDDEN in learn-model.mjs): no session reaches it, but it stays complete; set BUILD_HIDDEN to false to bring it back.

const TILE_SX = used => theme => ({
  ...theme.typography.body1, height: 40, px: 1.75, borderRadius: 2, boxSizing: 'border-box', flex: '0 0 auto', [TOUCH]: { height: 44 },
  ...(used
    ? { color: 'text.disabled', border: 1, borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'transparent' }
    : { color: 'text.primary', bgcolor: 'background.paper', backgroundImage: overlay(8), boxShadow: theme.shadows[1], '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } }),
});
function Tile({ used = false, className, children, ...props }) {
  return (
    <ButtonBase className={['h5-learn-tile', className].filter(Boolean).join(' ')} disabled={used} tabIndex={used ? -1 : undefined} aria-hidden={used ? 'true' : undefined} sx={TILE_SX(used)} {...props}>
      {children}
    </ButtonBase>
  );
}

function BuildExercise({ ui, card, cards, frame, phone, keys, tts, busy, register, onAnswer, onSkip, audio, exercise, openTranslator }) {
  const tiles = useMemo(() => tilesFor(card, cards), [card, cards]);
  const [placed, setPlaced] = useState([]);
  const [typed, setTyped] = useState('');
  const [helped, setHelped] = useState(false);
  const [focused, setFocused] = useState(false);
  const field = useRef(null);
  useEffect(() => focusOnStart(field, keys), []); // eslint-disable-line react-hooks/exhaustive-deps -- on start
  const answer = builtAnswer(tiles, placed, typed);
  const { result, suggested, grade } = useChecked({
    register, onAnswer, answerText: () => answer,
    check: set => { if (!answer) return; const diff = diffWords(card.en, answer); set({ ...diff, helped }); },
  });
  useCardAudio(audio, exercise, card.en, result);
  const takeBack = () => { if (placed.length && !result) setPlaced(now => now.slice(0, -1)); };
  const type = next => { if (!result) { audio.typed(); setTyped(next); } };
  const kb = useLearnKeys({ ui, keys, field, change: type, atStart: false, emptyBack: takeBack });
  const ask = useAsk({ card, exercise, result, answer: () => answer, field, phone, keys, openTranslator });
  const place = id => { if (!result) setPlaced(now => (now.includes(id) ? now : [...now, id])); };
  const remove = id => { if (!result) setPlaced(now => now.filter(item => item !== id)); };
  // The next word in order; tiles placed wrongly after the right start are taken back first.
  const hint = () => {
    if (result) return;
    let base = placed;
    let id = hintTile(card, tiles, base);
    while (id === null && base.length) { base = base.slice(0, -1); id = hintTile(card, tiles, base); }
    if (id === null) return;
    setHelped(true);
    setPlaced([...base, id]);
  };
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} next={card.next} /> : actionsRow(<>
    {tts ? <AudioButton audio={audio} text={card.en} phone={phone} field={field} /> : null}
    <Button id="h5-learn-hint" onClick={hint} {...keepFocus(field)}>{t('Hint')}</Button>
    <Box sx={{ flex: '1 1 auto' }} />
    {phone ? null : <Button id="h5-learn-skip" onClick={onSkip}>{t('Skip')}</Button>}
    <Button id="h5-learn-check" variant="contained" disabled={!answer} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  const box = (
    <Box className="h5-learn-answer" translate="no" onClick={() => { if (field.current) field.current.focus(); kb.show(); }}
      sx={theme => ({ minHeight: 56, boxSizing: 'border-box', borderRadius: 2, border: 1, borderColor: focused ? 'primary.main' : alpha(theme.palette.primary.main, 0.5), p: 1, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', cursor: 'text' })}>
      {placed.map(id => (
        <Tile key={id} className="h5-learn-placed" data-tile={id} disabled={Boolean(result)} onClick={event => { event.stopPropagation(); remove(id); }} aria-label={tf('Remove "{1}"', tiles[id].text)}>{tiles[id].text}</Tile>
      ))}
      <InputBase inputRef={field} value={typed} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder={placed.length || typed ? '' : t('Type here, or tap the tiles')}
        onChange={event => type(event.target.value)}
        onKeyDown={event => { if (event.key === 'Backspace' && !typed) takeBack(); }}
        inputProps={{ id: 'h5-learn-build-input', 'aria-label': t('Your sentence'), readOnly: Boolean(result), ...fieldProps, ...kb.inputProps }}
        sx={theme => ({ ...theme.typography.body1, flex: '1 1 120px', minWidth: 120 })} />
    </Box>
  );
  const pool = (
    <Box className="h5-learn-pool" translate="no" sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
      {tiles.map(tile => (placed.includes(tile.id)
        ? <Tile key={tile.id} used data-tile={tile.id}>{tile.text}</Tile>
        : <Tile key={tile.id} data-tile={tile.id} disabled={Boolean(result)} onClick={() => place(tile.id)}>{tile.text}</Tile>))}
    </Box>
  );
  return (
    <ViewFrame {...frame} footer={phone ? actions : null} keyboard={kb.node}>
      <Prompt label={t('Chinese')} footer={ask.row}>
        <ChineseText card={card} id="h5-learn-chinese" />
        <Origin card={card} />
      </Prompt>
      <Card sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">{t('Your sentence: tap the tiles, or type it')}</Typography>
        {box}
        {pool}
        {phone || result ? null : actions}
      </Card>
      {result ? (
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade} next={card.next}>
          <SentenceResult card={card} result={result} />
        </Feedback>
      ) : null}
      {ask.panel}
    </ViewFrame>
  );
}

// ── Dictation ──

function DictationExercise({ ui, card, frame, phone, keys, busy, register, onAnswer, onSkip, audio, exercise, openTranslator }) {
  const [value, setValue] = useState('');
  const field = useRef(null);
  useEffect(() => { focusOnStart(field, true); }, [card]); // eslint-disable-line react-hooks/exhaustive-deps -- one card
  const { result, suggested, grade } = useChecked({
    register, onAnswer, answerText: () => value,
    check: set => { if (!value.trim()) return; set({ ...diffWords(card.en, value), helped: false }); },
  });
  useCardAudio(audio, exercise, card.en, result); // Dictation always plays at the start: listening is the task
  const change = next => { if (!result) { audio.typed(); setValue(next); } };
  const kb = useLearnKeys({ ui, keys, field, change });
  const ask = useAsk({ card, exercise, result, answer: () => value, field, phone, keys, openTranslator });
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} next={card.next} /> : actionsRow(<>
    {phone ? null : <Button id="h5-learn-skip" onClick={onSkip}>{t('Skip')}</Button>}
    <Box sx={{ flex: '1 1 auto' }} />
    <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  return (
    <ViewFrame {...frame} footer={phone ? actions : null} keyboard={kb.node}>
      <Prompt label={t('Listen and type what you hear')} footer={(
        <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap', ml: -1 }}>
          <AudioButton audio={audio} text={card.en} field={field} id="h5-learn-play" label="Play" />
          <Button id="h5-learn-slow" onClick={() => audio.play(card.en, { slow: true })} {...keepFocus(field)}>{t('Slow')}</Button>
          {ask.button}
        </Box>
      )}>
        {result ? <ChineseText card={card} id="h5-learn-chinese" /> : null}
      </Prompt>
      <Card sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <OutlinedInput inputRef={field} multiline minRows={2} value={value} onChange={event => change(event.target.value)} onClick={kb.show} placeholder={t('Type the sentence')}
          inputProps={{ id: 'h5-learn-dictation-input', 'aria-label': t('Type the sentence'), readOnly: Boolean(result), translate: 'no', ...fieldProps, ...kb.inputProps }} />
        {phone || result ? null : actions}
      </Card>
      {result ? (
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade} next={card.next}>
          <SentenceResult card={card} result={result} />
        </Feedback>
      ) : null}
      {ask.panel}
    </ViewFrame>
  );
}

// ── Say it ──

function SayExercise({ card, frame, phone, keys, tts, busy, register, onAnswer, onSkip, audio, exercise, openTranslator }) {
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(false);
  const box = useRef(null);
  const mic = useRef(null);
  useEffect(() => {
    if (!box.current || !mic.current) return undefined;
    const voice = attachVoice({ box: box.current, button: mic.current, onText: setValue, onState: setListening });
    return () => voice.dispose();
  }, [card]);
  const { result, suggested, grade } = useChecked({
    register, onAnswer, answerText: () => value,
    check: set => { if (!value.trim()) return; set({ ...diffWords(card.en, value), helped: false }); },
  });
  useCardAudio(audio, exercise, card.en, result); // the model at the start
  const ask = useAsk({ card, exercise, result, answer: () => value, field: box, phone, keys, openTranslator });
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} next={card.next} /> : actionsRow(<>
    {tts ? <AudioButton audio={audio} text={card.en} phone={phone} field={box} /> : null}
    <Box sx={{ flex: '1 1 auto' }} />
    {phone ? null : <Button id="h5-learn-skip" onClick={onSkip}>{t('Skip')}</Button>}
    <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  return (
    <ViewFrame {...frame} footer={phone ? actions : null}>
      <Prompt label={t('Read this aloud')} footer={ask.row}>
        <Typography variant="h5" component="p" translate="no" id="h5-learn-say-text" sx={{ mt: 0.75, overflowWrap: 'break-word' }}>{card.en}</Typography>
        {card.zh ? <Typography variant="body2" color="text.secondary" lang="zh" translate="no" sx={{ mt: 0.5 }}>{card.zh}</Typography> : null}
      </Prompt>
      <Card sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <IconButton ref={mic} id="h5-learn-mic" className="h5-voice" {...named(t('Voice input'))} aria-pressed="false"
            sx={theme => ({ width: 56, height: 56, color: listening ? 'primary.contrastText' : 'primary.main', bgcolor: listening ? 'primary.main' : alpha(theme.palette.primary.main, 0.14), '&:hover': { bgcolor: listening ? 'primary.dark' : alpha(theme.palette.primary.main, 0.22) } })}>
            <Icon name="voice" size={26} />
          </IconButton>
          <Typography variant="body2" color="text.secondary" id="h5-learn-mic-note">
            {listening ? t('Listening… press again when you are done.') : t('Press the microphone and read the sentence. You can also type it.')}
          </Typography>
        </Box>
        <OutlinedInput inputRef={box} multiline minRows={2} value={value} onChange={event => { if (!result) { audio.typed(); setValue(event.target.value); } }} placeholder={t('What you said')}
          inputProps={{ id: 'h5-learn-say-input', 'aria-label': t('What you said'), readOnly: Boolean(result), translate: 'no', ...fieldProps }} />
        {phone || result ? null : actions}
      </Card>
      {result ? (
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade} next={card.next}>
          <SentenceResult card={card} result={result} />
        </Feedback>
      ) : null}
      {ask.panel}
    </ViewFrame>
  );
}

// ── Fill the gap ──

function FillExercise({ ui, card, frame, phone, keys, tts, busy, register, onAnswer, onSkip, audio, exercise, openTranslator }) {
  // `loose`: a sentence without a content word still gets a gap (its longest word); only one without any word shows "no word to fill in".
  // A word of a coach's series asked inside its own sentence brings its gap (`card.gap`, learn-series.mjs exerciseCard).
  const gap = useMemo(() => card.gap || gapFor(card, { loose: true }), [card]);
  const [value, setValue] = useState('');
  const [helped, setHelped] = useState(false);
  const field = useRef(null);
  useEffect(() => focusOnStart(field, true), []); // eslint-disable-line react-hooks/exhaustive-deps -- on start
  const full = gap ? `${gap.before}${value.trim()}${gap.after}` : '';
  const { result, suggested, grade } = useChecked({
    register, onAnswer, answerText: () => value,
    // The gap word was asked for; the tag comes from the whole sentence, so another form of the word is named as grammar (a third person -s).
    detail: () => ({ expected: gap.word, tag: mistakeTag({ mode: 'fill', expected: card.en, answer: full }) }),
    check: set => {
      if (!gap || !value.trim()) return;
      const diff = diffWords(card.en, full);
      const correct = normWord(value) === normWord(gap.word);
      set({ ...diff, correct, helped, near: !correct && nearMiss(gap.word, value) });
    },
  });
  useCardAudio(audio, exercise, card.en, result);
  // The gap word's length is known: the answer is checked by itself once that many letters are typed (Check stays for a shorter one).
  useAutoCheck({ register, ready: Boolean(gap) && typedInFull(value, gap.word), value, result });
  const change = next => { if (!result) { audio.typed(); setValue(next.replace(/\s+/g, '')); } };
  const kb = useLearnKeys({ ui, keys, field, change, letters: true });
  const ask = useAsk({ card, exercise, result, answer: () => value, expected: gap ? gap.word : '', gap: true, field, phone, keys, openTranslator });
  if (!gap) {
    return (
      <ViewFrame {...frame}>
        <Card sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary">{t('This sentence has no word to fill in.')}</Typography>
          <Button id="h5-learn-skip" sx={{ mt: 1 }} onClick={onSkip}>{t('Skip')}</Button>
        </Card>
      </ViewFrame>
    );
  }
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} next={card.next} /> : actionsRow(<>
    <Button id="h5-learn-first" disabled={Boolean(value)} onClick={() => { setHelped(true); setValue(gap.word.slice(0, 1)); if (field.current) field.current.focus({ preventScroll: true }); }} {...keepFocus(field)}>{t('Show first letter')}</Button>
    <Box sx={{ flex: '1 1 auto' }} />
    {phone ? null : <Button id="h5-learn-skip" onClick={onSkip}>{t('Skip')}</Button>}
    <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  return (
    <ViewFrame {...frame} footer={phone ? actions : null} keyboard={kb.node}>
      {card.leech ? <SlippingChip card={card} /> : null}
      <Prompt label={t('Chinese')} footer={ask.row}>
        <ChineseText card={card} id="h5-learn-chinese" />
        <Origin card={card} />
      </Prompt>
      <Card sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">{t('Type the missing word')}</Typography>
        <Typography variant="h6" component="p" translate="no" className="h5-learn-gap" sx={{ fontWeight: 400, lineHeight: 2, overflowWrap: 'break-word' }}>
          {gap.before}
          <InputBase inputRef={field} value={value} onChange={event => change(event.target.value)} onClick={kb.show}
            inputProps={{ id: 'h5-learn-gap-input', 'aria-label': t('The missing word'), readOnly: Boolean(result), size: Math.max(4, gap.word.length + 1), ...fieldProps, ...kb.inputProps }}
            sx={theme => ({ ...theme.typography.h6, fontWeight: 400, mx: 0.5, verticalAlign: 'baseline', '& input': { p: 0, borderBottom: `2px solid ${theme.palette.primary.main}`, textAlign: 'center' } })} />
          {gap.after}
        </Typography>
        {tts ? <Box sx={{ ml: -1, display: 'flex', gap: 1, flexWrap: 'wrap' }}><AudioButton audio={audio} text={card.en} field={field} onPress={() => { if (!result) setHelped(true); }} /></Box> : null}
        {phone || result ? null : actions}
      </Card>
      {result ? (
        <Feedback correct={result.correct} near={result.near} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade} next={card.next}>
          <SentenceResult card={card} result={result} />
          {!result.correct ? <PatternNote expected={gap.word} answer={value} tip={card.tip} /> : null}
        </Feedback>
      ) : null}
      {ask.panel}
    </ViewFrame>
  );
}

const EXERCISES = { spell: SpellOrParts, build: BuildExercise, dictation: DictationExercise, say: SayExercise, fill: FillExercise };

// ── Mistakes and reports: LearnMistakes.jsx ──

// ── Your material ──

const PAGE = 50;
// `source`: opened from "Picked so far" in Learn settings, the words picked from the person's translations (GET /cards?source=translation&kind=word),
// shown as a chip that clears the filter.
function MaterialView({ frame, ui, source: from = '' }) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState(from);
  const [kind, setKind] = useState(from ? 'word' : 'all');
  const [list, setList] = useState({ cards: [], total: 0, loading: true });
  const [editing, setEditing] = useState(null); // { id, zh }
  const load = useCallback(async (offset = 0) => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (kind !== 'all') params.set('kind', kind);
    if (source) params.set('source', source);
    if (query.trim()) params.set('q', query.trim());
    try {
      const data = await api('GET', `/api/learn/cards?${params}`);
      const cards = (data && data.cards) || [];
      setList(now => ({ cards: offset ? [...now.cards, ...cards] : cards, total: Number(data && data.total) || 0, loading: false }));
    } catch (failure) {
      setList(now => ({ ...now, loading: false }));
      ui.notify(errorText(failure), 'error');
    }
  }, [kind, query, source, ui]);
  useEffect(() => {
    const timer = setTimeout(() => { void load(0); }, query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);
  const patch = async (card, body) => {
    try {
      const data = await api('PATCH', `/api/learn/cards/${encodeURIComponent(card.id)}`, body);
      const next = (data && data.card) || { ...card, ...body };
      setList(now => ({ ...now, cards: now.cards.map(item => (item.id === card.id ? next : item)) }));
      return true;
    } catch (failure) {
      ui.notify(errorText(failure), 'error');
      return false;
    }
  };
  const saveMeaning = async card => { if (await patch(card, { zh: editing.zh.trim() })) setEditing(null); };
  return (
    <ViewFrame {...frame}>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField id="h5-learn-search" type="search" size="small" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search your material')}
          inputProps={{ 'aria-label': t('Search your material') }} sx={{ flex: '1 1 220px' }}
          InputProps={{ startAdornment: <Box component="span" sx={{ display: 'inline-flex', color: 'text.secondary', mr: 1 }}><Icon name="search" size={18} /></Box> }} />
        <ToggleButtonGroup id="h5-learn-kind" exclusive size="small" value={kind} onChange={(event, next) => { if (next) setKind(next); }} aria-label={t('Kind')}>
          <ToggleButton value="all">{t('All')}</ToggleButton>
          <ToggleButton value="word">{t('Words')}</ToggleButton>
          <ToggleButton value="sentence">{t('Sentences')}</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      {source ? <Box><Chip id="h5-learn-source-filter" label={t('From your translations')} onDelete={() => setSource('')}
        deleteIcon={<Box component="span" sx={{ display: 'inline-flex' }}><Icon name="close" size={16} /></Box>} /></Box> : null}
      <Typography variant="body2" color="text.secondary" id="h5-learn-total">{count(list.total, 'card', 'cards')}</Typography>
      {list.loading ? <Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography> : null}
      {!list.loading && !list.cards.length ? <Typography variant="body2" color="text.secondary" id="h5-learn-material-empty">{query ? t('Nothing matches your search.') : t('No study cards yet')}</Typography> : null}
      {list.cards.length ? (
        <Card component="ul" id="h5-learn-cards" sx={{ listStyle: 'none', m: 0, px: 2, py: 0 }}>
          {list.cards.map(card => {
            const editingThis = editing && editing.id === card.id;
            return (
              <Box component="li" key={card.id} className="h5-learn-card-row" data-id={card.id} data-suspended={card.suspended ? '' : undefined}
                sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, py: 1.5, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } }}>
                <Box sx={{ flex: '1 1 auto', minWidth: 0, opacity: card.suspended ? 0.6 : 1 }}>
                  <WordLine word={card.en} phonetic={card.kind === 'word' ? card.phonetic : ''} className="h5-learn-card-en" />
                  {editingThis ? (
                    <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                      <TextField id="h5-learn-edit-zh" size="small" label={t('Meaning')} value={editing.zh} autoFocus sx={{ flex: '1 1 200px' }}
                        onChange={event => setEditing({ id: card.id, zh: event.target.value })}
                        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveMeaning(card); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); } }} />
                      <Button onClick={() => setEditing(null)}>{t('Cancel')}</Button>
                      <Button variant="contained" id="h5-learn-save-zh" onClick={() => saveMeaning(card)}>{t('Save')}</Button>
                    </Box>
                  ) : card.zh
                    ? <Typography variant="body2" color="text.secondary" lang="zh" translate="no" className="h5-learn-card-zh" sx={{ overflowWrap: 'break-word' }}>{card.zh}</Typography>
                    : <Typography variant="body2" color="text.disabled" className="h5-learn-card-zh">{t('No meaning yet')}</Typography>}
                  <Typography variant="caption" color="text.secondary" component="p">
                    {t(card.kind === 'word' ? 'Word' : 'Sentence')}{' · '}{sourceLabel(card)}{card.suspended ? <>{' · '}{t('Suspended')}</> : null}
                  </Typography>
                </Box>
                {editingThis ? null : <IconButton className="h5-learn-edit" size="small" {...named(t('Edit meaning'))} onClick={() => setEditing({ id: card.id, zh: card.zh || '' })}><Icon name="edit" size={20} /></IconButton>}
                <Button size="small" className="h5-learn-suspend" onClick={() => patch(card, { suspended: !card.suspended })}>{card.suspended ? t('Restore') : t('Suspend')}</Button>
              </Box>
            );
          })}
        </Card>
      ) : null}
      {list.cards.length < list.total ? <Box><Button id="h5-learn-more" onClick={() => load(list.cards.length)}>{t('Show more')}</Button></Box> : null}
    </ViewFrame>
  );
}

// ── Learn settings ──

function SettingsView({ frame, ui, data, openTranslator, open, focus = '' }) {
  const { settings, setSettings, reload } = data;
  const [goal, setGoal] = useState(String((settings && settings.daily_goal) || 20));
  useEffect(() => { if (settings && settings.daily_goal) setGoal(String(settings.daily_goal)); }, [settings && settings.daily_goal]); // eslint-disable-line react-hooks/exhaustive-deps -- the stored goal
  const [busy, setBusy] = useState(false);
  // The last failed change, in view until the next change works (on a company computer whose home cannot be reached the server answers 503 with
  // its reason; a toast alone would be easy to miss). The controls show the stored values again.
  const [failed, setFailed] = useState('');
  const current = settings || {};
  const fail = failure => {
    const message = errorText(failure) || t('Operation failed');
    setFailed(message);
    ui.notify(message, 'error');
  };
  const save = async patch => {
    setBusy(true);
    setFailed('');
    try {
      const next = await api('PUT', '/api/learn/settings', patch);
      setSettings(next || { ...current, ...patch });
      // The page's collection hooks (public/js/learn-collect.js) stop or start collecting at once; the server checks the setting too.
      if (typeof patch.collect === 'boolean' && window.LearnCollect && typeof window.LearnCollect.set === 'function') window.LearnCollect.set(patch.collect);
      void reload();
      return true;
    } catch (failure) {
      fail(failure);
      if (patch.daily_goal !== undefined) setGoal(String(current.daily_goal || 20));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const number = Number(goal);
  const goalValid = Number.isInteger(number) && number >= 1 && number <= 200;
  const commitGoal = () => { if (goalValid && number !== current.daily_goal) void save({ daily_goal: number }); };
  const toggleStarter = async on => {
    if (!on) { await save({ starter: null }); return; }
    setBusy(true);
    setFailed('');
    try {
      const result = await api('POST', '/api/learn/starter', { list: 'dev' });
      ui.notify(tf('Added {1} words', (result && result.added) || 0), 'success');
    } catch (failure) {
      fail(failure);
      setBusy(false);
      return;
    }
    await save({ starter: 'dev' });
  };
  return (
    <ViewFrame {...frame}>
      {failed ? <Alert severity="error" id="h5-learn-settings-error" role="alert">{failed}</Alert> : null}
      <LevelSettings current={current} settings={settings} busy={busy} save={save} fail={fail} clearFailed={() => setFailed('')} openTranslator={openTranslator}
        openPicked={() => open({ kind: 'material', source: 'translation', parent: { kind: 'settings' } })} />
      <Typography variant="overline" component="h3" color="text.secondary" sx={SECTION_SX}>{t('Practice')}</Typography>
      {!settings ? <Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography> : (
        <Card id="h5-learn-settings-card" sx={{ px: 2, py: 1 }}>
          <SwitchRow inputId="h5-learn-collect" label={t('Collect study material')} disabled={busy} checked={current.collect !== false} onChange={on => save({ collect: on })}
            secondary={t('Save the sentences you send with "Chinese → English" and the words you look up by tapping as study cards.')} />
          <Divider sx={{ mx: -2 }} />
          <Box sx={{ py: 2 }}>
            <TextField id="h5-learn-goal-input" type="number" size="small" label={t('Daily goal')} value={goal} error={!goalValid}
              helperText={goalValid ? t('Cards a day, 1 to 200') : t('Enter a number from 1 to 200')} onChange={event => setGoal(event.target.value)} onBlur={commitGoal}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitGoal(); } }} inputProps={{ min: 1, max: 200, step: 1, inputMode: 'numeric' }} sx={{ width: 200 }} />
          </Box>
          <Divider sx={{ mx: -2 }} />
          <SwitchRow inputId="h5-learn-starter" label={t('Starter list: Programmer English')} disabled={busy} checked={current.starter === 'dev'} onChange={toggleStarter}
            secondary={typeof current.new_per_day === 'number'
              ? t('Common words of software work; new ones come at the pace of New words a day. Turning it off hides the starter words you have not practised yet; nothing is deleted.')
              : t('Common words of software work, 10 new ones a day. Turning it off hides the starter words you have not practised yet; nothing is deleted.')} />
          <Divider sx={{ mx: -2 }} />
          <SwitchRow inputId="h5-learn-analysis-auto" label={t('Analyze my mistakes every week')} disabled={busy} checked={current.analysis_auto !== false} onChange={on => save({ analysis_auto: on })}
            secondary={t('When a week has at least 10 new mistakes, your translation model writes a report: the causes and what to practise. Only the words and sentences you got wrong and what you wrote are sent.')} />
        </Card>
      )}
      {settings && typeof current.new_per_day === 'number' ? <NewWordsSettings current={current} busy={busy} save={save} /> : null}
      {settings && typeof current.desired_retention === 'number' ? <ScheduleSettings current={current} busy={busy} save={save} /> : null}
      {settings ? <AudioSettings current={current} busy={busy} save={save} /> : null}
      {/* Coach: shown by a server whose learning settings have the coach's fields ("Coach settings" in docs/design/learn-english-coach-page.md). */}
      {settings && typeof current.coach_memory === 'boolean' ? <CoachSettings current={current} busy={busy} save={save} ui={ui} focus={focus === 'coach'} /> : null}
      <Card sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">{t('Word meanings come from the translator in Settings → Voice and translation.')}</Typography>
        <Button id="h5-learn-translator-settings" sx={{ mt: 1, ml: -1 }} onClick={openTranslator}>{t('Open Settings')}</Button>
      </Card>
    </ViewFrame>
  );
}

// A section title of Learn settings (MD2 overline) over its card.
const SECTION_SX = { mt: 1, mb: -1 };

// "MY LEVEL" and "WORDS FROM MY TRANSLATIONS" of Learn settings ("Learn settings" in docs/design/learn-english-page.md). GET /api/learn/level gives
// the estimated level (shared by the linked engines), the counts of the picking and whether a translation model is set up; Check again / Check now
// is POST /api/learn/level/check (503 without a model, 409 while a run is going, 502 for an unreadable answer: shown like the other failed changes).
// The switch is `pick_words` of the learning settings (PUT /settings, shared); View opens Your material on the picked words.
function useLevel() {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    let live = true;
    api('GET', '/api/learn/level').then(
      data => { if (live) setState({ loading: false, data: data || {}, error: '' }); },
      failure => { if (live) setState({ loading: false, data: null, error: errorText(failure) || t('Operation failed') }); },
    );
    return () => { live = false; };
  }, []);
  return [state, setState];
}
const Parts = ({ parts }) => parts.map((part, index) => <span key={part.template}>{index ? ' · ' : ''}<Fmt template={part.template} values={part.values} /></span>);
function LevelSettings({ current, settings, busy, save, fail, clearFailed, openTranslator, openPicked }) {
  const [state, setState] = useLevel();
  const [checking, setChecking] = useState(false);
  const data = state.data || {};
  const level = data.level || null;
  const picking = data.picking || null;
  const ready = !state.loading && !state.error;
  const check = async () => {
    setChecking(true);
    clearFailed();
    try {
      const next = await api('POST', '/api/learn/level/check', {});
      setState(now => ({ loading: false, data: next || now.data, error: '' }));
    } catch (failure) {
      // 503: no translation model (any more); the card shows the notice instead of the button.
      if (failure && failure.status === 503) setState(now => ({ ...now, data: { ...(now.data || {}), translator: false } }));
      fail(failure);
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <Typography variant="overline" component="h3" color="text.secondary" sx={SECTION_SX}>{t('My level')}</Typography>
      <Card id="h5-learn-level-card" aria-busy={checking ? 'true' : undefined} sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">{t('Your level (estimated)')}</Typography>
        {state.loading ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{t('Loading…')}</Typography> : null}
        {state.error ? <Typography variant="body2" color="text.secondary" id="h5-learn-level-error" sx={{ mt: 0.5 }}>{state.error}</Typography> : null}
        {ready && level ? (
          <>
            <Box sx={{ display: 'flex', alignItems: 'baseline', columnGap: 1.5, flexWrap: 'wrap', mt: 0.5 }}>
              <Typography variant="h4" component="p" translate="no" id="h5-learn-level">{level.level}</Typography>
              {level.label ? <Typography variant="body2" color="text.secondary" translate="no" id="h5-learn-level-label">{level.label}</Typography> : null}
            </Box>
            {level.reason ? <Typography variant="body2" translate="no" id="h5-learn-level-reason" sx={{ mt: 1, overflowWrap: 'break-word' }}>{level.reason}</Typography> : null}
            <Typography variant="caption" component="p" color="text.secondary" id="h5-learn-level-note" sx={{ mt: 1 }}><Parts parts={levelNote(level)} /></Typography>
          </>
        ) : null}
        {ready && !level ? <Typography variant="h6" component="p" id="h5-learn-level-none" sx={{ mt: 0.5 }}>{t('Not estimated yet')}</Typography> : null}
        {checking ? <LinearProgress id="h5-learn-level-busy" aria-label={t('Checking your level…')} sx={{ mt: 1.5 }} /> : null}
        {ready && data.translator === false ? <TranslatorNotice id="h5-learn-level-no-translator" onOpen={openTranslator} sx={{ mt: 1.5 }} /> : null}
        {ready && data.translator !== false ? (
          <Button id="h5-learn-level-check" sx={{ mt: 1, ml: -1 }} disabled={checking} onClick={check}>{checking ? t('Checking…') : level ? t('Check again') : t('Check now')}</Button>
        ) : null}
      </Card>
      <Typography variant="overline" component="h3" color="text.secondary" sx={SECTION_SX}>{t('Words from my translations')}</Typography>
      <Card id="h5-learn-pick-card" sx={{ px: 2, py: 1 }}>
        <SwitchRow inputId="h5-learn-pick-words" label={t('Pick words from my translations')} disabled={busy || !settings} checked={current.pick_words !== false}
          onChange={on => save({ pick_words: on })} secondary={t('Less common words above your level become Spell cards, asked inside their sentence')} />
        <Divider sx={{ mx: -2 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 56, py: 1 }}>
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Typography variant="body1">{t('Picked so far')}</Typography>
            <Typography variant="body2" color="text.secondary" id="h5-learn-picked">
              {picking ? <Parts parts={pickedNote(picking)} /> : state.loading ? t('Loading…') : '—'}
            </Typography>
          </Box>
          <Button id="h5-learn-picked-view" sx={{ flexShrink: 0 }} onClick={openPicked}>{t('View')}</Button>
        </Box>
      </Card>
      <Typography variant="caption" component="p" color="text.secondary" id="h5-learn-pick-privacy" sx={{ mt: -1 }}>
        {t('Your sentences and a summary of your answers go to the translation model you set up (the same one that translated them). Nothing else is sent.')}
      </Typography>
    </>
  );
}

// The Audio part of Learn settings: shared like the other learning settings (learn_v1 on the server, synced to every linked engine; on a company
// computer changed on its home). Each choice is saved at once, so the rows are switches and toggle buttons, not a form.
function ChoiceRow({ id, label, secondary = null, value, choices, disabled = false, onChange }) {
  return (
    <Box className="h5-learn-choice-row" sx={{ display: 'flex', alignItems: 'center', columnGap: 2, rowGap: 1, minHeight: 56, py: 1, flexWrap: 'wrap' }}>
      <Box sx={{ flex: '1 1 140px', minWidth: 0 }}>
        <Typography variant="body1" id={`${id}-label`} color={disabled ? 'text.disabled' : 'text.primary'}>{label}</Typography>
        {secondary ? <Typography variant="body2" color="text.secondary">{secondary}</Typography> : null}
      </Box>
      <ToggleButtonGroup id={id} exclusive size="small" value={value} disabled={disabled} aria-labelledby={`${id}-label`}
        onChange={(event, next) => { if (next !== null && next !== value) onChange(next); }}>
        {choices.map(([choice, text]) => <ToggleButton key={String(choice)} value={choice} data-value={String(choice)} sx={{ px: 1.5, minWidth: 44 }}>{text}</ToggleButton>)}
      </ToggleButtonGroup>
    </Box>
  );
}
function AudioSettings({ current, busy, save }) {
  const options = audioOptions(current);
  return (
    <>
      <Typography variant="overline" component="h3" color="text.secondary" sx={SECTION_SX}>{t('Audio')}</Typography>
      <Card id="h5-learn-audio-card" sx={{ px: 2, py: 1 }}>
        <SwitchRow inputId="h5-learn-audio-words" label={t('Play words automatically')} disabled={busy} checked={options.words} onChange={on => save({ audio_words: on })}
          secondary={t('When a word card appears, and once more after the answer')} />
        <Divider sx={{ mx: -2 }} />
        <SwitchRow inputId="h5-learn-audio-sentences" label={t('Play sentences automatically')} disabled={busy} checked={options.sentences} onChange={on => save({ audio_sentences: on })}
          secondary={t('Dictation and Say it play at the start')} />
        <ChoiceRow id="h5-learn-audio-when" label={t('Sentences play')} secondary={t(BUILD_HIDDEN ? 'In Fill the gap and Review' : 'In Build the sentence, Fill the gap and Review')} value={options.sentencesAt} disabled={busy || !options.sentences}
          choices={[['after', t('After the answer')], ['start', t('When the card appears')]]} onChange={next => save({ audio_sentences_at: next })} />
        <Divider sx={{ mx: -2 }} />
        <ChoiceRow id="h5-learn-audio-repeat" label={t('Repeat')} secondary={t('How many times each one is played')} value={options.repeat} disabled={busy}
          choices={[1, 2, 3, 5].map(n => [n, `${n}\u00d7`])} onChange={next => save({ audio_repeat: next })} />
        <Divider sx={{ mx: -2 }} />
        <ChoiceRow id="h5-learn-audio-pause" label={t('Pause between repeats')} value={options.pauseMs / 1000} disabled={busy}
          choices={[1, 2, 3].map(n => [n, tf('{1} s', n)])} onChange={next => save({ audio_pause: next })} />
        <Divider sx={{ mx: -2 }} />
        <ChoiceRow id="h5-learn-audio-speed" label={t('Speed')} value={options.slow ? 'slow' : 'normal'} disabled={busy}
          choices={[['slow', t('Slow')], ['normal', t('Normal')]]} onChange={next => save({ audio_speed: next })} />
        <Divider sx={{ mx: -2 }} />
        <SwitchRow inputId="h5-learn-audio-stop" label={t('Stop when I start typing')} disabled={busy} checked={options.stopOnTyping} onChange={on => save({ audio_stop_on_typing: on })}
          secondary={t('The rest of the repeats is skipped')} />
      </Card>
    </>
  );
}

// NEW WORDS of Learn settings ("New words a day" in docs/design/learn-english-page.md): `new_per_day` of the learning settings (learn_v1, shared by every
// linked engine), at most this many never-answered words join the queues each day, after the due cards. Saved at once. Shown only when the server's
// settings have the field (an older server has no daily count).
const NEW_PER_DAY = [5, 10, 15, 20, 30];
function NewWordsSettings({ current, busy, save }) {
  const value = NEW_PER_DAY.includes(current.new_per_day) ? current.new_per_day : null;
  return (
    <>
      <Typography variant="overline" component="h3" color="text.secondary" sx={SECTION_SX}>{t('New words')}</Typography>
      <Card id="h5-learn-new-words-card" sx={{ px: 2, py: 1 }}>
        <ChoiceRow id="h5-learn-new-per-day" label={t('New words a day')} secondary={t('Due reviews always come first')} value={value} disabled={busy}
          choices={NEW_PER_DAY.map(choice => [choice, String(choice)])} onChange={next => save({ new_per_day: next })} />
      </Card>
    </>
  );
}

// REVIEW SCHEDULE of Learn settings ("Learn settings" in docs/design/learn-english-page.md): `desired_retention` of the learning settings (learn_v1,
// shared by every linked engine like the rest), how sure the person wants to be of a card when it comes back; FSRS plans the gaps for it. Saved at
// once like the other Learn settings. Shown only when the server's settings have the field (an older server has no FSRS).
const RETENTION = [0.85, 0.9, 0.95];
function ScheduleSettings({ current, busy, save }) {
  const value = RETENTION.find(choice => Math.abs(choice - current.desired_retention) < 0.001) ?? null;
  return (
    <>
      <Typography variant="overline" component="h3" color="text.secondary" sx={SECTION_SX}>{t('Review schedule')}</Typography>
      <Card id="h5-learn-schedule-card" sx={{ px: 2, py: 1 }}>
        <ChoiceRow id="h5-learn-retention" label={t('Remember')} secondary={t('How sure you want to be when a card comes back')} value={value} disabled={busy}
          choices={RETENTION.map(choice => [choice, `${Math.round(choice * 100)}%`])} onChange={next => save({ desired_retention: next })} />
        <Typography variant="caption" component="p" color="text.secondary" sx={{ pb: 1 }}>
          {t('Cards are scheduled with FSRS, a model of how memory fades, from your own answers. Higher means more reviews; 90% is a good balance.')}
        </Typography>
      </Card>
    </>
  );
}

// ── How learning works ──

const HOW = [
  ['Your own sentences', 'Messages you send with "Chinese → English" become cards (the Chinese and the English), and words you tap to look up become word cards. A starter list can be added too.'],
  ['Spaced review', 'Each card comes back about when you would start to forget it. FSRS, a model of how memory fades, plans the gap from your own answers; Again / Hard / Good change it, and each button shows when the card returns. The due count is the plan for today.'],
  // Build the sentence is hidden for now (BUILD_HIDDEN in learn-model.mjs): the four ways that are offered.
  BUILD_HIDDEN ? ['Four ways to practise', 'Spell the word · Dictation (hear, type) · Say it (read aloud, voice input checks) · Fill the gap.']
    : ['Five ways to practise', 'Spell the word · Build the sentence (tiles or typing) · Dictation (hear, type) · Say it (read aloud, voice input checks) · Fill the gap.'],
  ['Clear feedback', 'Word-by-word diff after Check, with the usual mistake named (articles, plurals, tense, word order) and a list of mistakes to review.'],
  ['Everywhere', 'Stored on the server, so the phone and the computer share progress.'],
];
function HowView({ frame }) {
  return (
    <ViewFrame {...frame}>
      <Card id="h5-learn-how-card" component="ol" sx={{ listStyle: 'none', m: 0, p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {HOW.map(([title, text], index) => (
          <Box component="li" key={title} sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
            <Box aria-hidden="true" sx={theme => ({ ...theme.typography.caption, fontWeight: 500, flex: '0 0 28px', height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.14) })}>{index + 1}</Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" component="p" sx={{ fontWeight: 500, lineHeight: 1.4 }}>{t(title)}</Typography>
              <Typography variant="body2" color="text.secondary">{t(text)}</Typography>
            </Box>
          </Box>
        ))}
      </Card>
    </ViewFrame>
  );
}
