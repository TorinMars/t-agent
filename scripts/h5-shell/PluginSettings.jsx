import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Pill, api, errorText, named, t } from './common.jsx';
import { Feedback, Hint, useFeedback } from './Form.jsx';
import { Icon } from './Icons.jsx';
import { copyText } from './Attention.jsx';
import { BASE } from './attention-feed.mjs';
import { registerAttentionSettings } from './attention-slots.mjs';
import PluginConfigForm from './PluginConfigForm.jsx';
import { listenerActivity, listenerChips, loginCommand, modesSummary, normalizePlugins, notifierChips, setupSteps } from './plugins-model.mjs';
import { canUninstall, installAction, installSummary, showManualSteps } from './plugins-model.mjs';
import { PairingDialog } from './PairingDialog.jsx';
import PluginMarket from './PluginMarket.jsx';

// The "Plugins" section of the Settings group "T-Attention": the listener and notifier plugins of this Client and their state, from
// GET /api/attention/plugins (services/attention-plugins.js). "local" in the answer is about the machine that runs this Client, not this browser.
// Read when the group opens and with the Refresh button. Plugin names, versions, descriptions and summaries are plugin content: not translated.

function Chips({ chips }) {
  if (!chips.length) return null;
  return (
    <Box className="h5-plugin-chips" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {chips.map(chip => <Pill key={chip.key} className="h5-plugin-chip" data-chip={chip.key} label={t(chip.label)} tone={chip.tone} />)}
    </Box>
  );
}

// One command with its Copy button; the command wraps on a phone and stays selectable by hand.
function Command({ id, text }) {
  const [copied, setCopied] = useState(false);
  const [feedback, say] = useFeedback();
  const copy = async () => {
    if (await copyText(text)) { setCopied(true); say(''); } else say('Could not copy. Select the text and copy it by hand', true);
  };
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
        <Box component="code" id={id} translate="no" sx={{ flex: '1 1 auto', minWidth: 0, fontSize: 13, overflowWrap: 'anywhere', userSelect: 'all' }}>{text}</Box>
        <Button size="small" variant="outlined" className="h5-plugin-copy" onClick={() => void copy()} sx={{ flex: '0 0 auto' }}>{copied ? t('Copied') : t('Copy')}</Button>
      </Box>
      <Feedback feedback={feedback} />
    </>
  );
}

function Title({ plugin }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
      <Box component="strong" translate="no" sx={{ overflowWrap: 'anywhere' }}>{plugin.name}</Box>
      {plugin.version ? <Typography variant="caption" component="span" color="text.secondary" translate="no">{plugin.version}</Typography> : null}
    </Box>
  );
}

const Secondary = ({ children, className, translate }) => (
  <Typography variant="body2" color="text.secondary" className={className} translate={translate} sx={{ overflowWrap: 'anywhere' }}>{children}</Typography>
);

// The actions of an installable listener (claude): install / update the hooks on this machine, uninstall, and a pairing code for another one.
function ListenerActions({ listener, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [feedback, say] = useFeedback();
  const action = installAction(listener);
  const run = async kind => {
    if (kind === 'uninstall' && !confirm(t('Remove the T-Attention hooks from ~/.claude/settings.json on this machine? The tokens stay; revoke them under CLI tokens.'))) return;
    setBusy(true);
    try {
      const result = await api('POST', `${BASE}/plugins/${encodeURIComponent(listener.name)}/${kind}`);
      say(kind === 'uninstall' ? t('The hooks were removed.') : installSummary(result, { t }));
      onChanged();
    } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
    finally { setBusy(false); }
  };
  return (
    <Box className="h5-plugin-actions" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 0.5 }}>
      {listener.local.autoTerminal ? <Secondary className="h5-plugin-auto">{t('Connects automatically in T-Agent terminals')}</Secondary> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {action ? <Button variant="contained" size="small" className="h5-plugin-install" disabled={busy} onClick={() => void run('install')}>{action === 'update' ? t('Update the hooks') : t('Install on this machine')}</Button> : null}
        <Button variant="outlined" size="small" className="h5-plugin-pair" disabled={busy} onClick={() => setPairing(true)}>{t('Another machine…')}</Button>
        {canUninstall(listener) ? <Button size="small" className="h5-plugin-uninstall" disabled={busy} onClick={() => void run('uninstall')}>{t('Uninstall')}</Button> : null}
      </Box>
      <Feedback feedback={feedback} />
      <PairingDialog open={pairing} onClose={() => setPairing(false)} onPaired={onChanged} />
    </Box>
  );
}

function ListenerRow({ listener, onChanged }) {
  const steps = showManualSteps(listener) ? setupSteps(listener) : { login: false, sync: false };
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return (
    <Paper variant="outlined" className="h5-plugin h5-plugin-listener" data-name={listener.name} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.25 }}>
      <Title plugin={listener} />
      {listener.description ? <Secondary translate="no">{listener.description}</Secondary> : null}
      <Chips chips={listenerChips(listener)} />
      {listener.error ? <Typography variant="body2" color="error" className="h5-plugin-error" sx={{ overflowWrap: 'anywhere' }}>{t(listener.error)}</Typography> : null}
      {listener.local ? <Secondary className="h5-plugin-activity">{listenerActivity(listener, { t })}</Secondary> : null}
      {listener.local && listener.local.installable && !listener.error ? <ListenerActions listener={listener} onChanged={onChanged} /> : null}
      {listener.local && (steps.login || steps.sync) ? (
        <Box className="h5-plugin-steps" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 0.5 }}>
          <Secondary>{t('To use it on the machine that runs this Client:')}</Secondary>
          {steps.login ? (
            <>
              <Secondary>{t('1. Create a token under CLI tokens above.')}</Secondary>
              <Secondary>{t('2. Log in with it (put the token in place of <token>):')}</Secondary>
              <Command id={`h5-plugin-login-${listener.name}`} text={loginCommand(origin)} />
            </>
          ) : null}
          {steps.sync ? (
            <>
              <Secondary>{steps.login ? t('3. Run ta once, so the hooks are synced:') : t('Run ta once, so the hooks are synced:')}</Secondary>
              <Command id={`h5-plugin-sync-${listener.name}`} text="ta" />
            </>
          ) : null}
        </Box>
      ) : null}
    </Paper>
  );
}

