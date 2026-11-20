import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
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
import { AUTO_CHECK_MS, diffWords, hintText, mistakeTag, normWord, spellCheck, suggestedGrade, typedInFull } from './learn-grade.mjs';
import { availableModes, builtAnswer, exerciseKey, exerciseOf, gapFor, goalProgress, hintTile, maskedContext, minutesFor, mixCards, modeOf, slotLayout, tilesFor } from './learn-model.mjs';
import { attachVoice, canSpeak, speakOnce, stopSpeaking, voiceWay } from './learn-speech.mjs';
import { audioOptions, autoPlays, createPlayer } from './learn-audio.mjs';
import { MistakesView, NewReportLine, ReportView, ReportsView } from './LearnMistakes.jsx';

// The Learn page (the "Learn" destination of the navigation rail and the bottom navigation; a chunk of its own, screen-learn.jsx). English practice
// with the person's own material: the sentences sent with "Chinese -> English" and the words looked up in the chat (the server's /api/learn, see
// docs/design/learn-english.md), plus an optional starter list.
// - Computer: a page right of the rail (like Settings): the home on the left (today's due cards, the goal, the streak, Start review, the practice modes
//   with their counts, Mistakes, Your material, Learn settings) and the open mode on the right ("How learning works" while none is open). Escape closes
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
  const reload = useCallback(() => api('GET', '/api/learn/summary').then(
    data => { setSummary(data || {}); setError(''); },
    failure => setError(errorText(failure) || t('Could not load your study cards.')),
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
  const [view, setView] = useState(null); // { kind: 'session' | 'material' | 'settings' | 'mistakes' | 'reports' | 'report' | 'how', mode?, preset?, uid?, seq }
  const viewRef = useRef(null);
  viewRef.current = view;
  const close = () => ui.actions.closeLearn();
  const back = () => { setView(null); void data.reload(); };
  const open = next => setView({ ...next, seq: Date.now() });
  const openTranslator = () => { ui.actions.closeLearn(); ui.actions.openSettings('voice-translate'); };
  const modes = availableModes(speech);
  const common = { ui, phone, keys, speech, openTranslator, data, open, back };

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
      if (viewRef.current) back(); else close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected && typeof opener.focus === 'function') setTimeout(() => opener.focus({ preventScroll: true }), 0);
    };
  }, [phone]); // eslint-disable-line react-hooks/exhaustive-deps -- close and back read the store and the ref

  const home = <Home {...common} modes={modes} current={view && view.kind === 'session' ? view.mode : view && view.kind} />;
  if (!phone) {
    return (
      <Box ref={root} id="h5-learn" role="region" aria-labelledby="h5-learn-title" data-layout="wide"
        sx={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: state.pane ? 0 : NAV_WIDTH, zIndex: 1255, display: 'flex', bgcolor: 'background.default', color: 'text.primary' }}>
        <Box className="h5-learn-home" sx={{ flex: '0 0 420px', width: 420, boxSizing: 'border-box', overflowY: 'auto', p: 3, display: 'flex', flexDirection: 'column', gap: 1.5, borderRight: 1, borderColor: 'divider', '& > *': { flexShrink: 0 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography id="h5-learn-title" variant="h5" component="h1" tabIndex={-1} sx={{ flex: '1 1 auto', outline: 'none' }}>{t('Learn English')}</Typography>
            <IconButton id="h5-learn-close" edge="end" onClick={close} {...named(t('Close'))}><Icon name="close" size={20} /></IconButton>
          </Box>
          {home}
        </Box>
        <Box className="h5-learn-pane" sx={{ flex: '1 1 auto', minWidth: 0, overflowY: 'auto', px: 4, py: 3 }}>
          <Box sx={{ maxWidth: 880 }}>
            {view ? <ViewBody key={view.seq} view={view} {...common} /> : <HowView frame={{ phone: false, title: t('How learning works') }} />}
          </Box>
        </Box>
      </Box>
    );
  }
  return <PhoneLearn {...common} view={view} close={close} home={home} />;
}

function PhoneLearn({ view, close, home, back, ...common }) {
  const last = useRef(null);
  if (view) last.current = view;
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
      <Dialog id="h5-learn-mode" open={Boolean(view)} fullScreen onClose={back} aria-labelledby="h5-learn-view-title" sx={PHONE_ROOT}
        slots={{ transition: Slide }} slotProps={{ transition: { direction: 'left', onExited: () => { last.current = null; } }, paper: { className: 'h5-learn-mode-page', sx: PAPER } }}>
        {last.current ? <ViewBody key={last.current.seq} view={last.current} back={back} {...common} /> : null}
      </Dialog>
    </>
  );
}

