import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Hint, MinorHeading, Section } from './Form.jsx';
import { useDeviceTarget } from './DeviceTarget.jsx';
import { copyText } from './copy-text.mjs';

// "Mac app", a part of Settings → Devices under the list of devices (`#h5-sec-mac-app`; "Server and floating window integration" in
// docs/design/mac-app.md): read only. GET /api/system/app-info, read each time the group opens: whether T-Agent.app is installed on
// this Mac (~/Applications, then /Applications) and its version against the server's, the command that builds and installs it in the
// install folder, and the web addresses of this service (the same list the app's menu bar item shows), each with a Copy button. One status
// line tells what the automatic rebuild after an update did (`autobuild`; "Automatic rebuild after an update" in docs/design/mac-app.md).
// Drawn only when the server runs on macOS (`app` is not null), in this device's tab, and not on an older server (404).
// Material Design 2 with the project theme (theme.mjs): MUI lists of one- and two-line items, Typography variants and palette paths, the theme's
// flat outlined buttons (44px targets on touch); no colours, radii or font sizes of its own.

// The server's English labels ("Local network (en0)" keeps the interface name).
export function addressLabel(label) {
  const lan = /^Local network \((.{1,40})\)$/.exec(String(label || ''));
  if (lan) return `${t('Local network')} (${lan[1]})`;
  const known = {
    'This computer': t('This computer'),
    'Remote (frp)': t('Remote (frp)'),
    'Remote (SSH tunnel)': t('Remote (SSH tunnel)'),
    'Remote (public page address)': t('Remote (public page address)'),
  };
  return known[label] || String(label || '');
}