function NotifierRow({ notifier, onChanged }) {
  const modes = modesSummary(notifier.statuses, { t });
  return (
    <Paper variant="outlined" className="h5-plugin h5-plugin-notifier" data-name={notifier.name} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.25 }}>
      <Title plugin={notifier} />
      {notifier.description ? <Secondary translate="no">{notifier.description}</Secondary> : null}
      <Chips chips={notifierChips(notifier)} />
      {notifier.error ? <Typography variant="body2" color="error" className="h5-plugin-error" sx={{ overflowWrap: 'anywhere' }}>{t(notifier.error)}</Typography> : null}
      {notifier.summary ? <Secondary className="h5-plugin-summary" translate="no">{notifier.summary}</Secondary> : null}
      {modes ? <Secondary className="h5-plugin-modes">{modes}</Secondary> : null}
      {notifier.loaded !== false ? <PluginConfigForm notifier={notifier} onChanged={onChanged} /> : null}
    </Paper>
  );
}

function PluginList({ id, title, empty, children }) {
  return (
    <Box id={id} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle2" component="strong">{t(title)}</Typography>
      {children.length ? children : <Hint>{t(empty)}</Hint>}
    </Box>
  );
}

// The two tabs of the section: the overview of this Client's plugins, and the marketplace (PluginMarket.jsx, drawn once it is first chosen).
const TABS = [{ key: 'installed', label: 'Installed' }, { key: 'market', label: 'Marketplace' }];
function Tabs({ tab, onTab }) {
  return (
    <Box role="tablist" aria-label={t('Plugins')} sx={{ display: 'flex', gap: 0.5, borderBottom: 1, borderColor: 'divider' }}>
      {TABS.map(entry => (
        <Button
          key={entry.key} id={`h5-plugins-tab-${entry.key}`} role="tab" aria-selected={tab === entry.key ? 'true' : 'false'} aria-controls={`h5-plugins-panel-${entry.key}`}
          onClick={() => onTab(entry.key)} color={tab === entry.key ? 'primary' : 'inherit'}
          sx={{ borderRadius: 0, px: 1.5, mb: '-1px', borderBottom: 2, borderColor: tab === entry.key ? 'primary.main' : 'transparent', fontWeight: tab === entry.key ? 700 : 500 }}
        >{t(entry.label)}</Button>
      ))}
    </Box>
  );
}

function PluginSlot({ opened }) {
  const [tab, setTab] = useState('installed');
  const [marketShown, setMarketShown] = useState(false);
  const [marketRefresh, setMarketRefresh] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    setLoading(true);
    try { setData(normalizePlugins(await api('GET', `${BASE}/plugins`))); say(''); }
    catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group is opened
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mt: 1 }}>
        <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700 }}>{t('Plugins')}</Typography>
        <IconButton id="h5-plugins-refresh" size="small" disabled={loading || !opened} onClick={() => { void load(); setMarketRefresh(n => n + 1); }} {...named(t('Refresh'))} sx={{ mr: -0.5 }}><Icon name="reload" size={20} /></IconButton>
      </Box>
      <Tabs tab={tab} onTab={key => { setTab(key); if (key === 'market') setMarketShown(true); }} />
      <Box id="h5-plugins-panel-installed" role="tabpanel" aria-labelledby="h5-plugins-tab-installed" hidden={tab !== 'installed'} sx={{ display: tab === 'installed' ? 'flex' : 'none', flexDirection: 'column', gap: 1.5 }}>
      <Hint>{t('Listeners report what the agents do; notifiers send the reminders. The checks are about the machine that runs this Client.')}</Hint>
      <Box id="h5-plugins" aria-busy={loading ? 'true' : 'false'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {!data && loading ? <Hint id="h5-plugins-loading">{t('Loading…')}</Hint> : null}
        {data ? (
          <>
            <PluginList id="h5-plugins-listeners" title="Listeners" empty="No listener plugins found">
              {data.listeners.map(listener => <ListenerRow key={listener.name} listener={listener} onChanged={() => void load()} />)}
            </PluginList>
            <PluginList id="h5-plugins-notifiers" title="Notifiers" empty="No notifier plugins found">
              {data.notifiers.map(notifier => <NotifierRow key={notifier.name} notifier={notifier} onChanged={load} />)}
            </PluginList>
          </>
        ) : null}
      </Box>
      <Feedback id="h5-plugins-feedback" feedback={feedback} />
      </Box>
      <Box id="h5-plugins-panel-market" role="tabpanel" aria-labelledby="h5-plugins-tab-market" hidden={tab !== 'market'} sx={{ display: tab === 'market' ? 'block' : 'none' }}>
        {marketShown && opened ? <PluginMarket refresh={marketRefresh} onChanged={() => void load()} /> : null}
      </Box>
    </>
  );
}

registerAttentionSettings({ id: 'plugins', order: 50, Component: PluginSlot });
