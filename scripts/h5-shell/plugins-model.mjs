// The pure logic of the "Plugins" section in Settings "T-Attention" (PluginSettings.jsx): the status chips, the activity line and the per-status
// modes of each plugin, from the JSON of GET /api/attention/plugins (see "T-Attention on the page" in DESIGN.md). No DOM, no requests, so
// test/plugins-model.test.js runs it in Node. `t` is passed in (the page's I18n.t); the labels below are English keys of public/js/i18n-zh-ui.js.
import { STATUS_LABELS } from './attention-model.mjs';

// The statuses in the order the notifier settings list them (NotifierSettings.jsx).
export const STATUS_ORDER = ['waiting_user', 'failed', 'review', 'working', 'todo', 'done', 'cancelled'];
export const MODE_LABELS = { message: 'Message', call: 'Call', off: 'Off' };

const plain = text => text;
const list = value => (Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object') : []);

// The answer, made safe to draw: two lists, every entry an object with a name.
export function normalizePlugins(data) {
  const named = entry => ({ ...entry, name: typeof entry.name === 'string' && entry.name ? entry.name : '?' });
  return { listeners: list(data && data.listeners).map(named), notifiers: list(data && data.notifiers).map(named) };
}

// A time as milliseconds: an ISO string, or 'YYYY-MM-DD HH:MM:SS' (UTC, as SQLite writes it); NaN when it cannot be read.
export function timeOf(value) {
  if (!value || typeof value !== 'string') return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  return Date.parse(iso);
}

// "5 min ago" (the same words as the task list); empty when the time is not known.
export function relativeTime(value, { now = Date.now(), t = plain } = {}) {
  const at = timeOf(value);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return t('Just now');
  if (minutes < 60) return `${minutes} ${t('min ago')}`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} ${t('h ago')}`;
  return `${Math.round(minutes / 1440)} ${t('d ago')}`;
}

// A listener is set up on the Client's machine when its hook path is written and the CLI is logged in.
export const listenerInstalled = listener => Boolean(listener && listener.local && listener.local.hookPath && listener.local.loggedIn);

// The chips of a listener: { key, label, tone } with tone a palette colour ('success', 'warning', 'error') or 'default'.
export function listenerChips(listener) {
  const local = (listener && listener.local) || {};
  const chips = [];
  if (listener && listener.error) chips.push({ key: 'error', label: 'Failed to load', tone: 'error' });
  chips.push(listenerInstalled(listener) ? { key: 'installed', label: 'Installed', tone: 'success' } : { key: 'installed', label: 'Not installed', tone: 'warning' });
  if (local.hookPath && !local.loggedIn) chips.push({ key: 'login', label: 'Not logged in', tone: 'warning' });
  if (local.toolHooks === true) chips.push({ key: 'hooks', label: 'Hooks synced', tone: 'success' });
  else if (local.toolHooks === false) chips.push({ key: 'hooks', label: 'Hooks not synced', tone: 'warning' });
  return chips;
}

// "3 open · Last event 5 min ago", "No open items · No events yet".
export function listenerActivity(listener, { now = Date.now(), t = plain } = {}) {
  const local = (listener && listener.local) || {};
  const count = Number.isFinite(local.itemCount) ? local.itemCount : 0;
  const when = relativeTime(local.lastEventAt, { now, t });
  return [count ? t(`${count} open`) : t('No open items'), when ? `${t('Last event')} ${when}` : t('No events yet')].join(' · ');
}

// What still has to be done on the Client's machine: the login (token + command) and running `ta` once to write the tool hooks.
export function setupSteps(listener) {
  const local = (listener && listener.local) || {};
  return { login: !local.hookPath || !local.loggedIn, sync: local.toolHooks === false || !local.hookPath };
}

// The command that logs the CLI in to this page's Client; the token is a placeholder the person replaces.
export const loginCommand = origin => `t-attention login --url ${origin} --token <token>`;

// The chips of a notifier: "Disabled" when its switch is off (it then gets nothing), then the setup state.
export function notifierChips(notifier) {
  if (!notifier) return [];
  if (notifier.loaded === false) return [{ key: 'error', label: 'Failed to load', tone: 'error' }];
  const chips = notifier.enabled === false ? [{ key: 'enabled', label: 'Disabled', tone: 'default' }] : [];
  if (notifier.configured === true) chips.push({ key: 'configured', label: 'Configured', tone: 'success' });
  else if (notifier.configured === false) chips.push({ key: 'configured', label: 'Not configured', tone: 'warning' });
  return chips;
}

// "Needs you: Call · Review: Message": the statuses that are not off, in the settings order (unknown statuses after them).
export function modesSummary(statuses, { t = plain } = {}) {
  if (!statuses || typeof statuses !== 'object') return '';
  const keys = [...STATUS_ORDER.filter(key => key in statuses), ...Object.keys(statuses).filter(key => !STATUS_ORDER.includes(key))];
  const on = keys.filter(key => statuses[key] && statuses[key] !== 'off');
  if (!keys.length) return '';
  if (!on.length) return t('Sends nothing: every status is off');
  return on.map(key => `${t(STATUS_LABELS[key] || key)}: ${t(MODE_LABELS[statuses[key]] || statuses[key])}`).join(' · ');
}
