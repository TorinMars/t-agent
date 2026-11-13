import { useEffect, useState } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { Pill, api, errorText, named, t } from './common.jsx';
import { Feedback, Hint, useFeedback } from './Form.jsx';
import { Icon } from './Icons.jsx';
import { copyText } from './Attention.jsx';
import { BASE } from './attention-feed.mjs';
import { registerAttentionSettings, setAttentionPluginPageOpener } from './attention-slots.mjs';
import PluginConfigForm from './PluginConfigForm.jsx';
import { NotifierRules, TelegramSetup } from './NotifierSettings.jsx';
import { KIND_LABELS } from './market-model.mjs';
import { RULES_PAGE, findPlugin, listenerActivity, listenerChips, loginCommand, modesSummary, normalizePlugins, notifierChips, pageKey, pluginRow, setupSteps } from './plugins-model.mjs';
import { canUninstall, installAction, installSummary, showManualSteps } from './plugins-model.mjs';
import { PairingDialog } from './PairingDialog.jsx';
import PluginMarket from './PluginMarket.jsx';
import { ScopeLabel, ScopedHeading } from './ScopeLabel.jsx';
import { OwnPageNote, useDeviceTarget, useSettingsTab } from './DeviceTarget.jsx';

// The "Plugins" section of the Settings group "T-Attention", in two levels. The list: one compact row per plugin of this Client (name, kind, chips and one
// short line), from GET /api/attention/plugins (services/attention-plugins.js), read when the group opens, with the Refresh button and on the way back from
// a page; a row reads nothing of its own. The page: a tap opens that plugin's page over the sheet (a MUI modal, so Escape and the phone's back button close
// it through back.mjs, and the list keeps its tab and scroll position underneath): its forms, login and actions, which read their data only while it is open.
// "local" in the answer is about the machine that runs this Client, not this browser. Plugin names, versions, descriptions and summaries are plugin content: not translated.

function Chips({ chips }) {
  if (!chips.length) return null;
  return (
    <Box component="span" className="h5-plugin-chips" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
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

// The name is the page's heading; the version goes under it.
const Version = ({ plugin }) => (plugin.version ? <Typography variant="caption" component="span" color="text.secondary" className="h5-plugin-version" translate="no">{plugin.version}</Typography> : null);

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

function ListenerPage({ listener, onChanged }) {
  const steps = showManualSteps(listener) ? setupSteps(listener) : { login: false, sync: false };
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return (
    <>
      <Version plugin={listener} />
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
              <Secondary>{t('1. Create a token under CLI tokens in Settings \u2192 T-Attention.')}</Secondary>
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
    </>
  );
}

function NotifierPage({ notifier, onChanged, onLogin, onRules }) {
  const modes = modesSummary(notifier.statuses, { t });
  return (
    <>
      <Version plugin={notifier} />
      {notifier.description ? <Secondary translate="no">{notifier.description}</Secondary> : null}
      <Chips chips={notifierChips(notifier)} />
      {notifier.error ? <Typography variant="body2" color="error" className="h5-plugin-error" sx={{ overflowWrap: 'anywhere' }}>{t(notifier.error)}</Typography> : null}
      {notifier.summary ? <Secondary className="h5-plugin-summary" translate="no">{notifier.summary}</Secondary> : null}
      {modes ? <Secondary className="h5-plugin-modes">{modes}</Secondary> : null}
      {/* The section the page draws itself (manifest `customUi`): Telegram's login; the generic form follows it. */}
      {notifier.name === 'telegram' && notifier.loaded !== false ? <TelegramSetup onChanged={onChanged} onLogin={onLogin} /> : null}
      {notifier.loaded !== false ? <PluginConfigForm notifier={notifier} onChanged={onChanged} onRules={onRules} /> : null}
    </>
  );
}

// The second level, drawn over the Settings sheet with the same size and place. It is its own modal (see the top of this file); without an animation, so
// leaving ends what the page runs (the Telegram QR polling) at once. A tap beside the sheet goes back, as it closes the sheet on the first level.
const SHEET = { width: 'min(440px, 100%)', maxWidth: '100%', height: '92dvh', mx: 'auto', borderRadius: '16px 16px 0 0', backgroundImage: 'none' };
function PluginPage({ page, data, onBack, onChanged, onLogin, onRules }) {
  const titleId = `h5-plugin-page-title-${pageKey(page)}`;
  const plugin = findPlugin(data, page);
  const rules = page.kind === RULES_PAGE.kind;
  return (
    <Drawer
      anchor="bottom" open transitionDuration={0} onClose={onBack} className="h5-plugin-page" data-kind={page.kind} data-name={page.name} aria-labelledby={titleId}
      slotProps={{ backdrop: { invisible: true }, paper: { className: 'h5-sheet-panel', sx: SHEET } }}
    >
      <AppBar position="static" color="default" enableColorOnDark elevation={0} className="h5-sheet-header" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" disableGutters sx={{ gap: 0.5, px: 1 }}>
          <IconButton className="h5-plugin-page-back" onClick={onBack} {...named(t('Back'))}><Icon name="back" size={22} /></IconButton>
          <Typography id={titleId} className="h5-plugin-page-title" variant="h6" component="h2" noWrap translate={rules ? undefined : 'no'} sx={{ flex: '1 1 auto', minWidth: 0 }}>{rules ? t('Message and call rules') : page.name}</Typography>
        </Toolbar>
      </AppBar>
      <Box className="h5-plugin-page-body" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1.25, p: 2 }}>
        <PageScope page={page} />
        {rules ? <NotifierRules onChanged={onChanged} /> : null}
        {!rules && !data ? <Hint>{t('Loading…')}</Hint> : null}
        {!rules && data && !plugin ? <Hint>{t('This plugin was not found on this Client.')}</Hint> : null}
        {plugin && page.kind === 'listener' ? <ListenerPage listener={plugin} onChanged={onChanged} /> : null}
        {plugin && page.kind === 'notifier' ? <NotifierPage notifier={plugin} onChanged={onChanged} onLogin={onLogin} onRules={onRules} /> : null}
      </Box>
    </Drawer>
  );
}