function ViewBody({ view, phone, back, open, data, ...common }) {
  // A report opened from the Mistakes page (or the list of reports) goes back there (`parent`); every other view back to the home.
  const frame = title => ({ phone, title, onBack: view.parent ? () => open(view.parent) : back });
  if (view.kind === 'session') return <Session mode={view.mode} preset={view.preset} phone={phone} onBack={back} onRestart={mode => open({ kind: 'session', mode })} onDone={data.reload} settings={data.settings} {...common} />;
  if (view.kind === 'material') return <MaterialView frame={frame(t('Your material'))} ui={common.ui} />;
  if (view.kind === 'settings') return <SettingsView frame={frame(t('Learn settings'))} ui={common.ui} data={data} openTranslator={common.openTranslator} />;
  if (view.kind === 'mistakes') return <MistakesView frame={frame(t('Mistakes'))} ui={common.ui} open={open} openTranslator={common.openTranslator} />;
  if (view.kind === 'reports') return <ReportsView frame={frame(t('Mistake reports'))} ui={common.ui} open={open} />;
  if (view.kind === 'report') return <ReportView frame={frame(t('Mistake report'))} view={view} ui={common.ui} open={open} data={data} />;
  return <HowView frame={frame(t('How learning works'))} />;
}

// The frame of a mode: on a phone an app bar (back arrow, title, "7 / 20 · from your translations") over the page that scrolls and the actions pinned
// at its bottom; on a computer a title row with the counter, the progress bar and a close button, then the content.
// `keyboard`: the page's own keyboard (useLearnKeys), under the page on a phone, at the bottom of the pane on a computer-sized touch screen.
export function ViewFrame({ phone, title, counter = '', source = '', progress = null, onBack = null, footer = null, keyboard = null, children }) {
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
          </Toolbar>
        </AppBar>
        <Box className="h5-learn-scroll" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</Box>
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
        {progress !== null ? <LinearProgress className="h5-learn-progress" variant="determinate" value={Math.round(progress * 100)} aria-label={t('Progress')} sx={{ width: 160, height: 6, borderRadius: 3 }} /> : null}
        {onBack ? <IconButton id="h5-learn-back" size="small" onClick={onBack} {...named(t('Close'))}><Icon name="close" size={20} /></IconButton> : null}
      </Box>
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

async function loadQueue(mode) {
  if (mode === 'mixed') {
    const [words, sentences] = await Promise.all([api('GET', '/api/learn/queue?mode=spell&limit=10'), api('GET', '/api/learn/queue?mode=build&limit=10')]);
    return mixCards([words && words.cards, sentences && sentences.cards], 20);
  }
  const limit = (modeOf(mode) || { limit: 20 }).limit;
  const data = await api('GET', `/api/learn/queue?mode=${encodeURIComponent(mode)}&limit=${limit}`);
  return (data && Array.isArray(data.cards) ? data.cards : []).filter(card => card && !card.suspended);
}

function Session({ mode, preset, phone, keys, speech, ui, onBack, onRestart, onDone, openTranslator, settings }) {
  const audio = useAudio(settings, speech.tts);
  const [cards, setCards] = useState(preset || null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [stats, setStats] = useState({ answered: 0, right: 0 });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const register = useRef(null);
  useEffect(() => {
    if (preset) return undefined;
    let live = true;
    loadQueue(mode).then(list => { if (live) setCards(list); }, failure => { if (live) setError(errorText(failure)); });
    return () => { live = false; };
  }, [mode, preset]);
  const finished = Boolean(cards) && cards.length > 0 && index >= cards.length;
  useEffect(() => { if (finished) void onDone(); }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps -- once at the end
  // The keys of a computer (exerciseKey): Enter checks, Enter again takes the offered grade, 1 / 2 / 3 grade a checked answer.
  useEffect(() => {
    const onKey = event => {
      if (event.defaultPrevented || event.isComposing || !register.current) return;
      const target = event.target || document.body;
      const tag = target.tagName;
      if (event.key === 'Enter' && (tag === 'BUTTON' || tag === 'A')) return; // the focused button answers Enter itself
      if (event.key === 'Enter' && tag === 'TEXTAREA' && event.shiftKey) return;
      if (target !== document.body && !(target.closest && target.closest('#h5-learn, #h5-learn-mode'))) return;
      const inField = (tag === 'INPUT' || tag === 'TEXTAREA') && !target.readOnly;
      const action = exerciseKey({ key: event.key, checked: register.current.checked, inField, modifiers: event.altKey || event.ctrlKey || event.metaKey });
      if (!action) return;
      event.preventDefault();
      if (action.action === 'check') register.current.check(); else register.current.grade(action.grade);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const card = cards && cards[index];
  const exercise = card ? pickExercise(exerciseOf(card, mode), speech) : null;
  const answer = async ({ grade, correct, answer: text, helped = false, gaveUp = false, detail = null }) => {
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
      setStats(now => ({ answered: now.answered + 1, right: now.right + (correct ? 1 : 0) }));
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
  const total = cards ? cards.length : 0;
  const frame = {
    phone, title: titleOf(mode), onBack,
    counter: card ? `${index + 1} / ${total}` : '', source: card ? sourceLabel(card) : '', progress: card ? (index + 1) / total : null,
  };
  if (error) return <ViewFrame {...frame}><Alert severity="error" id="h5-learn-session-error">{error}</Alert></ViewFrame>;
  if (!cards) return <ViewFrame {...frame}><Typography variant="body2" color="text.secondary" id="h5-learn-session-loading">{t('Loading…')}</Typography></ViewFrame>;
  if (!cards.length) {
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
        <Card id="h5-learn-done" sx={{ p: 2 }}>
          <Typography variant="h6" component="p">{t('Session done')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}><Fmt template="{1} answered · {2} right" values={[stats.answered, stats.right]} /></Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
            <Button variant="contained" id="h5-learn-finish" onClick={onBack}>{t('Back to Learn')}</Button>
            <Button id="h5-learn-again" onClick={() => onRestart(mode === 'mistakes' ? 'mixed' : mode)}>{t('Practise more')}</Button>
          </Box>
        </Card>
      </ViewFrame>
    );
  }
  const Exercise = EXERCISES[exercise];
  return (
    <Exercise key={`${card.id}-${index}`} ui={ui} card={card} cards={cards} frame={frame} phone={phone} keys={keys} tts={speech.tts} busy={busy} register={register}
      onAnswer={answer} onSkip={skip} openTranslator={openTranslator} audio={audio} exercise={exercise} />
  );
}
// A mode the browser cannot run falls back to Build the sentence (a card due for Dictation in a browser without speech output).
const pickExercise = (exercise, speech) => ((exercise === 'dictation' && !speech.tts) || (exercise === 'say' && !speech.voice) ? 'build' : exercise);

// ── Shared parts of the exercises ──

const GRADES = [['again', 'Again', '1'], ['hard', 'Hard', '2'], ['good', 'Good', '3']];
function Grades({ suggested, onGrade, busy, keys }) {
  return (
    <Box className="h5-learn-grades" role="group" aria-label={t('How well did you know it?')} sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
      {GRADES.map(([grade, label, key]) => (
        <Button key={grade} id={`h5-learn-grade-${grade}`} data-grade={grade} variant={grade === suggested ? 'contained' : 'outlined'} autoFocus={grade === suggested}
          disabled={busy} onClick={() => onGrade(grade)} aria-keyshortcuts={keys ? key : undefined}>
          {t(label)}{keys ? <Box component="span" aria-hidden="true" sx={{ ml: 1, opacity: 0.7, typography: 'caption' }}>{key}</Box> : null}
        </Button>
      ))}
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
// The result of a checked answer, with the grades on a computer (a phone has them in its pinned actions).
function Feedback({ correct, phone, keys, busy, suggested, onGrade, children }) {
  return (
    <Card id="h5-learn-feedback" data-correct={correct ? 'true' : 'false'} role="status" sx={{ p: 2 }}>
      <Typography variant="body2" sx={{ color: correct ? 'success.light' : 'error.light', fontWeight: 500 }}>{correct ? t('Right') : t('Not quite')}</Typography>
      <Box sx={{ mt: 0.75 }}>{children}</Box>
      {phone ? null : <Box sx={{ mt: 1.5 }}><Grades suggested={suggested} onGrade={onGrade} busy={busy} keys={keys} /></Box>}
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
function Prompt({ label, children, footer = null }) {
  return (
    <Card className="h5-learn-prompt" sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
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
  const suggested = result ? suggestedGrade({ correct: result.correct, helped: result.helped }) : null;
  const grade = choice => {
    if (!result) return;
    onAnswer({ grade: choice || suggested, correct: result.correct, answer: answerText(), helped: Boolean(result.helped), gaveUp: Boolean(result.gaveUp), detail: detail && !result.correct ? detail() : null });
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
    speakOnce, cancel: stopSpeaking,
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
function WordLine({ word, phonetic, variant = 'body1', className, sx, phoneticId }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', columnGap: 1, flexWrap: 'wrap', minWidth: 0 }}>
      <Typography variant={variant} component="p" translate="no" className={className} sx={{ overflowWrap: 'break-word', minWidth: 0, ...sx }}>{word}</Typography>
      <Phonetic text={phonetic} id={phoneticId} />
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
    let start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
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

function SpellExercise({ ui, card, frame, phone, keys, tts, busy, register, onAnswer, openTranslator, audio, exercise }) {
  const word = String(card.en || '').trim();
  const [value, setValue] = useState('');
  const [helped, setHelped] = useState(false);
  const [focused, setFocused] = useState(false);
  const [meaning, setMeaning] = useState({ zh: card.zh || '', phonetic: card.phonetic || '', state: card.zh ? 'ok' : 'loading' });
  const input = useRef(null);
  useEffect(() => {
    focusOnStart(input, true); // on a touch screen too: the page's keyboard types into it (no system keyboard)
    if (card.zh) return undefined;
    let live = true;
    api('POST', '/api/learn/meaning', { word }).then(
      data => { if (live) setMeaning({ zh: (data && data.zh) || '', phonetic: card.phonetic || (data && data.phonetic) || '', state: data && data.zh ? 'ok' : 'none' }); },
      failure => { if (live) setMeaning({ zh: '', phonetic: card.phonetic || '', state: failure && failure.status === 503 ? 'no-translator' : 'none' }); },
    );
    return () => { live = false; };
  }, [card]); // eslint-disable-line react-hooks/exhaustive-deps -- one card
  const { result, setResult, suggested, grade } = useChecked({
    register, onAnswer, answerText: () => value,
    check: set => { if (!value.trim()) return; const check = spellCheck(word, value); set({ ...check, correct: check.ok, helped }); },
  });
  useCardAudio(audio, exercise, word, result);
  useAutoCheck({ register, ready: typedInFull(value, word), value, result });
  const change = next => { if (!result) { audio.typed(); setValue(next.replace(/\s+/g, '').slice(0, word.length)); } };
  const kb = useLearnKeys({ ui, keys, field: input, change, letters: true });
  const giveUp = () => { if (!result) setResult({ ...spellCheck(word, value), ok: false, correct: false, helped: true, gaveUp: true }); };
  const showFirst = () => { setHelped(true); setValue(now => (now ? now : word.slice(0, 1))); if (input.current) input.current.focus({ preventScroll: true }); };
  const context = maskedContext(card);
  // The letter slots on one line (slotLayout): the width of the box is measured, and the slots shrink together for a long word.
  const letters = useRef(null);
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    const el = letters.current;
    if (!el) return undefined;
    const measure = () => setRoom(el.clientWidth);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const layout = slotLayout(word.length, room);
  const rows = [];
  layout.rows.reduce((at, size) => { rows.push([at, size]); return at + size; }, 0);
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} /> : actionsRow(<>
    <Button id="h5-learn-dont-know" onClick={giveUp}>{t("I don't know")}</Button>
    <Box sx={{ flex: '1 1 auto' }} />
    <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  const slot = at => {
    const char = word[at];
    const shown = result && result.gaveUp ? char : value[at] || '';
    const tone = !result ? 'text.primary' : result.gaveUp ? 'primary.main' : result.letters[at].ok ? 'success.light' : 'error.light';
    const caret = !result && focused && at === Math.min(value.length, word.length - 1);
    return (
      <Box key={at} className="h5-learn-letter" aria-hidden="true" sx={theme => ({
        ...theme.typography.h5, fontSize: layout.font, width: layout.slot, height: layout.height, flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: tone, borderBottom: 2, borderColor: caret ? 'primary.main' : 'text.disabled',
      })}>{shown}</Box>
    );
  };
  return (
    <ViewFrame {...frame} footer={phone ? actions : null} keyboard={kb.node}>
      <Prompt label={t('Meaning')} footer={(
        <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap', alignItems: 'center', ml: -1 }}>
          {tts ? <AudioButton audio={audio} text={word} field={input} /> : null}
          <Button id="h5-learn-first" disabled={Boolean(result) || Boolean(value)} onClick={showFirst} {...keepFocus(input)}>{t('Show first letter')}</Button>
        </Box>
      )}>
        {meaning.zh ? <Typography variant="h5" component="p" lang="zh" translate="no" id="h5-learn-meaning" sx={{ mt: 0.75, overflowWrap: 'break-word' }}>{meaning.zh}</Typography> : null}
        {/* The transcription next to Hear it: the sound is offered there already, so it gives nothing more away. */}
        {tts && meaning.phonetic ? <Box sx={{ mt: 0.5 }}><Phonetic text={meaning.phonetic} id="h5-learn-phonetic" /></Box> : null}
        {meaning.state === 'loading' ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{t('Looking up the meaning…')}</Typography> : null}
        {meaning.state === 'none' ? <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>{tts ? t('No meaning found. Listen to the word instead.') : t('No meaning found for this word.')}</Typography> : null}
        {meaning.state === 'no-translator' ? <TranslatorNotice onOpen={openTranslator} sx={{ mt: 1 }} /> : null}
        {context ? <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.75 }}><Fmt template={'Used in "{1}"'} values={[context]} /></Typography> : null}
      </Prompt>
      <Box>
        <Box ref={letters} className="h5-learn-letters" translate="no" data-rows={layout.rows.length} onClick={() => { if (input.current) input.current.focus(); kb.show(); }}
          sx={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', rowGap: 1, py: 1 }}>
          {rows.map(([from, size]) => (
            <Box key={from} className="h5-learn-letter-row" sx={{ display: 'flex', flexWrap: 'nowrap', justifyContent: 'center', columnGap: `${layout.gap}px` }}>
              {Array.from({ length: size }, (_, offset) => slot(from + offset))}
            </Box>
          ))}
          <InputBase inputRef={input} value={value} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onChange={event => change(event.target.value)}
            inputProps={{ id: 'h5-learn-spell-input', 'aria-label': t('Type the word'), maxLength: word.length, readOnly: Boolean(result), ...fieldProps, ...kb.inputProps }}
            sx={{ position: 'absolute', inset: 0, opacity: 0, '& input': { height: '100%', cursor: 'text', p: 0 } }} />
        </Box>
        <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 1 }}>
          <Fmt template="{1} letters · type with the keyboard" values={[word.length]} />
        </Typography>
        {phone || result ? null : <Box sx={{ mt: 2 }}>{actions}</Box>}
      </Box>
      {result ? (
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade}>
          <WordLine word={word} phonetic={meaning.phonetic} variant="h6" className="h5-learn-word" sx={{ color: 'success.light' }} phoneticId="h5-learn-feedback-phonetic" />
          {!result.correct && value ? <Typography variant="body2" color="text.secondary"><Fmt template="You wrote: {1}" values={[value]} /></Typography> : null}
          {!result.gaveUp ? <Typography variant="body2" color="text.secondary"><Fmt template="{1} of {2} letters right" values={[result.right, result.total]} /></Typography> : null}
        </Feedback>
      ) : null}
    </ViewFrame>
  );
}

function TranslatorNotice({ onOpen, sx }) {
  return (
    <Alert severity="info" id="h5-learn-no-translator" sx={sx} action={<Button color="inherit" size="small" id="h5-learn-open-translator" onClick={onOpen}>{t('Open Settings')}</Button>}>
      {t('Word meanings need a translator. Set one up in Settings → Voice and translation.')}
    </Alert>
  );
}

// ── Build the sentence ──

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

function BuildExercise({ ui, card, cards, frame, phone, keys, tts, busy, register, onAnswer, onSkip, audio, exercise }) {
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
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} /> : actionsRow(<>
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
      <Prompt label={t('Chinese')}>
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
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade}>
          <SentenceResult card={card} result={result} />
        </Feedback>
      ) : null}
    </ViewFrame>
  );
}

// ── Dictation ──

function DictationExercise({ ui, card, frame, phone, keys, busy, register, onAnswer, onSkip, audio, exercise }) {
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
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} /> : actionsRow(<>
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
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade}>
          <SentenceResult card={card} result={result} />
        </Feedback>
      ) : null}
    </ViewFrame>
  );
}

// ── Say it ──

function SayExercise({ card, frame, phone, keys, tts, busy, register, onAnswer, onSkip, audio, exercise }) {
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
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} /> : actionsRow(<>
    {tts ? <AudioButton audio={audio} text={card.en} phone={phone} field={box} /> : null}
    <Box sx={{ flex: '1 1 auto' }} />
    {phone ? null : <Button id="h5-learn-skip" onClick={onSkip}>{t('Skip')}</Button>}
    <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  return (
    <ViewFrame {...frame} footer={phone ? actions : null}>
      <Prompt label={t('Read this aloud')}>
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
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade}>
          <SentenceResult card={card} result={result} />
        </Feedback>
      ) : null}
    </ViewFrame>
  );
}

