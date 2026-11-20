import { useEffect, useRef, useState } from 'react';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { api, t } from './common.jsx';
import { localGet, localSet } from './local-keys.mjs';
// The dialog is a chunk of its own (UpdateDialog.jsx, loaded when it first opens or when an Update button is reached: lazy-screens.jsx).
import { UpdateDialogScreen } from './lazy-screens.jsx';

// There is a new version, or the code is already updated but the service still runs the old code (a restart is needed): the red dot.
export const needsAttention = status => Boolean(status) && (status.status === 'available' || status.status === 'restart_pending');
const POLL_MS = 60_000; // how often the red dot reads the update state
const DOWN_POLL_MS = 3000; // a read failed (the service may be restarting): read this often until it answers again
const DOWN_POLL_FOR_MS = 5 * 60_000; // ... but not for longer than this; a service that stays away is back to the minute poll
const RELOAD_CHECK_MS = 1000; // an automatic update is waiting to be loaded: how often to see whether the person has finished
const AUTO_RELOADED_KEY = 'h5-auto-reloaded-versions'; // sessionStorage, this tab only: the guard against reloading twice for one version

// A silent reload must not take anything away from the person: text not sent yet, a dialog or sheet, a chat that is open, or a page they are not looking at.
const TEXT_FIELD = 'textarea, input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=range], [type=file])';
function pageBusy(ui) {
  if (document.hidden) return true;
  const state = ui.get();
  if (state.menu || state.copyText !== null || state.pasteSheet || state.taskDialog || state.translating || state.upload) return true;
  if (document.querySelector('.MuiModal-root:not(.MuiModal-hidden), dialog[open]')) return true; // the same test as modalOpen() in h5.js
  const chat = document.getElementById('h5-agent');
  if (chat && !chat.hidden) return true; // a reload would close the conversation, and any message being written in it
  const mindmap = document.getElementById('h5-mindmap');
  if (mindmap && !mindmap.hidden) return true; // a reload would close the open map, and an edit that is still being saved
  if (state.columns && state.columns.shown && state.columns.tab === 'maps') return true; // the Mind maps tab of the multi-column view: the same
  const draft = document.getElementById('h5-translate-input');
  if (draft && draft.value) return true;
  const active = document.activeElement;
  if (!active || active.closest('.xterm')) return false; // the terminal's own hidden textarea is not a draft
  return Boolean(active.matches(TEXT_FIELD) ? active.value : active.isContentEditable && active.textContent);
}
// Once per version (or per process started by an automatic restart, `boot:<id>`) for each tab, kept across the reload. Nothing can be remembered (private mode): no reload, because a loop is worse than an old page.
function claimReload(version) {
  let done = [];
  try { done = JSON.parse(localGet(AUTO_RELOADED_KEY, 'session') || '[]'); } catch { return false; }
  if (!Array.isArray(done) || done.includes(version)) return false;
  return localSet(AUTO_RELOADED_KEY, JSON.stringify([...done, version].slice(-20)), 'session');
}
const alreadyReloaded = version => {
  try { return JSON.parse(localGet(AUTO_RELOADED_KEY, 'session') || '[]').includes(version); } catch { return true; }
};