// The scope label at the top of a plugin's page: the rules and the notifiers are shared, Telegram is sent through one device, a listener is set up on
// this machine (ScopeLabel.jsx).
function PageScope({ page }) {
  if (page.kind === RULES_PAGE.kind) return <ScopeLabel id="notify-rules" scope="shared" sx={{ alignSelf: 'flex-start' }} />;
  if (page.kind === 'notifier' && page.name === 'telegram') return <ScopeLabel id="telegram" scope="telegram" sx={{ alignSelf: 'flex-start' }} />;
  if (page.kind === 'notifier') return <ScopeLabel id="notifier-plugins" scope="shared" sx={{ alignSelf: 'flex-start' }} />;
  return <ScopeLabel sx={{ alignSelf: 'flex-start' }} />;
}

// One row of the list: a real button (keyboard focus, ripple) with a chevron; everything inside is phrasing content.
const ROW_LOOK = {
  width: '100%', minHeight: 56, justifyContent: 'flex-start', textAlign: 'left', gap: 1, p: 1.25, border: 1, borderColor: 'divider', borderRadius: 1,
  '&:hover': { bgcolor: 'action.hover' }, '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 1 },
};
const RowText = ({ children }) => <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>{children}</Box>;
const Chevron = () => <Box component="span" aria-hidden="true" sx={{ flex: '0 0 auto', display: 'inline-flex', color: 'text.secondary' }}><Icon name="treeChevron" size={16} /></Box>;
const RowLine = ({ children, color = 'text.secondary', className, translate }) => <Typography variant="body2" component="span" color={color} className={className} translate={translate} sx={{ overflowWrap: 'anywhere' }}>{children}</Typography>;

function PluginRow({ kind, plugin, loggingIn, onOpen }) {
  const row = pluginRow(kind, plugin, { t, loggingIn });
  return (
    <ButtonBase className={`h5-plugin h5-plugin-${kind}`} data-name={plugin.name} onClick={onOpen} sx={ROW_LOOK}>
      <RowText>
        <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <Box component="strong" translate="no" sx={{ overflowWrap: 'anywhere' }}>{plugin.name}</Box>
          <Typography variant="caption" component="span" color="text.secondary" className="h5-plugin-kind">{t(KIND_LABELS[kind])}</Typography>
          {kind === 'notifier' && plugin.name === 'telegram' ? <ScopeLabel id="telegram" scope="telegram" /> : null}
        </Box>
        <Chips chips={row.chips} />
        {row.error ? <RowLine color="error" className="h5-plugin-error">{t(row.error)}</RowLine> : null}
        {!row.error && row.line ? <RowLine className={kind === 'listener' ? 'h5-plugin-activity' : 'h5-plugin-summary'} translate={kind === 'listener' ? undefined : 'no'}>{row.line}</RowLine> : null}
      </RowText>
      <Chevron />
    </ButtonBase>
  );
}

