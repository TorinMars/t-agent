// "Open in VS Code": the launch from the session header's More ("Page" in docs/design/vscode-web-proxy.md). A chunk of its own (screen-vscode.jsx),
// loaded by lazy-screens.jsx `openVscode`, which has already, inside the click, made sure this session has no launch going and opened the blank tab.
//
// - POST start on the session's engine (this one: /api/tasks/:id/terminals/:terminalId/vscode; a remote one: /api/remote-servers/:id/tasks/…), then
//   GET every 1.5 s while the state is `starting`, for at most 5 minutes (the first start downloads VS Code's server). Meanwhile the page's notice says
//   "Starting VS Code on <engine>…" and stays.
// - Ready: the blank tab goes to `open_url` (a path on this origin with a single-use launch ticket of 30 s, so at once) and the notice goes. Without a
//   tab, the Mac app opens the address in the default browser itself (OpenLink), and elsewhere (a Home Screen app on an iPhone, a blocked popup) a
//   notice "VS Code is ready on <engine>" offers Open, whose tap is the click a browser needs.
// - VSCODE_LICENSE_REQUIRED: the tab is closed and the licence dialog asks once per engine (the server remembers the answer). Accept opens a new
//   blank tab inside its click, POSTs accept-license and starts again.
// - Any other error closes the tab and says what happened, naming the engine. A tab the person closed while it starts ends the launch.
// Everything here lives only for the launch: nothing is stored in the browser or on the server.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import { ThemeProvider } from '@mui/material/styles';
import { api, deviceText, errorText, t } from './common.jsx';
import { theme } from './theme.mjs';

export const POLL_MS = 1500;
export const WAIT_MS = 5 * 60 * 1000;
const DETAIL_MAX = 300;
const tf = (template, ...values) => t(template).replace(/\{(\d)\}/g, (all, number) => String(values[Number(number) - 1]));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The start route of a session: `sourceKey` is 'local' or 'remote:<id>' (h5.js sources).
export function vscodePath(target) {
  const ids = `${encodeURIComponent(target.taskId)}/terminals/${encodeURIComponent(target.terminalId)}/vscode`;
  const remote = /^remote:(.+)$/.exec(String(target.sourceKey));
  return remote ? `/api/remote-servers/${encodeURIComponent(remote[1])}/tasks/${ids}` : `/api/tasks/${ids}`;
}