// ── Fill the gap ──

function FillExercise({ ui, card, frame, phone, keys, tts, busy, register, onAnswer, onSkip, audio, exercise }) {
  const gap = useMemo(() => gapFor(card), [card]);
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
      set({ ...diff, correct: normWord(value) === normWord(gap.word), helped });
    },
  });
  useCardAudio(audio, exercise, card.en, result);
  // The gap word's length is known: the answer is checked by itself once that many letters are typed (Check stays for a shorter one).
  useAutoCheck({ register, ready: Boolean(gap) && typedInFull(value, gap.word), value, result });
  const change = next => { if (!result) { audio.typed(); setValue(next.replace(/\s+/g, '')); } };
  const kb = useLearnKeys({ ui, keys, field, change, letters: true });
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
  const actions = result ? <Grades suggested={suggested} onGrade={grade} busy={busy} keys={keys} /> : actionsRow(<>
    <Button id="h5-learn-first" disabled={Boolean(value)} onClick={() => { setHelped(true); setValue(gap.word.slice(0, 1)); if (field.current) field.current.focus({ preventScroll: true }); }} {...keepFocus(field)}>{t('Show first letter')}</Button>
    <Box sx={{ flex: '1 1 auto' }} />
    {phone ? null : <Button id="h5-learn-skip" onClick={onSkip}>{t('Skip')}</Button>}
    <Button id="h5-learn-check" variant="contained" disabled={!value.trim()} onClick={() => register.current.check()}>{t('Check')}</Button>
  </>);
  return (
    <ViewFrame {...frame} footer={phone ? actions : null} keyboard={kb.node}>
      <Prompt label={t('Chinese')}>
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
        <Feedback correct={result.correct} phone={phone} keys={keys} busy={busy} suggested={suggested} onGrade={grade}>
          <SentenceResult card={card} result={result} />
        </Feedback>
      ) : null}
    </ViewFrame>
  );
}

