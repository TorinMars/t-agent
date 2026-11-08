import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { api, errorText, named, t } from './common.jsx';
import { Feedback, useFeedback } from './Form.jsx';
import { Icon } from './Icons.jsx';
import { BASE, playSound } from './attention-feed.mjs';
import { installAction, installSummary } from './plugins-model.mjs';
import { claudeListener, doneLine, guideState, normalizeGuide, telegramNotifier, testableNotifiers } from './guide-model.mjs';
import { PairingDialog } from './PairingDialog.jsx';
import { TOUCH } from './theme.mjs';

// The T-Attention first-run guide: three steps (Connect Claude, Choose notifications, Send a test) at the top of the T-Attention panel
// (Attention.jsx, place "panel") and of Settings → T-Attention (AttentionSettings.jsx, place "settings"). Each step's done state comes from
// GET /api/attention/plugins and GET /api/attention/settings/guide (guide-model.mjs); the flags the overview cannot see (closed, "page only",
// paired, a test worked) are saved with PUT /api/attention/settings/guide. It reuses the existing calls: the one-click install
// (POST /plugins/claude/install), the pairing dialog, the notifier test (POST /plugins/:name/test) and this page's reminders (ui.actions.attention*).
// It draws nothing until both reads worked, so a Client without the guide route shows the page as before. See "T-Attention first-run guide" in DESIGN.md.

const SMALL = { [TOUCH]: { minHeight: 44, minWidth: 44 } };

// Settings → T-Attention, opened and scrolled to the notifier settings (the Telegram login). From the panel on a phone the sheet closes first.
function openNotifierSettings(ui, place) {
  const scroll = () => {
    const node = document.getElementById('h5-notifier-settings');
    if (node && node.scrollIntoView) node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return Boolean(node);
  };
  if (place === 'settings') { scroll(); return; }
  if (!ui.get().wide && ui.actions.closeAttention) ui.actions.closeAttention();
  ui.actions.openSettings();
  let tries = 0;
  const step = () => {
    tries += 1;
    const summary = document.querySelector('#h5-set-attention .MuiAccordionSummary-root');
    if (summary && summary.getAttribute('aria-expanded') !== 'true') summary.click();
    if (summary && document.querySelector('#h5-set-attention .MuiCollapse-entered') && scroll()) return;
    if (tries < 40) setTimeout(step, 75);
  };
  setTimeout(step, 0);
}

function StepHead({ step, index, open, onToggle }) {
  return (
    <ButtonBase
      className="h5-guide-step-head" aria-expanded={open ? 'true' : 'false'} onClick={onToggle}
      sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, minHeight: 36, px: 0.5, borderRadius: 1, textAlign: 'left', [TOUCH]: { minHeight: 44 } }}
    >
      <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', color: step.done ? 'success.main' : 'text.secondary' }}><Icon name={step.done ? 'attentionDone' : 'attentionOpen'} size={20} /></Box>
      <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, fontSize: 14, fontWeight: open ? 600 : 500 }}>
        {`${index + 1}. ${t(step.title)}`}
        <Box component="span" className="h5-guide-step-state" sx={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{` (${t(step.done ? 'Done' : 'Not done')})`}</Box>
      </Box>
    </ButtonBase>
  );
}

const Line = ({ children, className }) => <Typography variant="body2" color="text.secondary" className={className} sx={{ overflowWrap: 'anywhere' }}>{children}</Typography>;
const Actions = ({ children }) => <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>{children}</Box>;

function ClaudeStep({ overview, busy, run, onPair }) {
  const listener = claudeListener(overview);
  const action = installAction(listener);
  return (
    <>
      <Line>{t('Claude Code tells T-Attention when a session needs you or is done.')}</Line>
      {listener && listener.local && listener.local.autoTerminal ? <Line>{t('Connects automatically in T-Agent terminals')}</Line> : null}
      <Actions>
        {action ? <Button id="h5-guide-install" size="small" variant="contained" disabled={busy} sx={SMALL}
          onClick={() => void run(async () => installSummary(await api('POST', `${BASE}/plugins/claude/install`), { t }))}>{action === 'update' ? t('Update the hooks') : t('Install on this machine')}</Button> : null}
        <Button id="h5-guide-pair" size="small" variant="outlined" disabled={busy} sx={SMALL} onClick={onPair}>{t('Another machine…')}</Button>
      </Actions>
      {!listener ? <Line>{t('The claude listener plugin was not found on this Client.')}</Line> : null}
    </>
  );
}