function PluginList({ id, title, empty, label = null, children }) {
  return (
    <Box id={id} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <ScopedHeading label={label}><Typography variant="subtitle2" component="strong">{t(title)}</Typography></ScopedHeading>
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

// With the tabs of the sheet (SettingsTabs.jsx) the list is split: Shared holds the notifiers and their rules; a device tab holds the listeners and the
// marketplace (plugins are installed on this machine), and a linked device's tab only says to open that device's own page for them.
function PluginSlot({ ui, opened }) {
  const device = useDeviceTarget(); // the listeners are each device's own: in a linked device's tab they are changed on its own page
  const { scope } = useSettingsTab();
  const listeners = scope !== 'shared';
  const notifiers = scope !== 'device';
  const market = scope === null || (scope === 'device' && !device.remote);
  const [tab, setTab] = useState('installed');
  const [pages, setPages] = useState([]); // the open pages; more than one when the rules are opened from a notifier's page
  const [loggingIn, setLoggingIn] = useState(false); // a Telegram login was left half way: the row says so (the server keeps it until it times out)
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
  // The first-run guide opens a plugin's page directly (attention-slots.mjs).
  useEffect(() => setAttentionPluginPageOpener(page => { setPages([page]); return true; }), []);
  // A page lives on top of the sheet: it cannot stay behind when the sheet closes by itself.
  useEffect(() => ui.subscribe(() => { if (!ui.get().settingsOpen) setPages(current => (current.length ? [] : current)); }), [ui]);
  const open = page => setPages(current => [...current, page]);
  const back = () => { setPages(current => current.slice(0, -1)); void load(); };
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mt: 1 }}>
        <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700 }}>{t('Plugins')}</Typography>
        <IconButton id="h5-plugins-refresh" size="small" disabled={loading || !opened} onClick={() => { void load(); setMarketRefresh(n => n + 1); }} {...named(t('Refresh'))} sx={{ mr: -0.5 }}><Icon name="reload" size={20} /></IconButton>
      </Box>
      {market ? <Tabs tab={tab} onTab={key => { setTab(key); if (key === 'market') setMarketShown(true); }} /> : null}
      <Box id="h5-plugins-panel-installed" role={market ? 'tabpanel' : undefined} aria-labelledby={market ? 'h5-plugins-tab-installed' : undefined} hidden={market && tab !== 'installed'} sx={{ display: !market || tab === 'installed' ? 'flex' : 'none', flexDirection: 'column', gap: 1.5 }}>
      <Hint>{t('Listeners report what the agents do; notifiers send the reminders. The checks are about the machine that runs this Client.')}</Hint>
      <Box id="h5-plugins" aria-busy={loading ? 'true' : 'false'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {!data && loading ? <Hint id="h5-plugins-loading">{t('Loading…')}</Hint> : null}
        {data ? (
          <>
            {listeners ? (
              <PluginList id="h5-plugins-listeners" title="Listeners" empty="No listener plugins found" label={<ScopeLabel />}>
                {device.remote ? [<OwnPageNote key="remote" id="h5-plugins-listeners-remote" />]
                  : data.listeners.map(listener => <PluginRow key={listener.name} kind="listener" plugin={listener} onOpen={() => open({ kind: 'listener', name: listener.name })} />)}
              </PluginList>
            ) : null}
            {notifiers ? (
              <PluginList id="h5-plugins-notifiers" title="Notifiers" empty="No notifier plugins found" label={<ScopeLabel id="notifier-plugins" scope="shared" />}>
                {data.notifiers.map(notifier => <PluginRow key={notifier.name} kind="notifier" plugin={notifier} loggingIn={notifier.name === 'telegram' && loggingIn} onOpen={() => open({ kind: 'notifier', name: notifier.name })} />)}
              </PluginList>
            ) : null}
            {notifiers ? (
              <Box id="h5-plugins-rules" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <ScopedHeading label={<ScopeLabel id="notify-rules" scope="shared" />}><Typography variant="subtitle2" component="strong">{t('Rules for all notifiers')}</Typography></ScopedHeading>
                <ButtonBase id="h5-plugins-rules-open" className="h5-plugin-rules" onClick={() => open(RULES_PAGE)} sx={ROW_LOOK}>
                  <RowText>
                    <Box component="strong">{t('Message and call rules')}</Box>
                    <RowLine>{t('When to notify, quiet hours, hourly limits, page address')}</RowLine>
                  </RowText>
                  <Chevron />
                </ButtonBase>
              </Box>
            ) : null}
          </>
        ) : null}
      </Box>
      <Feedback id="h5-plugins-feedback" feedback={feedback} />
      </Box>
      {market ? (
        <Box id="h5-plugins-panel-market" role="tabpanel" aria-labelledby="h5-plugins-tab-market" hidden={tab !== 'market'} sx={{ display: tab === 'market' ? 'block' : 'none' }}>
          {marketShown && opened ? <PluginMarket refresh={marketRefresh} onChanged={() => void load()} /> : null}
        </Box>
      ) : null}
      {pages.map(page => <PluginPage key={pageKey(page)} page={page} data={data} onBack={back} onChanged={load} onLogin={setLoggingIn} onRules={() => open(RULES_PAGE)} />)}
    </>
  );
}

registerAttentionSettings({ id: 'plugins', order: 30, Component: PluginSlot }); // before the agent skill (40): the notifiers come right after the reminders