const EXERCISES = { spell: SpellExercise, build: BuildExercise, dictation: DictationExercise, say: SayExercise, fill: FillExercise };

// ── Mistakes and reports: LearnMistakes.jsx ──

// ── Your material ──

const PAGE = 50;
function MaterialView({ frame, ui }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [list, setList] = useState({ cards: [], total: 0, loading: true });
  const [editing, setEditing] = useState(null); // { id, zh }
  const load = useCallback(async (offset = 0) => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (kind !== 'all') params.set('kind', kind);
    if (query.trim()) params.set('q', query.trim());
    try {
      const data = await api('GET', `/api/learn/cards?${params}`);
      const cards = (data && data.cards) || [];
      setList(now => ({ cards: offset ? [...now.cards, ...cards] : cards, total: Number(data && data.total) || 0, loading: false }));
    } catch (failure) {
      setList(now => ({ ...now, loading: false }));
      ui.notify(errorText(failure), 'error');
    }
  }, [kind, query, ui]);
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

function SettingsView({ frame, ui, data, openTranslator }) {
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
            secondary={t('Common words of software work, 10 new ones a day. Turning it off hides the starter words you have not practised yet; nothing is deleted.')} />
          <Divider sx={{ mx: -2 }} />
          <SwitchRow inputId="h5-learn-analysis-auto" label={t('Analyze my mistakes every week')} disabled={busy} checked={current.analysis_auto !== false} onChange={on => save({ analysis_auto: on })}
            secondary={t('When a week has at least 10 new mistakes, your translation model writes a report: the causes and what to practise. Only the words and sentences you got wrong and what you wrote are sent.')} />
        </Card>
      )}
      {settings ? <AudioSettings current={current} busy={busy} save={save} /> : null}
      <Card sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">{t('Word meanings come from the translator in Settings → Voice and translation.')}</Typography>
        <Button id="h5-learn-translator-settings" sx={{ mt: 1, ml: -1 }} onClick={openTranslator}>{t('Open Settings')}</Button>
      </Card>
    </ViewFrame>
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
      <Typography variant="overline" component="h3" color="text.secondary" sx={{ mt: 1, mb: -1 }}>{t('Audio')}</Typography>
      <Card id="h5-learn-audio-card" sx={{ px: 2, py: 1 }}>
        <SwitchRow inputId="h5-learn-audio-words" label={t('Play words automatically')} disabled={busy} checked={options.words} onChange={on => save({ audio_words: on })}
          secondary={t('When a word card appears, and once more after the answer')} />
        <Divider sx={{ mx: -2 }} />
        <SwitchRow inputId="h5-learn-audio-sentences" label={t('Play sentences automatically')} disabled={busy} checked={options.sentences} onChange={on => save({ audio_sentences: on })}
          secondary={t('Dictation and Say it play at the start')} />
        <ChoiceRow id="h5-learn-audio-when" label={t('Sentences play')} secondary={t('In Build the sentence, Fill the gap and Review')} value={options.sentencesAt} disabled={busy || !options.sentences}
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

// ── How learning works ──

const HOW = [
  ['Your own sentences', 'Messages you send with "Chinese → English" become cards (the Chinese and the English), and words you tap to look up become word cards. A starter list can be added too.'],
  ['Spaced review', 'Each card comes back after 1, 3, 7, 15, 30… days; Again / Hard / Good change the gap. The due count is the plan for today.'],
  ['Five ways to practise', 'Spell the word · Build the sentence (tiles or typing) · Dictation (hear, type) · Say it (read aloud, voice input checks) · Fill the gap.'],
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