function NotifyStep({ ui, place, overview, prefs, setPrefs, busy, run, save }) {
  const telegram = telegramNotifier(overview);
  const allow = async () => {
    const next = await ui.actions.attentionSetNotify(true);
    setPrefs(next);
    if (next.permission === 'denied') return { error: 'The browser blocks notifications for this page. Allow them in the browser’s site settings.' };
    return next.notify ? 'System notifications are on' : '';
  };
  return (
    <>
      <Line>{t('Get a Telegram message or call when a task needs you, or use only this page.')}</Line>
      <Actions>
        {prefs.permission !== 'unsupported' && !prefs.notify ? <Button id="h5-guide-allow" size="small" variant="outlined" disabled={busy} sx={SMALL} onClick={() => void run(allow)}>{t('Allow system notifications')}</Button> : null}
        {telegram ? <Button id="h5-guide-telegram" size="small" variant="contained" disabled={busy} sx={SMALL} onClick={() => openNotifierSettings(ui, place)}>{t('Set up Telegram')}</Button> : null}
        <Button id="h5-guide-page-only" size="small" variant="outlined" disabled={busy} sx={SMALL} onClick={() => void run(async () => { await save({ pageOnly: true }); return ''; })}>{t('Page and system notifications only')}</Button>
      </Actions>
      {prefs.notify ? <Line className="h5-guide-notify-on">{t('System notifications are on')}</Line> : null}
    </>
  );
}

function TestStep({ ui, overview, prefs, busy, run, save }) {
  const notifiers = testableNotifiers(overview);
  const testNotifier = name => run(async () => {
    const result = await api('POST', `${BASE}/plugins/${encodeURIComponent(name)}/test`);
    if (!result || !result.ok) return { error: `${t('Test failed')}: ${t((result && result.message) || '')}` };
    await save({ tested: true });
    return t((result && result.message) || 'Test sent');
  });
  const testPage = () => run(async () => {
    ui.notify(t('T-Attention test: reminders on this page work'), 'success');
    if (prefs.sound) playSound();
    if (prefs.notify && ui.actions.attentionTestNotify) ui.actions.attentionTestNotify();
    await save({ tested: true });
    return '';
  });
  return (
    <>
      <Line>{t('Send one test to see that a reminder reaches you.')}</Line>
      <Actions>
        {notifiers.map(notifier => (
          <Button key={notifier.name} size="small" variant="contained" className="h5-guide-test" data-name={notifier.name} disabled={busy} sx={SMALL} onClick={() => void testNotifier(notifier.name)}>
            {t('Test')} <Box component="span" translate="no" sx={{ ml: 0.5 }}>{notifier.name}</Box>
          </Button>
        ))}
        <Button id="h5-guide-test-page" size="small" variant={notifiers.length ? 'outlined' : 'contained'} disabled={busy} sx={SMALL} onClick={() => void testPage()}>{t('Test this page')}</Button>
      </Actions>
    </>
  );
}