// The end of the CLI's output (up to 2 KB from the engine) is too long for a notice: its last line, cut.
const lastLine = detail => {
  const lines = String(detail || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const line = lines.length ? lines[lines.length - 1] : '';
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
};
const OFFLINE = new Set(['REMOTE_OFFLINE', 'REMOTE_CONNECTION_FAILED', 'REMOTE_TIMEOUT']);
const START_FAILED = { VSCODE_START_FAILED: 'it stopped before it was ready', VSCODE_DOWNLOAD_FAILED: 'the download failed', VSCODE_SERVE_WEB_UNSUPPORTED: 'update the VS Code command line tool' };
// What the person reads for a failed launch: `failure` is { code, detail, status, text } (`text`: the server's own words for an unknown code).
export function failureText({ code, detail = '', status = 0, text = '' }, engine) {
  if (code === 'VSCODE_NOT_INSTALLED') return tf('VS Code is not installed on {1}', engine);
  if (code === 'VSCODE_DISABLED') return tf('VS Code is turned off on {1}', engine);
  if (code === 'VSCODE_WEB_UNSUPPORTED' || status === 501) return tf('{1} does not support VS Code in the browser', engine);
  if (OFFLINE.has(code)) return tf('{1} is offline', engine);
  if (START_FAILED[code]) return tf('VS Code could not start on {1}: {2}', engine, lastLine(detail) || t(START_FAILED[code]));
  return tf('Could not open VS Code: {1}', text || t(code || 'VSCODE_START_FAILED'));
}

// The licence question ("One dialog pattern" in docs/design/page-dialogs.md: a confirmation, so text buttons, Cancel first). Accept calls `openTab`
// inside its click. Resolves with { tab } after Accept, null after Cancel, Escape or a click outside.
function LicenseDialog({ engine, openTab, onDone, onExited }) {
  const [open, setOpen] = useState(true);
  const finish = answer => { if (!open) return; setOpen(false); onDone(answer); };
  return (
    <Dialog id="h5-vscode-license" open={open} onClose={() => finish(null)} fullWidth maxWidth="xs" aria-labelledby="h5-vscode-license-title"
      aria-describedby="h5-vscode-license-body" slotProps={{ transition: { onExited } }}>
      <DialogTitle id="h5-vscode-license-title">{t('Use VS Code in the browser?')}</DialogTitle>
      <DialogContent>
        <DialogContentText id="h5-vscode-license-body">
          {tf("VS Code's server will be downloaded to {1} (about 100 MB) and you accept its license terms.", engine)}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button id="h5-vscode-license-cancel" onClick={() => finish(null)}>{t('Cancel')}</Button>
        <Button id="h5-vscode-license-accept" onClick={() => finish({ tab: openTab() })}>{t('Accept')}</Button>
      </DialogActions>
    </Dialog>
  );
}
function askLicense(ui, engine, openTab) {
  return new Promise(resolve => {
    const host = document.createElement('div');
    host.id = 'h5-vscode-root';
    document.body.appendChild(host);
    const root = createRoot(host);
    const exited = () => {
      root.unmount();
      host.remove();
      const active = document.activeElement;
      if ((!active || active === document.body) && ui.actions && ui.actions.focusTerminal) ui.actions.focusTerminal();
    };
    root.render(<ThemeProvider theme={theme}><LicenseDialog engine={engine} openTab={openTab} onDone={resolve} onExited={exited} /></ThemeProvider>);
  });
}

// The answer of a refused request as a failure.
const refused = error => ({ code: (error && error.message) || '', detail: (error && error.data && error.data.detail) || '', status: (error && error.status) || 0, text: errorText(error) });

// Starts VS Code for `target` ({ sourceKey, taskId, terminalId }, the session shown at the click) and opens it in `tab` (or null, see above).
// `openTab` opens another blank tab (lazy-screens.jsx `vscodeTab`); call it only inside a click.
export async function runVscode(ui, target, tab, openTab) {
  const from = (ui.get().sources || []).find(item => item.key === target.sourceKey) || null;
  const engine = deviceText(from || { key: target.sourceKey, label: '' }) || t('This machine');
  const fail = failure => { if (tab) tab.close(); ui.notify(failureText(failure, engine), 'error'); };
  if (from && from.offline) return fail({ code: 'REMOTE_OFFLINE' });
  const path = vscodePath(target);
  ui.notify(tf('Starting VS Code on {1}…', engine), 'info', { ms: WAIT_MS + 60000 });
  const notice = ui.get().notice;
  const clear = () => { const now = ui.get().notice; if (notice && now && now.id === notice.id) ui.set({ notice: null }); };
  const deadline = Date.now() + WAIT_MS;
  let answer;
  try {
    answer = await api('POST', path, {});
    while (answer && answer.state === 'starting') {
      if (tab && tab.closed) { clear(); return undefined; } // the person closed the tab: no longer wanted
      if (Date.now() >= deadline) { answer = { state: 'error', error: 'VSCODE_START_FAILED', detail: t('it was not ready after 5 minutes') }; break; }
      await sleep(POLL_MS);
      answer = await api('GET', path);
    }
  } catch (error) {
    clear();
    return fail(refused(error));
  }
  clear();
  const code = answer && answer.state === 'error' ? answer.error : '';
  if (code === 'VSCODE_LICENSE_REQUIRED') {
    if (tab) tab.close();
    const accepted = await askLicense(ui, engine, openTab);
    if (!accepted) return undefined;
    try { await api('POST', `${path}/accept-license`, {}); } catch (error) { if (accepted.tab) accepted.tab.close(); return fail(refused(error)); }
    return runVscode(ui, target, accepted.tab, openTab);
  }
  if (!answer || answer.state !== 'ready' || typeof answer.open_url !== 'string' || !answer.open_url.startsWith('/vscode/')) {
    return fail({ code: code || 'VSCODE_START_FAILED', detail: (answer && answer.detail) || '' });
  }
  const href = new URL(answer.open_url, location.origin).href;
  if (tab && !tab.closed) {
    try { tab.opener = null; } catch { /* not ours to change */ }
    tab.location.href = href;
  } else if (typeof OpenLink !== 'undefined' && OpenLink.environment().app) {
    OpenLink.open(href);
  } else {
    ui.notify(tf('VS Code is ready on {1}', engine), 'info', { action: { label: 'Open', run: () => (typeof OpenLink === 'undefined' ? window.open(href, '_blank') : OpenLink.open(href)) }, ms: 25000 });
  }
  return undefined;
}