// -1, 0 or 1 for dotted version numbers; null when either is not one.
export function compareVersions(a, b) {
  const parse = value => (/^\d+(\.\d+)*$/.test(String(value || '')) ? String(value).split('.').map(Number) : null);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// A folder as one shell word: as it is when it has only safe characters, else in single quotes.
const shellWord = value => (/^[A-Za-z0-9_./~+-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`);
export const buildCommand = installDir => `${installDir ? `cd ${shellWord(installDir)} && ` : ''}npm run build:mac-app -- --install`;

// One row of a list: a label (secondary text) and a value that can be copied (body2, monospace), with a Copy button. MD2 two-line list item.
function CopyItem({ id, label, value }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [value]);
  return (
    <ListItem disableGutters className="h5-mac-app-line" sx={{ gap: 1, alignItems: 'center' }}>
      <ListItemText
        sx={{ minWidth: 0 }}
        primary={label}
        secondary={value}
        slotProps={{
          primary: { variant: 'body2', color: 'text.secondary', className: 'h5-mac-app-label' },
          secondary: { id, component: 'code', variant: 'body2', color: 'text.primary', translate: 'no', sx: { display: 'block', fontFamily: 'monospace', overflowWrap: 'anywhere', userSelect: 'all' } },
        }}
      />
      <Button id={`${id}-copy`} size="small" sx={{ flexShrink: 0 }} onClick={async () => setCopied(await copyText(value))}>{copied ? t('Copied') : t('Copy')}</Button>
    </ListItem>
  );
}

// Whether the installed app needs no rebuild: the server's version, or built from the same shell code (`shell_current`: the web page inside it
// is always the server's, so an app whose Swift code did not change since is current).
const appCurrent = (app, serverVersion) => Boolean(app.installed && (app.matches_server || app.shell_current === true || compareVersions(app.version, serverVersion) === 0));

// The state of the installed app as [palette path, text].
function appState(app, serverVersion) {
  if (!app.installed) return ['text.secondary', t('Not installed')];
  const order = compareVersions(app.version, serverVersion);
  if (appCurrent(app, serverVersion)) return ['success.main', t('Up to date')];
  if (order === -1) return ['warning.main', t('Older than the server: rebuild it')];
  return ['warning.main', app.version ? t('Not the server’s version: rebuild it') : t('Version unknown: rebuild it')];
}

// The line of the automatic rebuild as [palette path, text], or null (idle, skipped, nothing known).
export function autobuildLine(autobuild) {
  if (!autobuild || typeof autobuild !== 'object') return null;
  const version = typeof autobuild.version === 'string' && autobuild.version ? autobuild.version : '';
  if (autobuild.state === 'waiting' || autobuild.state === 'building') return ['text.secondary', t('Rebuilding the app for this version…')];
  if (autobuild.state === 'updated') {
    return ['success.main', autobuild.restart_needed ? t(`Updated to ${version}. Quit and reopen the app to use it.`) : t(`Updated to ${version}.`)];
  }
  if (autobuild.state === 'failed') return ['error.main', t(`Could not rebuild the app: ${autobuild.reason || t('Unknown')}`)];
  return null;
}

export function MacAppSection({ opened }) {
  const { remote } = useDeviceTarget();
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (remote) return undefined;
    let alive = true;
    api('GET', '/api/system/app-info').then(answer => { if (alive) setInfo(answer && typeof answer === 'object' ? answer : null); }).catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, [opened, remote]);
  if (remote || !info || !info.app) return null;
  const { app } = info;
  const server = info.server || {};
  const [stateColor, state] = appState(app, server.version);
  const rebuildLine = app.installed ? autobuildLine(info.autobuild) : null;
  const addresses = Array.isArray(info.addresses) ? info.addresses.filter(entry => entry && typeof entry.url === 'string') : [];
  return (
    <Section id="mac-app" title="Mac app">
      <Hint>{t('T-Agent.app shows this page in a window of its own and adds a menu bar item. It uses this same service: browsers and phones keep working as before.')}</Hint>
      <List dense disablePadding id="h5-mac-app-list">
        <ListItem disableGutters id="h5-mac-app-status">
          <ListItemText
            primary={state}
            secondary={app.installed ? `${t('App')} ${app.version ? `v${app.version}` : t('Unknown')} · ${t('Server')} ${server.version ? `v${server.version}` : t('Unknown')}` : null}
            slotProps={{
              primary: { id: 'h5-mac-app-state', variant: 'body1', color: stateColor },
              secondary: { id: 'h5-mac-app-version', variant: 'body2', color: 'text.secondary', sx: { overflowWrap: 'anywhere' } },
            }}
          />
        </ListItem>
        {rebuildLine ? (
          <ListItem disableGutters id="h5-mac-app-autobuild" data-state={info.autobuild.state}>
            <ListItemText primary={rebuildLine[1]} slotProps={{ primary: { id: 'h5-mac-app-autobuild-text', variant: 'body2', color: rebuildLine[0], sx: { overflowWrap: 'anywhere' } } }} />
          </ListItem>
        ) : null}
        {app.installed && app.path ? (
          <ListItem disableGutters>
            <ListItemText primary={t('Installed at')} secondary={app.path} slotProps={{ primary: { variant: 'body2', color: 'text.secondary' }, secondary: { id: 'h5-mac-app-path', variant: 'body2', color: 'text.primary', sx: { overflowWrap: 'anywhere' } } }} />
          </ListItem>
        ) : null}
        <CopyItem id="h5-mac-app-command" label={app.installed && !appCurrent(app, server.version) ? t('Rebuild and install it in a terminal on this Mac:') : t('Build and install it in a terminal on this Mac:')} value={buildCommand(server.install_dir)} />
      </List>
      {addresses.length ? (
        <Box id="h5-mac-app-addresses" sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <MinorHeading id="h5-mac-app-addresses-title">{t('Web addresses')}</MinorHeading>
          <Hint>{t('The addresses of this service. The app, browsers and phones all use them.')}</Hint>
          <List dense disablePadding aria-labelledby="h5-mac-app-addresses-title">
            {addresses.map((entry, index) => (
              <CopyItem key={entry.url} id={`h5-mac-app-address-${index}`} label={addressLabel(entry.label)} value={entry.url} />
            ))}
          </List>
        </Box>
      ) : null}
    </Section>
  );
}