export function AttentionGuide({ ui, place = 'panel', active }) {
  const [overview, setOverview] = useState(null);
  const [guide, setGuide] = useState(null);
  const [forced, setForced] = useState(false); // "Show setup guide" was tapped: shown even when all steps are done
  const [picked, setPicked] = useState(null); // the step the person opened (null: the first open step)
  const [pairing, setPairing] = useState(false); // the pairing dialog; kept here so it stays open when step 1 turns done
  const [stay, setStay] = useState(false); // drawn once while this panel or group is open: it stays to say "All set" after the last step
  const [prefs, setPrefs] = useState(() => (ui.actions.attentionPrefs ? ui.actions.attentionPrefs() : { sound: true, notify: false, permission: 'unsupported' }));
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try {
      const [plugins, flags] = await Promise.all([api('GET', `${BASE}/plugins`), api('GET', `${BASE}/settings/guide`)]);
      setOverview(plugins || {});
      setGuide(normalizeGuide(flags));
    } catch { setOverview(null); setGuide(null); }
  };
  useEffect(() => {
    if (!active) { setStay(false); setForced(false); return; }
    if (ui.actions.attentionPrefs) setPrefs(ui.actions.attentionPrefs());
    void load();
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the panel or the group opens
  const save = async patch => setGuide(normalizeGuide(await api('PUT', `${BASE}/settings/guide`, patch)));
  // Runs one action: its answer is the line to show (a string, or { error }); the steps are read again afterwards.
  const run = async work => {
    setBusy(true);
    try {
      const said = await work();
      setPicked(null);
      await load();
      if (said && typeof said === 'object') say(said.error, true); else say(said || '');
    } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
    finally { setBusy(false); }
  };
  const state = overview && guide ? guideState(overview, guide) : null;
  useEffect(() => { if (state && state.show) setStay(true); }, [state && state.show]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!state) return null;
  const show = async () => { setForced(true); setPicked(null); if (state.dismissed) { try { await save({ dismissed: false }); } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); } } };
  const hide = async () => { setForced(false); setStay(false); try { await save({ dismissed: true }); } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); } };

  // The pairing dialog for "Another machine…": the claim marks step 1 done (PUT { paired }) and the dialog shows "Connected" until it is closed.
  const dialog = <PairingDialog open={pairing} onClose={() => setPairing(false)} onPaired={() => void run(async () => { await save({ paired: true }); return 'Connected'; })} />;
  if (!state.show && !forced && !(stay && state.allDone && !state.dismissed)) {
    if (place !== 'settings') return dialog;
    return <>{dialog}<Button id="h5-guide-show" size="small" sx={{ alignSelf: 'flex-start', ...SMALL }} onClick={() => void show()}>{t('Show setup guide')}</Button></>;
  }
  const openKey = picked || state.current;
  const props = { ui, place, overview, prefs, setPrefs, busy, run, save };
  return (
    <Paper
      id={place === 'settings' ? 'h5-guide-settings' : 'h5-guide'} className="h5-guide" data-place={place} variant="outlined" component="section" aria-labelledby={`h5-guide-title-${place}`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: { xs: 1.25, sm: 1.5 }, m: place === 'panel' ? { xs: 1, sm: 1.5 } : 0, mt: place === 'settings' ? 1 : undefined, backgroundImage: 'none' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography id={`h5-guide-title-${place}`} variant="subtitle2" component="h3" sx={{ fontWeight: 700, flex: '1 1 auto', minWidth: 0 }}>{t('Set up T-Attention')}</Typography>
        <Typography variant="caption" color="text.secondary" className="h5-guide-count" translate="no">{`${state.doneCount}/${state.total}`}</Typography>
        <IconButton id={`h5-guide-close-${place}`} className="h5-guide-close" size="small" onClick={() => void hide()} {...named(t('Hide setup guide'))} sx={SMALL}><Icon name="close" size={20} /></IconButton>
      </Box>
      {state.allDone ? <Line className="h5-guide-all-done">{t('All set. Reminders reach you when a task needs you.')}</Line> : null}
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        {state.steps.map((step, index) => {
          const open = step.key === openKey;
          return (
            <Box component="li" key={step.key} className="h5-guide-step" data-step={step.key} data-done={step.done ? 'true' : 'false'}>
              <StepHead step={step} index={index} open={open} onToggle={() => setPicked(open ? '-' : step.key)} />
              {open ? (
                <Box className="h5-guide-step-body" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, pl: 3.75, pb: 0.75 }}>
                  {step.done ? <Line className="h5-guide-done-line">{t(doneLine(step))}</Line> : null}
                  {step.key === 'claude' ? <ClaudeStep {...props} onPair={() => setPairing(true)} /> : null}
                  {step.key === 'notify' ? <NotifyStep {...props} /> : null}
                  {step.key === 'test' ? <TestStep {...props} /> : null}
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Feedback id={`h5-guide-feedback-${place}`} feedback={feedback} />
      {dialog}
    </Paper>
  );
}
