// T-Attention notifier: a bubble beside the T-Attention desktop window on this Mac (widgets/macos/*.swift).
// It never sends anything over the network: each message becomes one notice in the in-memory queue of services/widget-notices.js, which the window
// reads every 5 s (GET /api/attention/widget/notices). A click on the bubble opens the notice's `target`. Ready only on macOS, in a server that may
// start the window, with the window switched on and running (services/attention-widget.js state()); otherwise skipped like any notifier that is
// not set up. It is local to each Mac: services/attention-relay.js relays Telegram only, so a linked device never sends a bubble for another one.
// A bubble cannot ring, so the manifest allows only "message" and "off", and a call that still arrives falls back to a message.
// Settings (manifest.json): `seconds`, how long a bubble stays ('0': until it is closed).

const STATUS_LABELS = { waiting_user: 'Needs you', review: 'Review', failed: 'Failed', working: 'Working', todo: 'To do', done: 'Done', cancelled: 'Cancelled' };
const DIRECT_TITLE = 'Message from an agent';
const DEFAULT_SECONDS = 8;
const TEST_TITLE = 'Test message';
const TEST_TEXT = 'This is a test from Settings. Messages about tasks that need you show up here; click a bubble to open it.';
const NOT_READY = {
  platform: 'The desktop window is only available on macOS',
  blocked: 'This server does not start the desktop window (test or development copy)',
  off: 'Turn on the desktop window in Settings → T-Attention first',
  stopped: 'The desktop window is not running: turn it off and on again in Settings → T-Attention',
};

class WidgetNoticeError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'NotifyError'; this.statusCode = statusCode; }
}

const textOf = value => (typeof value === 'string' ? value.trim() : '');
function contextOf(item) {
  let context = item && item.context;
  if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = null; } }
  return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
}
const statusLabel = item => STATUS_LABELS[item && item.status] || textOf(item && item.status) || 'Update';

// The most useful line of an item: what it waits for (the pending question or permission), else why it needs the person, else its result,
// else the status label.
function itemText(item) {
  const context = contextOf(item);
  const pending = context.pending && typeof context.pending === 'object' ? textOf(context.pending.text) : '';
  return pending || textOf(item.attention_reason) || textOf(item.result) || statusLabel(item);
}

// options: notices (services/widget-notices.js createWidgetNotices; default the shared queue), widgetState() -> { supported, blocked, enabled,
// running, url } (default the state server.js set), now().
function createWidgetNotifier(options = {}) {
  const notices = () => options.notices || require('../../../services/widget-notices').defaultNotices();
  const lib = () => require('../../../services/widget-notices');
  const state = () => lib().readWidgetState(options.widgetState);

  // Why no bubble can be shown now, or '' when one can.
  function whyNotReady() {
    const now = state();
    if (!now.supported) return NOT_READY.platform;
    if (now.blocked) return NOT_READY.blocked;
    if (!now.enabled) return NOT_READY.off;
    if (!now.running) return NOT_READY.stopped;
    return '';
  }
  const ready = () => whyNotReady() === '';

  const settingsOf = (config, values) => ({ ...(values || {}), ...(config || {}) });
  function secondsOf(settings) {
    const value = typeof settings.seconds === 'string' && settings.seconds.trim() ? Number(settings.seconds) : settings.seconds;
    return Number.isInteger(value) && value >= 0 && value <= 600 ? value : DEFAULT_SECONDS;
  }
  // The T-Agent address the window talks to (its loopback address), else the origin of the notification link (the public page address).
  function baseOf(link) {
    const { url } = state();
    if (url) return url;
    const target = lib().safeTarget(link);
    return target ? new URL(target).origin : null;
  }
  // kind item: the item's own link_url (an http(s) address as it is, a page path against the base), else the notification link; kind direct and
  // test: the message link, else the T-Agent page. Only http(s) addresses without credentials (services/widget-notices.js safeTarget).
  function itemTarget(item, link) {
    const { safeTarget, resolvePath } = lib();
    const own = item && typeof item.link_url === 'string' ? item.link_url.trim() : '';
    if (own) {
      const resolved = own.startsWith('/') ? resolvePath(own, baseOf(link)) : safeTarget(own);
      if (resolved) return resolved;
    }
    return safeTarget(link) || pageOf(link);
  }
  const pageOf = link => { const base = baseOf(link); return base ? lib().safeTarget(`${base.replace(/\/+$/, '')}/`) : null; };
  const directTarget = link => lib().safeTarget(link) || pageOf('');

  function itemNotice({ item, link, origin, seconds }) {
    return {
      kind: 'item',
      title: textOf(item.title) || statusLabel(item),
      text: itemText(item),
      from: origin && typeof origin === 'object' ? textOf(origin.name) || null : null,
      status: textOf(item.status) || null,
      key: Number.isSafeInteger(item.id) ? `local:${item.id}` : null,
      target: itemTarget(item, link),
      seconds,
    };
  }
  function directNotice({ message, link, seconds }) {
    const text = textOf(message && message.text);
    if (!text) throw new WidgetNoticeError('The message has no text');
    return {
      kind: 'direct',
      title: textOf(message.title) || DIRECT_TITLE,
      text,
      from: textOf(message.from) || null,
      status: null,
      key: null,
      target: directTarget(link),
      seconds,
    };
  }

  // ---- The contract interface ----
  async function notify({ item, reason, mode, config, values, link, origin, message } = {}) {
    const why = whyNotReady();
    if (why) throw new WidgetNoticeError(why, 409);
    const seconds = secondsOf(settingsOf(config, values));
    const notice = reason === 'direct' ? directNotice({ message, link, seconds }) : itemNotice({ item: item || {}, link, origin, seconds });
    notices().push(notice);
    return mode === 'call' ? { fallback: 'message', error: 'The desktop window cannot make calls' } : { outcome: 'sent' };
  }
  async function test(config, { link = '', values } = {}) {
    const why = whyNotReady();
    if (why) return { ok: false, message: why };
    const seconds = secondsOf(settingsOf(config, values));
    notices().push({ kind: 'test', title: TEST_TITLE, text: TEST_TEXT, from: null, target: directTarget(link), seconds });
    return { ok: true, outcome: 'sent', message: 'Test bubble sent to the desktop window' };
  }
  // The plugin overview's line: ready, or why not.
  function status() {
    const why = whyNotReady();
    return { configured: !why, summary: why || 'Shows bubbles beside the desktop window' };
  }

  return {
    name: 'widget',
    label: 'Desktop window (macOS)',
    configFields: [],
    direct: true,
    ready,
    whyNotReady,
    notify,
    test,
    status,
  };
}

module.exports = createWidgetNotifier();
module.exports.createWidgetNotifier = createWidgetNotifier;
module.exports.itemText = itemText;
module.exports.NOT_READY = NOT_READY;
module.exports.DIRECT_TITLE = DIRECT_TITLE;
