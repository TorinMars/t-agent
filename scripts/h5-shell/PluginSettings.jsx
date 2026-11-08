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
import { listenerActivity, listenerChips, loginCommand, modesSummary, normalizePlugins, notifierChips, setupSteps } from './plugins-model.mjs';

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

function ListenerRow({ listener }) {
  const steps = setupSteps(listener);
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return (
    <Paper variant="outlined" className="h5-plugin h5-plugin-listener" data-name={listener.name} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.25 }}>
      <Title plugin={listener} />
      {listener.description ? <Secondary translate="no">{listener.description}</Secondary> : null}
      <Chips chips={listenerChips(listener)} />
      {listener.error ? <Typography variant="body2" color="error" className="h5-plugin-error" sx={{ overflowWrap: 'anywhere' }}>{t(listener.error)}</Typography> : null}
      {listener.local ? <Secondary className="h5-plugin-activity">{listenerActivity(listener, { t })}</Secondary> : null}
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

function NotifierRow({ notifier }) {
  const modes = modesSummary(notifier.statuses, { t });
  return (
    <Paper variant="outlined" className="h5-plugin h5-plugin-notifier" data-name={notifier.name} sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, p: 1.25 }}>
      <Title plugin={notifier} />
      {notifier.description ? <Secondary translate="no">{notifier.description}</Secondary> : null}
      <Chips chips={notifierChips(notifier)} />
      {notifier.error ? <Typography variant="body2" color="error" className="h5-plugin-error" sx={{ overflowWrap: 'anywhere' }}>{t(notifier.error)}</Typography> : null}
      {notifier.summary ? <Secondary className="h5-plugin-summary" translate="no">{notifier.summary}</Secondary> : null}
      {modes ? <Secondary className="h5-plugin-modes">{modes}</Secondary> : null}
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

function PluginSlot({ opened }) {
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
        <IconButton id="h5-plugins-refresh" size="small" disabled={loading || !opened} onClick={() => void load()} {...named(t('Refresh'))} sx={{ mr: -0.5 }}><Icon name="reload" size={20} /></IconButton>
      </Box>
      <Hint>{t('Listeners report what the agents do; notifiers send the reminders. The checks are about the machine that runs this Client.')}</Hint>
      <Box id="h5-plugins" aria-busy={loading ? 'true' : 'false'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {!data && loading ? <Hint id="h5-plugins-loading">{t('Loading…')}</Hint> : null}
        {data ? (
          <>
            <PluginList id="h5-plugins-listeners" title="Listeners" empty="No listener plugins found">
              {data.listeners.map(listener => <ListenerRow key={listener.name} listener={listener} />)}
            </PluginList>
            <PluginList id="h5-plugins-notifiers" title="Notifiers" empty="No notifier plugins found">
              {data.notifiers.map(notifier => <NotifierRow key={notifier.name} notifier={notifier} />)}
            </PluginList>
          </>
        ) : null}
      </Box>
      <Feedback id="h5-plugins-feedback" feedback={feedback} />
    </>
  );
}

registerAttentionSettings({ id: 'plugins', order: 50, Component: PluginSlot });