// The "Update" button of the rail (and the updater of the page): a red dot says that an update is available or that the service must be restarted. It
// reads the update state every minute, reloads the page silently after an automatic update, and opens the Update dialog (UpdateDialog.jsx), which
// checks for a new version and runs the update.
export function UpdateButton({ ui }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null); // the last state read, for the dot and the details
  const [auto, setAuto] = useState(null); // auto_update of the last update-status; null on a server without the feature
  const manual = useRef(false); // the Update dialog is following an update (monitor): it does its own reload, and the silent one stands aside
  const returnFocus = useRef(null); // the button that opened the dialog when it is not this one (the multi-column bar's): the focus goes back there
  const showRef = useRef(null);
  // Other buttons open this same dialog (the phone header's More menu): one updater, one poll, one silent reload.
  useEffect(() => {
    const open = returnTo => { if (showRef.current) showRef.current(returnTo); };
    ui.actions.openUpdate = open;
    return () => { if (ui.actions.openUpdate === open) delete ui.actions.openUpdate; };
  }, [ui]);
  // Closed after it was opened from another button: MUI gives the focus back to the element focused before the dialog (its FocusTrap restores it in an
  // effect cleanup, which runs before this effect), and a browser that does not focus a clicked button (Safari) leaves nothing to restore. The focus
  // goes to that button in both cases, never to this one hidden under the multi-column view.
  useEffect(() => {
    if (open) return;
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el && el.isConnected && document.activeElement !== el) el.focus();
  }, [open]);

  // The red dot: read the state now and every minute; a state that was never checked (or whose last check failed) is checked once.
  // The same reads notice that the service restarted into an automatic update, and reload this page silently ("Automatic refresh after an update" in docs/design/update-check-and-versions.md).
  useEffect(() => {
    let stop = false;
    let baseline = null; // boot_id and local_version of the first answer: the code this page was loaded from
    let lastBoot = null; // the boot_id of the last answer: the process this page last talked to
    let target = null; // what this page should load once it may: the automatically installed version, or `boot:<id>` after an automatic restart
    let reloading = false;
    let reloadCheck = 0;
    let downSince = null;
    let downPoll = 0;
    let lastRead = Date.now();
    const tryReload = () => {
      if (stop || !target || reloading || manual.current || pageBusy(ui)) return;
      clearInterval(reloadCheck);
      if (!claimReload(target)) { target = null; return; }
      reloading = true;
      if (ui.actions.refresh) void ui.actions.refresh(); else location.reload();
    };
    const observe = next => {
      if (!baseline) { baseline = { boot: next.boot_id, version: next.local_version }; lastBoot = next.boot_id; return; }
      const previousBoot = lastBoot;
      if (next.boot_id) lastBoot = next.boot_id;
      const autoUpdate = next.auto_update;
      if (target || manual.current || !autoUpdate || !next.boot_id || !baseline.boot || next.boot_id === baseline.boot) return;
      // A new process AND a new version AND the server says it installed that version by itself: a manual update or a plain restart never gets here.
      const updated = Boolean(next.local_version) && next.local_version !== baseline.version && autoUpdate.last_auto_version === next.local_version;
      // Or the process this page last talked to restarted itself automatically to load newer code on disk; the version may be the same.
      // A manual restart (pm2 restart, the Restart button) leaves last_auto_boot naming an older process, so it never matches.
      const restarted = Boolean(autoUpdate.last_auto_boot) && autoUpdate.last_auto_boot === previousBoot && next.boot_id !== previousBoot;
      const key = updated ? next.local_version : restarted ? `boot:${next.boot_id}` : null;
      if (!key || alreadyReloaded(key)) return;
      target = key;
      tryReload();
      if (target && !reloading) reloadCheck = setInterval(tryReload, RELOAD_CHECK_MS);
    };
    const pollWhileDown = () => {
      if (downPoll || stop || manual.current || Date.now() - downSince > DOWN_POLL_FOR_MS) return;
      downPoll = setTimeout(() => { downPoll = 0; void read(); }, DOWN_POLL_MS);
    };
    const read = async () => {
      lastRead = Date.now();
      try {
        const next = await api('GET', '/api/system/update-status');
        if (stop) return next;
        downSince = null;
        setStatus(next);
        setAuto(next.auto_update || null);
        observe(next);
        return next;
      } catch (error) {
        // No answer, or a gateway's error while the service is away. A refused request (signed out) is not an outage.
        if (!stop && (!error.status || error.status >= 500)) { if (downSince === null) downSince = Date.now(); pollWhileDown(); }
        return null;
      }
    };
    // A phone brought back to the front has slept through the minute poll: look now, so it does not reload a minute after the person started using it.
    const onVisible = () => {
      if (document.hidden) return;
      tryReload();
      if (!target && !manual.current && Date.now() - lastRead > DOWN_POLL_MS) void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    (async () => {
      const first = await read();
      if (stop || !first || !['idle', 'failed', 'blocked'].includes(first.status)) return;
      try { const next = await api('POST', '/api/system/check-update', {}); if (!stop) setStatus(next); } catch { /* the dot stays as it was */ }
    })();
    const poll = setInterval(() => void read(), POLL_MS);
    return () => { stop = true; clearInterval(poll); clearInterval(reloadCheck); clearTimeout(downPoll); document.removeEventListener('visibilitychange', onVisible); };
  }, [ui]);

  // `returnTo`: the button that opened it, when it is not #h5-update (ui.actions.openUpdate). The dialog checks again each time it opens.
  const show = returnTo => { returnFocus.current = returnTo && typeof returnTo.focus === 'function' ? returnTo : null; setOpen(true); };
  showRef.current = show;
  const dot = needsAttention(status);
  // The dot for the other Update buttons (state.updateDot), written only when it changes.
  useEffect(() => { if (Boolean(ui.get().updateDot) !== dot) ui.set({ updateDot: dot }); }, [dot, ui]);

  return (
    <>
      <IconButton id="h5-update" aria-label={t('Update')} title={t('Update')} aria-haspopup="dialog" data-attention={dot ? 'true' : undefined} onClick={() => show()}>
        <Badge id="h5-update-dot" variant="dot" color="error" invisible={!dot} overlap="circular">
          <SystemUpdateAltIcon />
        </Badge>
      </IconButton>
      <UpdateDialogScreen ui={ui} open={open} onClose={() => setOpen(false)} status={status} setStatus={setStatus} auto={auto} setAuto={setAuto} manual={manual} />
    </>
  );
}
