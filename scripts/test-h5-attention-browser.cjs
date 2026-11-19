// T-Attention on the MUI page (scripts/h5-shell/Attention.jsx, attention-feed.mjs, AttentionSettings.jsx) in real Chromium, with the API
// (/api/attention*) mocked by Playwright routes and the live stream (EventSource), Notification and AudioContext stubbed in the page:
// - phone 390x844 (touch): row 2 has Docs and Attention (no Files button) and the "Needs you" badge; the full-screen sheet with the Home view
//   sections in order (Needs you, Working, To do; "Done: N" folded) and the order inside a section; source badge and reason; quick add (POST body); the circle marks done (PATCH); the edit
//   view (history, PATCH of the changed fields only, link) and delete with a confirmation; a live event moving a task into Needs you gives a
//   toast, the badge and a sound but never a system notification (Notification is never made, the permission never asked for, even with an old
//   stored 'h5-attention-notify' = '1'), a change made on this page gives none; a lost stream connects again and reads the list
//   again; the Android back button and Escape close one layer; Settings "T-Attention": tokens (create shown once, revoke), sound (no system notification controls),
//   AI summary (off by default, provider / model, privacy note), Plugins (GET /api/attention/plugins: chips, activity, setup steps with Copy, notifier
//   modes, a plugin that failed to load, Refresh; above the notifier settings; a notifier's settings: the form from the manifest schema with
//   the saved values, a secret never filled in, Save, Test, the enable switch and its "Disabled" chip; the claude row's "Update the hooks" install button and the pairing dialog
//   with code, countdown, Copy and the claim seen by polling). Context recall: the pending text on the row, the context card (needs you with the
//   command, AI summary with refresh, goal, progress with files: a file of this machine opens with the any-path preview (/api/fs/content), one
//   of a session on another machine (context.host) shows only its path),
//   folder and branch, the timeline by day, "Open terminal" (the T-Agent terminal) and "Copy resume command".
// - phone 390x844 (touch), links: the link button of a row (a real <a>: a web address in a new tab with noopener noreferrer, a page path in this
//   tab; a tap never opens the edit view; none without a link; 44px; it fits at 320px), the Link and Link label fields of the edit view (filled
//   from the task, PATCH of the changed ones, emptied ones cleared with null, the server's 400 message in the error line), and the web addresses
//   inside the reason, the context card and the history drawn as links (never a javascript: one).
// - phone 320x640 (touch): seven 44px buttons in row 2 (Docs left out, reached from the saved commands list); the sheet's controls are 44px; the
//   Plugins rows fit the width with 44px buttons.
// - computer 1440x900 (mouse): the floating side sheet (480px, 8px from the edges, elevation 16, over the page): the terminal, the page and the
//   bottom row keep their width and the terminal its cols (no PTY resize); a press outside (the terminal, the translate field) closes it and does nothing
//   else; the rail's Attention button toggles it once; a dialog inside it does not close it; Escape and the close button close it and the focus goes
//   back to the control that opened it; one at a time with the Docs sheet; the edit view is a normal dialog.
// H5_SHOT_DIR=<dir> saves screenshots (phones at 3x).
const { chromium } = require('playwright');
const { openGroup } = require('./settings-test-helper.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const AT = '2026-11-05T10:00:00Z';

const ITEMS = () => [
  { id: 1, title: 'Allow Bash in the repo', status: 'waiting_user', priority: 'none', source: 'claude', attention_reason: 'Claude needs your permission to use Bash', updated_at: AT, created_at: AT,
    context: {
      goal: 'Add a login page with a remember-me box', last_reply: 'The form is done. Next I run the tests.', turns: 3, turn_started_at: AT,
      pending: { kind: 'permission', text: 'Allow Bash: npm test', tool: 'Bash', command: 'npm test -- --watch=false' },
      files: [{ path: 'src/login.js', added: 40, deleted: 2 }, { path: '/etc/hosts', added: 1, deleted: 0 }],
      cwd: '/work/fix-login', branch: 'feat/login', host: 'mac',
      session: { agent: 'claude', id: 's1', resume: "cd '/work/fix-login' && claude --resume s1" },
      tagent: { task_id: '1', terminal_id: 't2' },
      summary: { text: 'Doing: login page\nProgress: form done, tests next\nNeeds: allow npm test', at: AT, model: 'deepseek-chat' },
    } },
  { id: 2, title: 'Check the PR', status: 'review', priority: 'none', source: 'claude', attention_reason: 'Claude finished. Review the result.', link_url: 'https://example.test/pr/1', link_label: 'PR #1', updated_at: AT, created_at: AT },
  { id: 3, title: 'Refactor login', status: 'working', priority: 'none', source: 'claude', updated_at: AT, created_at: AT },
  { id: 4, title: 'Write release notes', status: 'todo', priority: 'low', source: 'user', updated_at: AT, created_at: AT },
  { id: 5, title: 'Fix the build', status: 'todo', priority: 'high', due_date: '2026-11-20', source: 'cli', updated_at: AT, created_at: AT },
  { id: 6, title: 'Old thing', status: 'done', priority: 'none', source: 'user', updated_at: AT, created_at: AT },
  { id: 7, title: 'Deploy', status: 'failed', priority: 'none', source: 'cli', attention_reason: 'Exit code 1', updated_at: AT, created_at: AT, context: { session: { agent: 'claude', id: 's7', resume: "cd '/srv' && claude --resume s7" }, tagent: { task_id: '55', terminal_id: 'x' }, cwd: '/srv', host: 'linux-box', files: [{ path: 'deploy.sh', added: 2, deleted: 1 }] } },
  { id: 8, title: 'Pay invoice', status: 'todo', priority: 'high', due_date: '2026-11-10', source: 'user', updated_at: AT, created_at: AT },
];

// Rows from a T-Agent session: 1 (Needs you, terminal t2 of task 1) and 2 (Review with a link, terminal t1); 9 names a terminal task 1 no longer has
// (gone); 5 ran on another machine; 4 was added by hand.
const SESSION_ITEMS = () => [
  { id: 1, title: 'Allow Bash in the repo', status: 'waiting_user', priority: 'none', source: 'claude', attention_reason: 'Claude needs your permission to use Bash', updated_at: AT, created_at: AT,
    context: { pending: { kind: 'permission', text: 'Allow Bash: npm test' }, host: 'mac', session: { agent: 'claude', id: 's1', resume: "claude --resume s1" }, tagent: { task_id: '1', terminal_id: 't2' } } },
  { id: 2, title: 'Check the PR', status: 'review', priority: 'none', source: 'claude', attention_reason: 'Claude finished. Review the result.', link_url: 'https://example.test/pr/1', link_label: 'PR #1', updated_at: AT, created_at: AT,
    context: { tagent: { task_id: 1, terminal_id: 't1' } } },
  { id: 4, title: 'Write release notes', status: 'todo', priority: 'low', source: 'user', updated_at: AT, created_at: AT },
  { id: 5, title: 'Fix the build', status: 'todo', priority: 'high', source: 'cli', updated_at: AT, created_at: AT, context: { host: 'linux-box', tagent: { task_id: '1', terminal_id: 't1' } } },
  { id: 9, title: 'Old session', status: 'working', priority: 'none', source: 'codex', updated_at: AT, created_at: AT, context: { session: { agent: 'codex', id: 's9', resume: 'codex resume s9' }, tagent: { task_id: '1', terminal_id: 't9' } } },
];

// The answer of GET /api/attention/plugins (contract: "T-Attention plugin overview"): one listener set up here, one not, a configured notifier and
// one that failed to load. `settings` is the stubbed state of GET/PUT /api/attention/plugins/:name/config (the enable switch and the values).
const PLUGINS = (settings = CONFIGS()) => ({
  listeners: [
    { name: 'claude', version: '1.0.0', description: 'Claude Code hooks', entry: 'hook.js', events: ['Stop'],
      local: { hookPath: true, loggedIn: true, toolHooks: true, hooksCurrent: false, autoTerminal: true, installable: true, lastEventAt: new Date(Date.now() - 5 * 60000).toISOString(), itemCount: 3 } },
    { name: 'codex', version: '0.1.0', description: 'Codex notify hook', entry: 'hook.js', events: [],
      local: { hookPath: false, loggedIn: false, toolHooks: null, lastEventAt: null, itemCount: 0 } },
  ],
  notifiers: [
    { name: 'telegram', version: '1.0.0', description: 'Telegram message or call', loaded: true, error: null, enabled: settings.telegram.enabled, configured: true,
      summary: 'Logged in as Ann \u2192 account 2 @bob', statuses: { waiting_user: 'call', review: 'message', failed: 'off', done: 'off' }, settings: true, test: true, customUi: 'telegram' },
    { name: 'broken', version: '0.0.1', description: '', loaded: false, error: 'Bad manifest: no send()', configured: null, summary: null, statuses: {} },
  ],
});
// The manifest settings (contract: "Plugin settings from the manifest"): Telegram's ring time, and a stored secret that only comes back as { set }.
const TELEGRAM_SCHEMA = [
  { key: 'callSeconds', label: 'Ring time (seconds)', type: 'number', integer: true, min: 5, max: 120, default: 30, required: false, help: 'How long a call rings before it hangs up.' },
  { key: 'botToken', label: 'Bot token', type: 'secret', required: false },
];
const CONFIGS = () => ({ telegram: { enabled: true, values: { callSeconds: 45 }, secret: 'saved-secret-value' } });
const configView = entry => ({ name: 'telegram', enabled: entry.enabled, schema: TELEGRAM_SCHEMA, test: true, customUi: 'telegram',
  values: { callSeconds: entry.values.callSeconds === undefined ? 30 : entry.values.callSeconds, botToken: { set: Boolean(entry.secret) } } });

async function openPage(browser, { viewport, touch = true, notify = true, items = null, activity = null }) {
  const scale = SHOTS && touch ? { deviceScaleFactor: 3 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  const errors = [];
  const calls = []; // { method, path, body } of every /api/attention request
  const fsReads = []; // the paths read with GET /api/fs/content
  const db = { configs: CONFIGS(), items: items || ITEMS(), next: 100, summary: { enabled: false, provider: 'deepseek', model: '' }, tokens: [{ id: 1, name: 'laptop claude', created_at: AT, last_used_at: null, revoked_at: null }], claudeLocal: {}, pairingReads: 0 };
  const pluginsNow = () => { const all = PLUGINS(db.configs); const claude = all.listeners.find(entry => entry.name === 'claude'); claude.local = { ...claude.local, ...db.claudeLocal }; return all; };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ notify: on }) => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; window.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send(data) { this.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    // The live stream: a fake EventSource the test drives (emit a change, drop the connection).
    window.streams = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; window.streams.push(this); setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }, 0); }
      close() { this.readyState = 2; }
    };
    window.emitChange = change => { const live = window.streams.filter(s => s.readyState === 1).at(-1); const event = new MessageEvent('change', { data: JSON.stringify(change) }); live.dispatchEvent(event); };
    window.dropStream = () => { const live = window.streams.filter(s => s.readyState === 1).at(-1); live.readyState = 2; live.dispatchEvent(new Event('error')); };
    // No system notifications: every Notification made (directly or through the service worker) and every permission request is counted; both
    // stay 0. The permission is 'granted' and the old setting is stored, so only the code itself could make one.
    window.notes = [];
    window.permissionAsks = 0;
    window.Notification = class { constructor(title, options = {}) { window.notes.push({ title, body: options.body, tag: options.tag }); } close() {} };
    window.Notification.permission = 'granted';
    window.Notification.requestPermission = async () => { window.permissionAsks += 1; return 'granted'; };
    if (navigator.serviceWorker) {
      const reg = { showNotification: (title, options = {}) => { window.notes.push({ title, body: options.body, tag: options.tag }); return Promise.resolve(); } };
      try { Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, get: () => Promise.resolve(reg) }); } catch { /* left as it is */ }
      navigator.serviceWorker.getRegistration = () => Promise.resolve(reg);
    }
    window.tones = 0;
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() { window.tones += 1; return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
    try { if (on) localStorage.setItem('h5-attention-notify', '1'); } catch { /* none */ } // the old system notification setting: ignored
    window.confirm = () => true;
  }, { notify });
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
    if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
    if (p === '/api/remote-servers') return json([]);
    if (p === '/api/attention-notify/config') return json({ rules: { statuses: ['waiting_user'], modes: {}, callDelayMinutes: 0, quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: '' }, rateLimit: { message: 20, call: 6 }, publicUrl: '' }, modes: ['message', 'call', 'off'], notifiers: [{ name: 'telegram', label: 'Telegram', status: { loggedIn: true, step: 'done', apiId: 1, hasApiHash: true, phone: '+1***', account: { id: '1', name: 'Ann' }, target: null } }], recent: [] });
    if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login' }]);
    if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    // The terminal activity (the task list's session states), read by polling: its stream is not mocked (404).
    if (activity && p === '/api/tasks/terminal-activity') return json(activity);
    if (activity && p === '/api/tasks/terminal-subagents') return json({});
    if (p === '/api/tasks/1/terminals') return json([{ terminal_id: 't1', title: 'Terminal 1' }, { terminal_id: 't2', title: 'Claude 1', agent: 'claude' }]);
    if (/\/agent\/conversations$/.test(p)) return json([]);
    if (p === '/api/tasks/1/files/content') {
      const file = url.searchParams.get('path');
      return json({ path: file, content: file === 'DESIGN.md' ? '# Design of Fix login\n\nText.\n' : 'const login = 1;\n' });
    }
    // The any-path read of the local Engine (T-Attention's context files): records the path and answers with the normalized path.
    if (p === '/api/fs/content') { fsReads.push(url.searchParams.get('path')); return json({ path: url.searchParams.get('path'), realPath: url.searchParams.get('path'), content: 'const login = 1;\n' }); }
    if (p === '/api/translate/config') return json({ provider: 'deepseek', providers: { deepseek: { label: 'DeepSeek', hasApiKey: true }, glm: { label: 'GLM', hasApiKey: false } } });
    if (p.startsWith('/api/attention')) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      calls.push({ method, path: p + url.search, body });
      if (p === '/api/attention/tokens' && method === 'GET') return json({ tokens: db.tokens });
      if (p === '/api/attention/plugins' && method === 'GET') return json(pluginsNow());
      if (p === '/api/attention/plugins/telegram/config' && method === 'GET') return json(configView(db.configs.telegram));
      if (p === '/api/attention/plugins/telegram/config' && method === 'PUT') {
        const entry = db.configs.telegram;
        if (body.values && body.values.callSeconds !== undefined && body.values.callSeconds !== '' && (body.values.callSeconds < 5 || body.values.callSeconds > 120)) return json({ error: 'INVALID_SETTINGS', message: 'Ring time (seconds) must be a whole number from 5 to 120' }, 400);
        if (typeof body.enabled === 'boolean') entry.enabled = body.enabled;
        if (body.values) {
          if (body.values.callSeconds !== undefined) entry.values.callSeconds = body.values.callSeconds === '' ? undefined : body.values.callSeconds;
          if (body.values.botToken === null) entry.secret = '';
          else if (typeof body.values.botToken === 'string') entry.secret = body.values.botToken;
        }
        return json(configView(entry));
      }
      if (p === '/api/attention/plugins/telegram/test' && method === 'POST') return json(db.configs.telegram.enabled ? { ok: true, message: 'Test sent' } : { ok: false, message: 'The plugin is turned off' });
            // The one-click install (services/attention-plugins.js createListenerInstaller): the hooks become current.
      if (p === '/api/attention/plugins/claude/install' && method === 'POST') {
        db.claudeLocal = { toolHooks: true, hooksCurrent: true };
        const claude = pluginsNow().listeners.find(entry => entry.name === 'claude');
        return json({ ok: true, client: 'kept', changed: true, added: 0, updated: 8, settingsFile: '/home/me/.claude/settings.json', listener: claude });
      }
      // Pairing: a code for 10 minutes; the second status read reports that the other machine used it.
      if (p === '/api/attention/pairing' && method === 'POST') return json({ code: '123456', expiresAt: new Date(Date.now() + 600000).toISOString(), url: body.origin, command: `t-attention pair 123456 --url ${body.origin}` }, 201);
      if (p === '/api/attention/pairing' && method === 'GET') {
        db.pairingReads += 1;
        return json(db.pairingReads >= 2 ? { active: false, expiresAt: null, claimed: { name: 'claude listener (laptop)', at: AT } } : { active: true, expiresAt: new Date(Date.now() + 590000).toISOString(), claimed: null });
      }
      if (p === '/api/attention/pairing' && method === 'DELETE') return json({ active: false, expiresAt: null, claimed: null });
      // The summary settings answer as services/attention-summary.js does: `providers` is a list with hasApiKey (never a key), and a save that turns
      // the summary on for a provider without a saved key is refused with 409 SUMMARY_PROVIDER_NOT_CONFIGURED and an English message.
      const providers = [{ id: 'deepseek', label: 'DeepSeek', hasApiKey: true, model: 'deepseek-chat' }, { id: 'glm', label: 'GLM', hasApiKey: false, model: 'glm-4-flash' }];
      if (p === '/api/attention/settings/summary' && method === 'GET') return json({ ...db.summary, providers });
      if (p === '/api/attention/settings/summary' && method === 'PUT') {
        const next = { ...db.summary, ...body };
        if (next.enabled && !providers.find(entry => entry.id === next.provider).hasApiKey) return json({ error: 'SUMMARY_PROVIDER_NOT_CONFIGURED', message: 'Save a GLM API key in the translation settings first' }, 409);
        db.summary = next;
        return json({ ...db.summary, providers });
      }
      if (/^\/api\/attention\/\d+\/summarize$/.test(p) && method === 'POST') {
        db.summarizeCalls = (db.summarizeCalls || 0) + 1;
        if (db.summarizeCalls > 1) return json({ error: 'SUMMARY_DISABLED', message: 'The AI summary is switched off; turn it on in Settings first' }, 409);
        return json({ ok: true }, 202);
      }
      if (p === '/api/attention/tokens' && method === 'POST') { const token = { id: db.tokens.length + 1, name: body.name, created_at: AT, last_used_at: null, revoked_at: null }; db.tokens.push(token); return json({ id: token.id, name: token.name, token: 'tatt_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG' }, 201); }
      const token = p.match(/^\/api\/attention\/tokens\/(\d+)$/);
      if (token && method === 'DELETE') { db.tokens.find(entry => entry.id === Number(token[1])).revoked_at = AT; return route.fulfill({ status: 204, body: '' }); }
      if (p === '/api/attention' && method === 'GET') return json({ items: db.items, host: 'mac' });
      if (p === '/api/attention' && method === 'POST') { const item = { id: db.next++, status: 'todo', priority: 'none', source: 'user', ...body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; db.items.push(item); return json(item, 201); }
      const one = p.match(/^\/api\/attention\/(\d+)$/);
      if (one) {
        const id = Number(one[1]);
        const item = db.items.find(entry => entry.id === id);
        if (!item) return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
        if (method === 'GET') {
          const events = [
            { id: 5, item_id: id, at: '2026-11-05T10:00:00Z', actor: 'claude', type: 'status', from_status: 'working', to_status: item.status, data: null },
            { id: 4, item_id: id, at: '2026-11-05T09:59:00Z', actor: 'claude', type: 'activity', data: { kind: 'permission', text: 'Bash: npm test' } },
            { id: 3, item_id: id, at: '2026-11-04T12:00:00Z', actor: 'claude', type: 'updated', data: { context: {} } },
            { id: 2, item_id: id, at: '2026-11-04T11:00:00Z', actor: 'claude', type: 'activity', data: { kind: 'prompt', text: item.prompt_text || 'Add a login page' } },
            { id: 1, item_id: id, at: '2026-11-04T10:59:00Z', actor: 'claude', type: 'created', data: null },
          ];
          return json({ item, events });
        }
        if (method === 'PATCH') {
          // The server's link rule (services/attention.js linkUrl): an http(s) address or a page path starting with '/'.
          if (typeof body.link_url === 'string' && !/^(https?:\/\/\S+|\/(?![/\\])\S*)$/i.test(body.link_url)) return json({ error: 'VALIDATION_FAILED', message: 'link_url must be an http(s) address or a page path starting with /' }, 400);
          Object.assign(item, body, { updated_at: new Date().toISOString() });
          return json(item);
        }
        if (method === 'DELETE') { db.items = db.items.filter(entry => entry.id !== id); return route.fulfill({ status: 204, body: '' }); }
      }
      return json({ error: 'not mocked' }, 404);
    }
    return json({ error: 'not mocked' }, 404);
  });
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  const row = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await row.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await row[how]();
  await page.waitForFunction(() => window.sockets.length >= 1 && window.sockets.at(-1).readyState === 1);
  // The phone task sheet has slid away (the page is back in place).
  await page.waitForFunction(() => innerWidth >= 900 || !document.body.classList.contains('h5-tasks-open') && Math.abs(document.getElementById('h5-app').getBoundingClientRect().left) < 0.5 && innerWidth >= document.getElementById('h5-app').getBoundingClientRect().right - 0.5);
  return { context, page, how, errors, calls, db, fsReads };
}

const settled = (page, selector) => page.waitForFunction(sel => { const node = document.querySelector(sel); return node && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(node).transform); }, selector, { timeout: 3000 });
const groupKeys = page => page.evaluate(() => [...document.querySelectorAll('#h5-attention-sheet .h5-attention-group')].map(node => node.dataset.group));
const idsIn = (page, group) => page.evaluate(key => [...document.querySelectorAll(`#h5-attention-sheet .h5-attention-group[data-group="${key}"] .h5-attention-row`)].map(node => Number(node.dataset.id)), group);
const row = (page, id) => page.locator(`#h5-attention-sheet .h5-attention-row[data-id="${id}"]`);
const notice = page => page.locator('.MuiSnackbar-root .MuiAlert-message');
const label = page => page.locator('#h5-attention').getAttribute('aria-label');
const layerDepth = page => page.evaluate(() => (history.state && history.state.h5Layer) || 0);
const row2 = page => page.evaluate(() => [...document.querySelectorAll('#h5-actions > button, #h5-actions > label')].filter(b => b.getBoundingClientRect().width > 0).map(b => ({ id: b.id || b.dataset.action, ...b.getBoundingClientRect().toJSON() })));

// Opens Settings → T-Attention and waits for the Plugins rows.
async function openPluginSettings(page, how) {
  await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
  await page.locator('#h5-settings').waitFor({ state: 'visible' });
  await openGroup(page, 'attention');
  await page.locator('#h5-plugins .h5-plugin').first().waitFor();
}
// The Plugins rows stay inside the sheet: no row is wider than its box and nothing reaches past the viewport.
const pluginsFit = page => page.evaluate(() => [...document.querySelectorAll('#h5-plugins .h5-plugin, .h5-plugin-page .MuiDialog-paper, .h5-plugin-page-body > *, .h5-plugin-page code')]
  .filter(node => node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > innerWidth + 0.5).map(node => node.className || node.id));

// One design on both layouts: what the panel shows (header, sections, rows, row buttons) and the edit view, read the same way on a phone and a computer.
const panelLayout = page => page.evaluate(() => {
  const panel = document.querySelector('#h5-attention-sheet .h5-attention-panel');
  const text = el => (el ? el.textContent.trim() : null);
  return {
    title: text(panel.querySelector('#h5-attention-title')),
    titleH6: panel.querySelector('#h5-attention-title').classList.contains('MuiTypography-h6'),
    counts: text(panel.querySelector('#h5-attention-counts')),
    add: Boolean(panel.querySelector('#h5-attention-add-input')),
    sections: [...panel.querySelectorAll('.h5-attention-group')].map(group => ({
      group: group.dataset.group, label: text(group.querySelector('.h5-attention-group-label') || group.querySelector('span.h5-attention-group-title')), count: text(group.querySelector('.h5-attention-group-count')),
    })),
    rows: [...panel.querySelectorAll('.h5-attention-row')].map(node => ({
      id: node.dataset.id, status: text(node.querySelector('.h5-attention-status')), detail: text(node.querySelector('.h5-attention-reason, .h5-attention-progress')),
      actions: [...node.querySelectorAll('.h5-attention-action')].map(text), link: Boolean(node.querySelector('.h5-attention-row-link')),
      session: text(node.querySelector('.h5-attention-session-name')), details: Boolean(node.querySelector('.h5-attention-details')),
      titleSize: getComputedStyle(node.querySelector('.h5-attention-title')).fontSize,
    })),
  };
});
let phoneLayout = null;
let phoneEdit = null;
const editLayout = page => page.evaluate(() => {
  const paper = document.querySelector('#h5-attention-edit .MuiDialog-paper');
  return {
    titleH6: paper.querySelector('#h5-attention-edit-title').classList.contains('MuiTypography-h6'),
    fields: [...paper.querySelectorAll('[id^="h5-attention-edit-"]')].map(node => node.id).filter(id => !/-label$|-helper-text$/.test(id)),
    actions: [...paper.querySelectorAll('.MuiDialogActions-root button')].map(node => node.id),
  };
});

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    // ── Phone 390x844, touch ──
    {
      const { context, page, errors, calls, db, fsReads } = await openPage(browser, { viewport: { width: 390, height: 844 } });
      // Row 2: Docs (the design document) and Attention take the places of the design document and Files buttons.
      await page.waitForFunction(() => document.getElementById('h5-attention').getAttribute('aria-label') === 'Attention (1)');
      assert.equal(await page.locator('#h5-attention').getAttribute('title'), 'Attention (1)');
      assert.equal(await page.locator('#h5-attention .h5-attention-badge .MuiBadge-badge').textContent(), '1', 'the badge counts the tasks that need the user');
      assert.equal(await page.locator('#h5-files').count(), 0, 'no Files button in row 2');
      assert.equal(await page.locator('#h5-design').getAttribute('aria-label'), 'Docs');
      const buttons = await row2(page);
      // T-Attention is a destination of the bottom navigation (#h5-attention there), no longer a tool of row 2.
      assert.deepEqual(buttons.map(b => b.id).slice(-2), ['h5-design', 'h5-cycle']);
      assert.equal(buttons.length, 7);
      assert.ok(buttons.every(b => b.width >= 43.99 && b.height >= 43.99), `seven 44px buttons at 390px: ${JSON.stringify(buttons.map(b => [b.width, b.height]))}`);
      assert.equal(await page.locator('#h5-bnav #h5-attention').count(), 1, 'Attention is in the bottom navigation');
      assert.equal(await page.locator('#h5-attention-sheet').count(), 0, 'the panel is drawn only when it is opened');
      assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), ['GET /api/attention?include_done=1&limit=200'], 'the list is read once at start');
      assert.equal(await page.evaluate(() => window.streams.length), 1, 'the live stream is open');
      assert.equal(await page.evaluate(() => window.streams[0].url), '/api/attention/stream?tab=1', 'the top page opens this machine\'s stream as an open page (Open session of the desktop window)');

      // Open: the Home view (an older server: no parent_id): Needs you (waiting_user, then review), Working, To do, then "Done: N" folded; the
      // order inside a section.
      await page.locator('#h5-attention').tap();
      const sheet = page.locator('#h5-attention-sheet .h5-attention-panel');
      await sheet.waitFor({ state: 'visible' });
      await settled(page, '#h5-attention-sheet .h5-attention-panel');
      const box = await sheet.boundingBox();
      // A page of its own over the terminal page, ending at the bottom navigation (56px).
      assert.ok(box.width === 390 && Math.abs(box.height - (844 - 56)) <= 1 && box.y === 0, `full-screen sheet above the bottom navigation (${JSON.stringify(box)})`);
      assert.equal(await sheet.getAttribute('role'), 'dialog', 'the phone keeps its modal page (not the floating side sheet of a computer)');
      assert.equal(await page.locator('.h5-attention-outside').count(), 0, 'no outside layer on a phone');
      assert.deepEqual(await groupKeys(page), ['needs_you', 'working', 'todo', 'closed']);
      assert.deepEqual(await idsIn(page, 'needs_you'), [1, 2], 'waiting_user, then review');
      assert.deepEqual(await idsIn(page, 'todo'), [8, 5, 4], 'priority, then the earlier due date');
      assert.deepEqual(await idsIn(page, 'closed'), [], 'the finished tasks are folded');
      assert.equal(await page.locator('#h5-attention-closed-toggle').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#h5-attention-closed-toggle .h5-attention-group-title').textContent(), 'Done: 2');
      assert.equal(await row(page, 3).locator('.h5-attention-status').textContent(), 'Working', 'each row has its status');
      assert.equal(await row(page, 2).locator('.h5-attention-reason').textContent(), 'Claude finished. Review the result.');
      assert.equal(await row(page, 1).locator('.h5-attention-source').textContent(), 'claude', 'the source badge');
      assert.equal(await row(page, 1).locator('.h5-attention-reason').textContent(), 'Allow Bash: npm test', 'a row that needs the user shows what is pending');
      assert.equal(await row(page, 7).locator('.h5-attention-reason').count(), 0, 'the finished tasks are folded');
      assert.equal(await row(page, 3).locator('.h5-attention-reason').count(), 0, 'a working task shows no reason');
      assert.equal(await row(page, 4).locator('.h5-attention-source').count(), 0, 'no badge for the user\'s own task');
      // The header of the full-screen page: a back arrow first, the title in h6, the counts.
      phoneLayout = await panelLayout(page);
      assert.equal(phoneLayout.counts, 'Needs you: 2 · Open: 6', 'the header counts what needs the person and what is open');
      assert.equal(await page.locator('#h5-attention-close').getAttribute('aria-label'), 'Back', 'a back arrow on a phone');
      assert.equal(await page.evaluate(() => document.querySelector('.h5-attention-panel header').firstElementChild.id), 'h5-attention-close', 'the back arrow comes first');
      await row(page, 1).locator('.h5-attention-details').tap();
      await page.locator('#h5-attention-edit .MuiDialog-paper').waitFor({ state: 'visible' });
      phoneEdit = await editLayout(page);
      await page.keyboard.press('Escape');
      await page.locator('#h5-attention-edit').waitFor({ state: 'detached' });
      assert.deepEqual(phoneEdit.actions, ['h5-attention-edit-delete', 'h5-attention-edit-cancel', 'h5-attention-edit-save'], 'Delete, then Cancel and Save');
      await page.locator('#h5-attention-closed-toggle').tap();
      assert.deepEqual((await idsIn(page, 'closed')).sort(), [6, 7]);
      // 44px targets.
      const small = await page.evaluate(() => [...document.querySelectorAll('#h5-attention-sheet button, #h5-attention-sheet input')].map(node => { const r = (node.closest('.MuiInputBase-root') || node).getBoundingClientRect(); return { id: node.id || node.className.split(' ')[0], w: r.width, h: r.height }; }).filter(r => r.w && (r.w < 44 || r.h < 44)));
      assert.deepEqual(small, [], 'every control of the sheet is 44px');
      for (const id of ['h5-attention-close', 'h5-attention-add']) assert.equal(await page.locator(`#${id}`).getAttribute('aria-label'), await page.locator(`#${id}`).getAttribute('title'));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-phone.png') });

      // Quick add: POST { title }.
      await page.locator('#h5-attention-add-input').fill('  Buy milk ');
      await page.locator('#h5-attention-add-input').press('Enter');
      await page.waitForFunction(() => [...document.querySelectorAll('.h5-attention-title')].some(node => node.textContent === 'Buy milk'));
      const posted = calls.filter(call => call.method === 'POST' && call.path === '/api/attention');
      assert.deepEqual(posted.map(call => call.body), [{ title: 'Buy milk' }]);
      assert.equal(await page.locator('#h5-attention-add-input').inputValue(), '', 'the box is emptied');
      assert.ok((await idsIn(page, 'todo')).includes(100));

      // The circle: done from any status (a task in review here).
      await row(page, 2).locator('.h5-attention-check').tap();
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-group[data-group="closed"] .h5-attention-row[data-id="2"]'));
      assert.deepEqual(calls.filter(call => call.method === 'PATCH').map(call => [call.path, call.body]), [['/api/attention/2', { status: 'done' }]]);
      assert.deepEqual(await groupKeys(page), ['needs_you', 'working', 'todo', 'closed'], 'an empty section stays');
      assert.equal(await page.locator('#h5-attention-closed-toggle .h5-attention-group-title').textContent(), 'Done: 3');

      // The edit view: history, PATCH of the changed fields, the link, the Android back button.
      await row(page, 4).locator('.h5-attention-open').tap();
      const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
      await edit.waitFor({ state: 'visible' });
      await page.locator('#h5-attention-history .h5-attention-event').first().waitFor();
      assert.equal(await page.locator('#h5-attention-history .h5-attention-event').count(), 4, 'the quiet context update is left out');
      assert.equal(await page.locator('#h5-attention-context').count(), 0, 'no context card for a task without context');
      assert.equal(await page.locator('#h5-attention-edit-name').inputValue(), 'Write release notes');
      assert.equal(await page.locator('#h5-attention-edit-priority').inputValue(), 'low');
      const editBox = await edit.boundingBox();
      assert.ok(editBox.width === 390, 'the edit view is full screen on a phone');
      await page.waitForFunction(() => (history.state && history.state.h5Layer) === 2);
      await page.goBack();
      await edit.waitFor({ state: 'hidden' });
      assert.ok(await sheet.isVisible(), 'back closes the edit view only');
      await row(page, 4).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      await page.locator('#h5-attention-edit-name').fill('Write the release notes');
      await page.locator('#h5-attention-edit-notes').fill('Draft first');
      await page.locator('#h5-attention-edit-priority').selectOption('medium');
      await page.locator('#h5-attention-edit-due').fill('2026-11-30');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-edit-phone.png') });
      await page.locator('#h5-attention-edit-save').tap();
      await edit.waitFor({ state: 'hidden' });
      assert.deepEqual(calls.filter(call => call.method === 'PATCH').at(-1), { method: 'PATCH', path: '/api/attention/4', body: { title: 'Write the release notes', notes: 'Draft first', priority: 'medium', due_date: '2026-11-30' } });
      assert.equal(await row(page, 4).locator('.h5-attention-title').textContent(), 'Write the release notes');
      assert.equal(await row(page, 4).locator('.h5-attention-due').textContent(), 'Due 2026-11-30');
      // A task with a link (moved to Done above): the link is a real link.
      await row(page, 2).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-edit-link').getAttribute('href'), 'https://example.test/pr/1');
      assert.equal(await page.locator('#h5-attention-edit-link').getAttribute('target'), '_blank');
      assert.equal(await page.locator('#h5-attention-edit-link').textContent(), 'PR #1');
      // Delete with a confirmation: Cancel keeps it, Delete removes it.
      await page.locator('#h5-attention-edit-delete').tap();
      await page.locator('#h5-attention-delete-cancel').tap();
      await page.locator('#h5-attention-delete .MuiDialog-paper').waitFor({ state: 'hidden' });
      assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
      await page.locator('#h5-attention-edit-delete').tap();
      await page.locator('#h5-attention-delete-confirm').tap();
      await edit.waitFor({ state: 'hidden' });
      assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/attention/2']);
      assert.equal(await row(page, 2).count(), 0);
      await notice(page).filter({ hasText: 'Task deleted' }).waitFor();

      // A live event moves a task into Needs you: toast, badge, sound, and no system notification.
      const tonesBefore = await page.evaluate(() => window.tones);
      const moved = { ...db.items.find(item => item.id === 3), status: 'waiting_user', attention_reason: 'Approve the plan?', updated_at: new Date().toISOString() };
      await page.evaluate(change => window.emitChange(change), { kind: 'updated', item: moved, previous: { ...moved, status: 'working' }, event: { actor: 'claude', type: 'status', from_status: 'working', to_status: 'waiting_user' } });
      await notice(page).filter({ hasText: 'Needs you: Refactor login — Approve the plan?' }).waitFor();
      await page.waitForFunction(() => document.getElementById('h5-attention').getAttribute('aria-label') === 'Attention (2)');
      assert.deepEqual(await idsIn(page, 'needs_you'), [3, 1], 'the newest change first');
      assert.deepEqual(await page.evaluate(() => [window.notes, window.permissionAsks]), [[], 0], 'no Notification is made and the permission is not asked for');
      assert.ok(await page.evaluate(() => window.tones) > tonesBefore, 'a sound was played');
      // A change made on this page gives no reminder (the edit view moves task 5 to review; the stream then reports it, actor 'user').
      await row(page, 5).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      await page.locator('#h5-attention-edit-status').selectOption('review');
      await page.locator('#h5-attention-edit-save').tap();
      await edit.waitFor({ state: 'hidden' });
      const mine = db.items.find(item => item.id === 5);
      const tonesMine = await page.evaluate(() => window.tones);
      await page.evaluate(change => window.emitChange(change), { kind: 'updated', item: mine, previous: { ...mine, status: 'todo' }, event: { actor: 'user', type: 'status' } });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.notes.length), 0, 'no notification for this page\'s own change');
      assert.equal(await page.evaluate(() => window.tones), tonesMine, 'no sound for this page\'s own change');
      // The same status from another program (a listener) does remind.
      const failed = { ...db.items.find(item => item.id === 8), status: 'failed', attention_reason: 'Card declined', updated_at: new Date().toISOString() };
      await page.evaluate(change => window.emitChange(change), { kind: 'updated', item: failed, previous: { ...failed, status: 'todo' }, event: { actor: 'cli' } });
      await notice(page).filter({ hasText: 'Failed: Pay invoice — Card declined' }).waitFor();
      assert.equal(await page.evaluate(() => window.notes.length), 0);
      // A plain Claude turn end: the task moves to Review, the sound stays, but no in-page notice.
      const quiet = { ...db.items.find(item => item.id === 4), status: 'review', attention_reason: 'Plain answer', updated_at: new Date().toISOString() };
      const tonesQuiet = await page.evaluate(() => window.tones);
      await page.evaluate(change => window.emitChange(change), { kind: 'updated', item: quiet, previous: { ...quiet, status: 'working' }, event: { actor: 'claude', type: 'status' }, plain_turn_end: true });
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-group[data-group="needs_you"] .h5-attention-row[data-id="4"]'));
      await page.waitForTimeout(300);
      assert.equal(await notice(page).filter({ hasText: `Review: ${quiet.title}` }).count(), 0, 'no in-page notice for a plain turn end');
      assert.equal(await page.evaluate(() => window.notes.length), 0, 'still no system notification');
      assert.ok(await page.evaluate(() => window.tones) > tonesQuiet, 'the sound is not changed');
      // The review after sub-agents: the same change without the marker does show the notice.
      const finished = { ...quiet, attention_reason: 'All sub-agents finished', updated_at: new Date().toISOString() };
      await page.evaluate(change => window.emitChange(change), { kind: 'updated', item: finished, previous: { ...finished, status: 'working' }, event: { actor: 'claude', type: 'status' } });
      await notice(page).filter({ hasText: `Review: ${quiet.title} — All sub-agents finished` }).waitFor();
      // A deleted task leaves the list.
      await page.evaluate(() => window.emitChange({ kind: 'deleted', item: { id: 100 } }));
      await page.waitForFunction(() => !document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="100"]'));

      // The stream is lost: it connects again by itself and reads the list again.
      const reads = () => calls.filter(call => call.method === 'GET' && call.path.startsWith('/api/attention?')).length;
      const readsBefore = reads();
      await page.evaluate(() => window.dropStream());
      await page.locator('#h5-attention-state', { hasText: 'Not live: reconnecting' }).waitFor();
      await page.waitForFunction(() => window.streams.length === 2 && window.streams[1].readyState === 1, null, { timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('h5-attention-state').textContent.trim() === '');
      assert.equal(reads(), readsBefore + 1, 'the list is read again after reconnecting');

      // Escape closes the sheet (one layer).
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
      await page.locator('#h5-attention').tap();
      await sheet.waitFor({ state: 'visible' });
      await page.waitForFunction(() => (history.state && history.state.h5Layer) === 1);
      await page.goBack();
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(await layerDepth(page), 0);

      // Context recall: the card of a task that needs the user.
      await page.locator('#h5-attention').tap();
      await sheet.waitFor({ state: 'visible' });
      await row(page, 1).locator('.h5-attention-details').tap();
      await edit.waitFor({ state: 'visible' });
      const card = page.locator('#h5-attention-context');
      await card.waitFor();
      assert.equal(await page.locator('#h5-attention-context-command').textContent(), 'npm test -- --watch=false');
      assert.ok((await page.locator('#h5-attention-context-pending').textContent()).includes('Allow Bash: npm test'));
      assert.equal(await page.locator('#h5-attention-edit-reason').count(), 0, 'the pending text replaces the reason box');
      assert.ok((await page.locator('#h5-attention-context-summary').textContent()).includes('Progress: form done, tests next'));
      assert.ok((await page.locator('#h5-attention-context-goal').textContent()).includes('Add a login page with a remember-me box'));
      assert.ok((await page.locator('#h5-attention-context-progress').textContent()).includes('The form is done. Next I run the tests.'));
      assert.ok((await page.locator('#h5-attention-context-progress').textContent()).includes('Turns: 3'));
      assert.equal(await page.locator('#h5-attention-context-place').textContent(), '/work/fix-login \u00b7 feat/login \u00b7 mac');
      assert.equal(await page.locator('.h5-attention-file[data-path="src/login.js"]').getAttribute('data-open'), 'true', 'a file of this machine (host mac) can be opened');
      assert.equal(await page.locator('.h5-attention-file[data-path="/etc/hosts"]').getAttribute('data-open'), 'true', 'also outside every task folder (any-path preview)');
      assert.equal(await page.locator('#h5-attention-context-elsewhere').count(), 0);
      assert.ok((await page.locator('.h5-attention-file[data-path="src/login.js"]').textContent()).includes('+40'));
      // The timeline: by day, oldest first, readable sentences.
      await page.locator('#h5-attention-history .h5-attention-event').first().waitFor();
      assert.equal(await page.locator('#h5-attention-history .h5-attention-day').count(), 2);
      const sentences = await page.locator('#h5-attention-history .h5-attention-sentence').allTextContents();
      assert.deepEqual(sentences, ['Created \u00b7 claude', 'You asked: Add a login page', 'Asked for permission: Bash: npm test', 'Now needs you \u00b7 claude']);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-context-phone.png') });
      // AI summary refresh.
      await page.locator('#h5-attention-summary-refresh').tap();
      await notice(page).filter({ hasText: 'A new summary was asked for' }).waitFor();
      assert.deepEqual(calls.filter(call => call.path.endsWith('/summarize')).map(call => [call.method, call.path]), [['POST', '/api/attention/1/summarize']]);
      // A refused refresh (409 SUMMARY_DISABLED) shows the server's message, not the code.
      await page.waitForFunction(() => !document.querySelector('#h5-attention-summary-refresh').disabled);
      await page.locator('#h5-attention-summary-refresh').tap();
      await notice(page).filter({ hasText: 'Could not ask for a summary: The AI summary is switched off; turn it on in Settings first' }).waitFor();
      // Open terminal: the T-Agent terminal of the task (t2); the edit view and the sheet close.
      assert.equal(await page.locator('#h5-attention-jump').textContent(), 'Open terminal');
      await page.locator('#h5-attention-jump').tap();
      await sheet.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => window.sockets.some(socket => socket.url.includes('t2')) && document.getElementById('h5-session-name').textContent === 'Claude 1');
      // A file of the context opens in the file sheet (inside the folder of task 1).
      await page.locator('#h5-attention').tap();
      await sheet.waitFor({ state: 'visible' });
      await row(page, 1).locator('.h5-attention-details').tap();
      await page.locator('.h5-attention-file[data-path="src/login.js"] button').tap();
      await page.locator('#h5-design-body .h5-file-line').first().waitFor();
      assert.equal(await page.locator('#h5-design-title').textContent(), 'login.js');
      assert.equal(await page.locator('#h5-design-path').textContent(), '/work/fix-login/src/login.js');
      assert.deepEqual(fsReads, ['/work/fix-login/src/login.js'], 'read with the local any-path read');
      await page.locator('#h5-design-close').tap();
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
      // A file outside every task folder opens the same way.
      await page.locator('#h5-attention').tap();
      await sheet.waitFor({ state: 'visible' });
      await row(page, 1).locator('.h5-attention-details').tap();
      await page.locator('.h5-attention-file[data-path="/etc/hosts"] button').tap();
      await page.locator('#h5-design-body .h5-file-line').first().waitFor();
      assert.equal(await page.locator('#h5-design-title').textContent(), 'hosts');
      assert.deepEqual(fsReads, ['/work/fix-login/src/login.js', '/etc/hosts']);
      await page.locator('#h5-design-close').tap();
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
      // Copy resume command: a task whose T-Agent task is not in this list.
      await page.locator('#h5-attention').tap();
      await sheet.waitFor({ state: 'visible' });
      if (await page.locator('#h5-attention-closed-toggle').getAttribute('aria-expanded') === 'false') await page.locator('#h5-attention-closed-toggle').tap();
      await row(page, 7).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-jump').textContent(), 'Copy resume command');
      // A session of another machine (host linux-box, this Client is mac): its files show only their paths, and the card says why.
      assert.equal(await page.locator('.h5-attention-file[data-path="deploy.sh"]').getAttribute('data-open'), null);
      assert.equal(await page.locator('.h5-attention-file[data-path="deploy.sh"] button').count(), 0);
      assert.equal(await page.locator('#h5-attention-context-elsewhere').textContent(), 'These files are on linux-box; only their paths are shown here');
      await page.locator('#h5-attention-jump').tap();
      await notice(page).filter({ hasText: 'Resume command copied' }).waitFor();
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });

      // Settings "T-Attention": tokens (shown once, revoke), sound, system notifications.
      await page.evaluate(() => window.H5UI.set({ settingsOpen: true }));
      await page.locator('#h5-settings').waitFor({ state: 'visible' });
      await openGroup(page, 'attention');
      await page.locator('#h5-attention-tokens .h5-attention-token').first().waitFor();
      // AI summary: off by default; provider and model; the privacy note.
      assert.equal(await page.locator('#h5-attention-summary-enabled').isChecked(), false);
      assert.ok((await page.locator('#h5-attention-summary-privacy').textContent()).includes('sent to the chosen provider'));
      assert.deepEqual(await page.locator('#h5-attention-summary-provider option').allTextContents(), ['DeepSeek', 'GLM (no key saved)']);
      await page.locator('#h5-attention-summary-enabled').tap();
      await page.locator('#h5-attention-summary-provider').selectOption('glm');
      await page.locator('#h5-attention-summary-model').fill(' glm-4-flash ');
      await page.locator('#h5-attention-summary-save').tap();
      // GLM has no saved key: the server refuses (409 SUMMARY_PROVIDER_NOT_CONFIGURED) and the page shows its message.
      await page.locator('#h5-attention-summary-feedback', { hasText: 'Failed: Save a GLM API key in the translation settings first' }).waitFor();
      await page.locator('#h5-attention-summary-provider').selectOption('deepseek');
      await page.locator('#h5-attention-summary-model').fill('');
      await page.locator('#h5-attention-summary-save').tap();
      await page.locator('#h5-attention-summary-feedback', { hasText: 'Saved' }).waitFor();
      assert.deepEqual(calls.filter(call => call.path === '/api/attention/settings/summary' && call.method === 'PUT').map(call => call.body), [{ enabled: true, provider: 'glm', model: 'glm-4-flash' }, { enabled: true, provider: 'deepseek', model: '' }]);
      assert.equal(await page.locator('#h5-attention-summary-provider').inputValue(), 'deepseek', 'the saved provider is shown again (an id, not a list index)');
      assert.equal(await page.locator('#h5-attention-summary-enabled').isChecked(), true, 'the saved setting is shown again');
      assert.equal(await page.locator('#h5-attention-tokens .h5-attention-token').count(), 1);
      // Plugins: read when the group opened, one compact row per plugin; no forms, steps or per-plugin reads on the list.
      await page.locator('#h5-plugins .h5-plugin').first().waitFor();
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#h5-set-attention .h5-attention-slot')].map(node => node.dataset.slot)), ['plugins', 'widget', 'skill'], 'the plugins come right after the reminders, then the desktop window card (AttentionWidgetSettings.jsx), then the pointer to the agent skills');
      const listRow = (kind, name) => page.locator(`#h5-plugins .h5-plugin-${kind}[data-name="${name}"]`);
      const chipsOf = (kind, name) => listRow(kind, name).locator('.h5-plugin-chip').allTextContents();
      const detail = name => page.locator(`.h5-plugin-page[data-name="${name}"]`);
      const pageTop = name => detail(name).locator('.h5-plugin-page-body');
      const backToList = async name => { await detail(name).locator('.h5-plugin-page-back').tap(); await detail(name).waitFor({ state: 'detached' }); };
      const openDetail = async (kind, name) => { await listRow(kind, name).tap(); await detail(name).locator('.h5-plugin-page-title').waitFor(); };
      assert.equal(await page.locator('#h5-plugins-panel-installed input, #h5-plugins-panel-installed select, #h5-plugins-panel-installed textarea, #h5-plugins-panel-installed code, #h5-plugins-panel-installed .h5-plugin-steps, #h5-plugins-panel-installed .h5-plugin-config').count(), 0, 'no config fields or steps on the list');
      assert.deepEqual(await page.locator('#h5-plugins .h5-plugin-kind').allTextContents(), ['Listener', 'Listener', 'Notifier', 'Notifier']);
      assert.deepEqual(await chipsOf('listener', 'claude'), ['Installed', 'Hooks synced']);
      assert.equal(await listRow('listener', 'claude').locator('.h5-plugin-activity').textContent(), '3 open · Last event 5 min ago');
      assert.deepEqual(await chipsOf('listener', 'codex'), ['Not installed']);
      assert.equal(await listRow('listener', 'codex').locator('.h5-plugin-activity').textContent(), 'No open items · No events yet');
      assert.deepEqual(await chipsOf('notifier', 'telegram'), ['Configured']);
      assert.equal(await listRow('notifier', 'telegram').locator('.h5-plugin-summary').textContent(), 'Logged in as Ann → account 2 @bob');
      assert.deepEqual(await chipsOf('notifier', 'broken'), ['Failed to load']);
      assert.equal(await listRow('notifier', 'broken').locator('.h5-plugin-error').textContent(), 'Bad manifest: no send()');
      assert.equal(await page.locator('#h5-plugins-rules-open').isVisible(), true, 'the rules of all notifiers are a row under the list');
      assert.equal(await listRow('listener', 'claude').evaluate(node => node.tagName), 'BUTTON', 'a row is a real button');
      assert.equal(await listRow('listener', 'claude').locator('svg').count(), 1, 'with a chevron');
      assert.deepEqual(calls.filter(call => /^\/api\/attention\/plugins\/[^/]+\//.test(call.path) || call.path.startsWith('/api/attention-notify')), [], 'no per-plugin reads on the list');
      assert.deepEqual(await pluginsFit(page), []);
      // The first-run guide (AttentionGuide.jsx, its own test: test-h5-attention-guide-browser.cjs) reads the overview with its flags; not counted here.
      const pluginReads = () => calls.filter(call => call.path === '/api/attention/plugins').length - calls.filter(call => call.method === 'GET' && call.path === '/api/attention/settings/guide').length;
      assert.equal(pluginReads(), 1, 'read once when the group opened');
      // Back keeps the scroll position; the Android back button and the browser's back work like the other sheets (one history entry for the page).
      const scrollTop = () => page.evaluate(() => document.querySelector('#h5-settings-page .h5-settings-body').scrollTop);
      await listRow('notifier', 'broken').scrollIntoViewIfNeeded();
      await page.evaluate(() => { const body = document.querySelector('#h5-settings-page .h5-settings-body'); body.scrollTop = Math.min(body.scrollHeight, document.querySelector('#h5-plugins').getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop); });
      const depthOnList = await layerDepth(page);
      await openDetail('notifier', 'broken'); // Playwright scrolls the row into view for the tap: the position to keep is the one the page was opened at
      const scrolled = await scrollTop();
      assert.ok(scrolled > 0, 'the sheet is scrolled');
      assert.equal(await page.locator('.h5-plugin-page-title').textContent(), 'broken');
      assert.equal(await pageTop('broken').locator('.h5-plugin-config').count(), 0, 'a plugin that failed to load has no settings');
      assert.equal(await pageTop('broken').locator('.h5-plugin-error').textContent(), 'Bad manifest: no send()');
      await page.waitForFunction(depth => history.state && history.state.h5Layer === depth, depthOnList + 1);
      await page.goBack();
      await detail('broken').waitFor({ state: 'detached' });
      assert.ok(await page.locator('#h5-settings-page .h5-settings-body').isVisible(), 'back closes the plugin page, not the group page');
      await page.waitForFunction(depth => history.state && history.state.h5Layer === depth, depthOnList);
      assert.equal(await scrollTop(), scrolled, 'the scroll position is kept');
      await page.waitForFunction(() => document.getElementById('h5-plugins').getAttribute('aria-busy') === 'false');
      assert.equal(pluginReads(), 2, 'the list is read again on the way back');
      // A row opened with the keyboard and closed with Escape: the focus goes back to the row.
      await listRow('listener', 'codex').focus();
      await page.keyboard.press('Enter');
      await detail('codex').locator('.h5-plugin-page-back').waitFor();
      await page.keyboard.press('Escape');
      await detail('codex').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.activeElement.dataset.name), 'codex', 'the focus returns to the row');
      // The sheet closing by itself takes the page with it.
      await openDetail('listener', 'codex');
      await page.evaluate(() => window.H5UI.set({ settingsOpen: false }));
      await detail('codex').waitFor({ state: 'detached' });
      await page.locator('#h5-settings').waitFor({ state: 'hidden' });
      await openPluginSettings(page, 'tap');
      // A listener's page shows what was on the row before: the setup steps and their Copy buttons.
      await openDetail('listener', 'codex');
      assert.equal(await pageTop('codex').locator('.h5-plugin-activity').textContent(), 'No open items · No events yet');
      assert.equal(await page.locator('#h5-plugin-login-codex').textContent(), `t-attention login --url ${ORIGIN} --token <token>`);
      assert.equal(await page.locator('#h5-plugin-sync-codex').textContent(), 'ta');
      await page.evaluate(() => { window.copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied.push(text); } } }); });
      await pageTop('codex').locator('.h5-plugin-copy').first().tap();
      await pageTop('codex').locator('.h5-plugin-copy', { hasText: 'Copied' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.copied), [`t-attention login --url ${ORIGIN} --token <token>`]);
      assert.deepEqual(await pluginsFit(page), []);
      await backToList('codex');
      // A notifier's page: the summary and modes, Telegram's login, and the form drawn from the schema: it echoes the saved values (a secret only as
      // "saved"), Save sends only what the person typed, the switch turns the plugin off ("Disabled" chip on the page and on the list), Test answers on the page.
      await openDetail('notifier', 'telegram');
      const telegram = pageTop('telegram');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-plugin-detail-phone.png') });
      assert.equal(await telegram.locator('.h5-plugin-summary').textContent(), 'Logged in as Ann → account 2 @bob');
      assert.equal(await telegram.locator('.h5-plugin-modes').textContent(), 'Needs you: Call · Review: Message');
      await telegram.locator('#h5-tg-state').waitFor();
      await page.locator('#h5-plugin-config-telegram-callSeconds').waitFor();
      assert.equal(await page.locator('#h5-plugin-config-telegram-callSeconds').inputValue(), '45', 'the saved value is shown');
      assert.equal(await page.locator('#h5-plugin-config-telegram-botToken').inputValue(), '', 'a secret is never filled in');
      assert.equal(await page.locator('#h5-plugin-config-telegram-botToken').getAttribute('placeholder'), 'Saved; leave empty to keep it');
      assert.equal(await page.locator('#h5-plugin-enabled-telegram').isChecked(), true);
      assert.equal((await page.content()).includes('saved-secret-value'), false);
      await page.locator('#h5-plugin-config-telegram-callSeconds').fill('2');
      await telegram.locator('.h5-plugin-config-save').tap();
      await page.locator('#h5-plugin-config-feedback-telegram', { hasText: 'Ring time (seconds) is out of range' }).waitFor();
      const configPuts = () => calls.filter(call => call.path === '/api/attention/plugins/telegram/config' && call.method === 'PUT').map(call => call.body);
      assert.deepEqual(configPuts(), [], 'checked in the page first');
      await page.locator('#h5-plugin-config-telegram-callSeconds').fill('60');
      await telegram.locator('.h5-plugin-config-save').tap();
      await page.locator('#h5-plugin-config-feedback-telegram', { hasText: 'Saved' }).waitFor();
      assert.deepEqual(configPuts(), [{ values: { callSeconds: 60 } }], 'the empty secret is left out, so the saved one is kept');
      assert.equal(db.configs.telegram.secret, 'saved-secret-value');
      await telegram.locator('.h5-plugin-config-test').tap();
      await page.locator('#h5-plugin-config-feedback-telegram', { hasText: 'Test sent' }).waitFor();
      await page.locator('#h5-plugin-enabled-telegram').tap();
      await page.waitForFunction(() => document.getElementById('h5-plugin-enabled-telegram') && !document.getElementById('h5-plugin-enabled-telegram').checked);
      await telegram.locator('.h5-plugin-chip', { hasText: 'Disabled' }).waitFor();
      assert.deepEqual(configPuts().at(-1), { enabled: false });
      assert.equal(await telegram.locator('.h5-plugin-config-test').isDisabled(), true, 'no test while switched off');
      await page.locator('#h5-plugin-enabled-telegram').tap();
      await page.waitForFunction(() => document.getElementById('h5-plugin-enabled-telegram').checked);
      await telegram.locator('.h5-plugin-chip', { hasText: 'Disabled' }).waitFor({ state: 'detached' });
      await telegram.locator('.h5-plugin-config-clear').tap();
      await telegram.locator('.h5-plugin-config-clear').waitFor({ state: 'detached' });
      assert.equal(configPuts().at(-1).values.botToken, null, 'Remove clears the saved secret');
      assert.equal(db.configs.telegram.secret, '');
      assert.deepEqual(await pluginsFit(page), []);
      if (SHOTS) { await telegram.locator('.h5-plugin-config').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'h5-attention-plugin-config-phone.png') }); }
      await backToList('telegram');
      assert.deepEqual(await chipsOf('notifier', 'telegram'), ['Configured']);
      assert.equal(await page.locator('#h5-plugins-refresh').getAttribute('aria-label'), 'Refresh');
      assert.equal(await page.locator('#h5-plugins-refresh').getAttribute('title'), 'Refresh');
      await page.waitForFunction(() => document.getElementById('h5-plugins').getAttribute('aria-busy') === 'false');
      const beforeRefresh = pluginReads();
      await page.locator('#h5-plugins-refresh').tap();
      await page.waitForFunction(() => document.getElementById('h5-plugins').getAttribute('aria-busy') === 'false');
      assert.equal(pluginReads(), beforeRefresh + 1, 'Refresh reads the list again');
      // Easy install: claude's page says that T-Agent terminals connect by themselves; its hooks are an older version, so "Update the hooks".
      await openDetail('listener', 'codex');
      assert.equal(await pageTop('codex').locator('.h5-plugin-actions').count(), 0, 'a listener without an installer has no actions');
      await backToList('codex');
      await openDetail('listener', 'claude');
      const claude = pageTop('claude');
      assert.equal(await claude.locator('.h5-plugin-auto').textContent(), 'Connects automatically in T-Agent terminals');
      assert.equal(await claude.locator('.h5-plugin-steps').count(), 0, 'a listener set up here shows no steps');
      assert.equal(await claude.locator('.h5-plugin-install').textContent(), 'Update the hooks');
      const beforeInstall = pluginReads();
      await claude.locator('.h5-plugin-install').tap();
      await claude.locator('.h5-plugin-actions', { hasText: 'Claude Code hooks added to ~/.claude/settings.json; the saved login still works.' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.h5-plugin-page[data-name="claude"] .h5-plugin-install'));
      assert.equal(pluginReads(), beforeInstall + 1, 'the list is read again after the install');
      assert.equal(calls.filter(call => call.path === '/api/attention/plugins/claude/install' && call.method === 'POST').length, 1);
      assert.equal(await claude.locator('.h5-plugin-uninstall').count(), 1);
      // Another machine: the pairing dialog (over the page) with the code, the countdown and the command; it sees the claim and reads the list again.
      const beforePairing = pluginReads();
      await claude.locator('.h5-plugin-pair').tap();
      await page.locator('#h5-pairing-code').waitFor();
      assert.equal(await page.locator('#h5-pairing-code').textContent(), '123 456');
      assert.match(await page.locator('#h5-pairing-countdown').textContent(), /^Valid for (10:00|9:5\d)$/);
      assert.equal(await page.locator('#h5-pairing-command').textContent(), `t-attention pair 123456 --url ${ORIGIN}`);
      assert.deepEqual(calls.filter(call => call.path === '/api/attention/pairing' && call.method === 'POST').map(call => call.body), [{ origin: ORIGIN }]);
      await page.locator('#h5-pairing-copy').tap();
      await page.locator('#h5-pairing-copy', { hasText: 'Copied' }).waitFor();
      assert.equal(await page.evaluate(() => window.copied.at(-1)), `t-attention pair 123456 --url ${ORIGIN}`);
      const pairingFits = await page.evaluate(() => { const box = document.querySelector('#h5-pairing .MuiDialog-paper').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; });
      assert.equal(pairingFits, true, 'the dialog fits the phone');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-pairing-phone.png') });
      await page.locator('#h5-pairing-done').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('#h5-pairing-done').textContent(), 'Connected: claude listener (laptop)');
      assert.equal(pluginReads(), beforePairing + 1, 'a claim reads the list again');
      await page.locator('#h5-pairing-close').tap();
      await page.locator('#h5-pairing').waitFor({ state: 'detached' });
      assert.equal(calls.filter(call => call.path === '/api/attention/pairing' && call.method === 'DELETE').length, 0, 'a used code is not cancelled');
      assert.deepEqual(await pluginsFit(page), []);
      await backToList('claude');
      // The rules row opens the rules of all notifiers.
      await page.locator('#h5-plugins-rules-open').tap();
      await page.locator('#h5-notifier-rules').waitFor();
      assert.equal(await page.locator('.h5-plugin-page-title').textContent(), 'Message and call rules');
      await backToList('rules');
      if (SHOTS) { await page.locator('#h5-plugins').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'h5-attention-plugins-phone.png') }); }
      assert.equal(await page.locator('#h5-attention-sound').isChecked(), true, 'sound is on by default');
      for (const id of ['h5-attention-notify-state', 'h5-attention-notify-on', 'h5-attention-notify-off', 'h5-attention-notify-test']) assert.equal(await page.locator(`#${id}`).count(), 0, `no system notification control: ${id}`);
      assert.equal(await page.getByText(/system notification/i).count(), 0, 'Settings offer no system notifications');
      await page.locator('#h5-attention-sound').tap();
      assert.equal(await page.evaluate(() => localStorage.getItem('h5-attention-sound')), '0');
      await page.locator('#h5-attention-token-create').tap();
      await page.locator('#h5-attention-token-feedback', { hasText: 'Enter a name for the token' }).waitFor();
      await page.locator('#h5-attention-token-name').fill('phone hooks');
      await page.locator('#h5-attention-token-create').tap();
      await page.locator('#h5-attention-token-value').waitFor();
      assert.equal(await page.locator('#h5-attention-token-value').textContent(), 'tatt_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG');
      assert.deepEqual(calls.filter(call => call.path === '/api/attention/tokens' && call.method === 'POST').map(call => call.body), [{ name: 'phone hooks' }]);
      await page.waitForFunction(() => document.querySelectorAll('#h5-attention-tokens .h5-attention-token').length === 2);
      if (SHOTS) { await page.locator('#h5-set-attention').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'h5-attention-settings-phone.png') }); }
      await page.locator('#h5-attention-tokens .h5-attention-token[data-id="1"] .h5-attention-token-revoke').tap();
      await page.locator('#h5-attention-tokens .h5-attention-token[data-id="1"] .h5-attention-token-revoked').waitFor();
      assert.deepEqual(calls.filter(call => call.method === 'DELETE' && call.path.startsWith('/api/attention/tokens/')).map(call => call.path), ['/api/attention/tokens/1']);
      // With the sound off a reminder is a toast only.
      const before = await page.evaluate(() => [window.notes.length, window.tones]);
      const again = { ...db.items.find(item => item.id === 4), status: 'review', updated_at: new Date().toISOString() };
      await page.evaluate(change => window.emitChange(change), { kind: 'updated', item: again, previous: { ...again, status: 'todo' }, event: { actor: 'claude' } });
      await notice(page).filter({ hasText: 'Review: Write the release notes' }).waitFor();
      assert.deepEqual(await page.evaluate(() => [window.notes.length, window.tones]), before);
      assert.deepEqual(await page.evaluate(() => [window.notes.length, window.permissionAsks]), [0, 0], 'no system notification in the whole run');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 390x844, touch: links on the rows, in the edit view and in its texts ──
    {
      const LINKED = [
        { id: 1, title: 'Read the spec', status: 'todo', priority: 'none', source: 'user', link_url: 'https://example.test/spec', link_label: 'Spec', updated_at: AT, created_at: AT },
        { id: 2, title: 'Open the chat about the release plan for the next version', status: 'todo', priority: 'none', source: 'user', link_url: '/?openChat=c1', updated_at: AT, created_at: AT },
        { id: 3, title: 'No link here', status: 'todo', priority: 'none', source: 'user', updated_at: AT, created_at: AT },
        { id: 4, title: 'Approve the deploy', status: 'waiting_user', priority: 'none', source: 'cli', attention_reason: 'Check https://example.test/run/7. Then javascript:alert(1)', prompt_text: 'Deploy https://example.test/build/3', updated_at: AT, created_at: AT },
        { id: 5, title: 'Bad link', status: 'todo', priority: 'none', source: 'cli', link_url: 'javascript:alert(1)', updated_at: AT, created_at: AT },
        { id: 6, title: 'Summarized', status: 'waiting_user', priority: 'none', source: 'claude', updated_at: AT, created_at: AT,
          context: { pending: { kind: 'question', text: 'Which one? See https://example.test/a or https://example.test/b.' }, last_reply: 'Opened https://example.test/pr/9 for it.', summary: { text: 'Doing: https://example.test/doc', at: AT } } },
      ];
      const { context, page, errors, calls } = await openPage(browser, { viewport: { width: 390, height: 844 }, items: LINKED });
      await page.locator('#h5-attention').tap();
      await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'visible' });
      await settled(page, '#h5-attention-sheet .h5-attention-panel');
      // The row link: a real link with the label (or "Open link") as its name.
      const spec = row(page, 1).locator('a.h5-attention-row-link');
      assert.equal(await spec.getAttribute('href'), 'https://example.test/spec');
      assert.equal(await spec.getAttribute('target'), '_blank');
      assert.equal(await spec.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await spec.getAttribute('aria-label'), 'Spec');
      assert.equal(await spec.getAttribute('title'), 'Spec');
      const chat = row(page, 2).locator('a.h5-attention-row-link');
      assert.equal(await chat.getAttribute('href'), '/?openChat=c1');
      assert.equal(await chat.getAttribute('target'), null, 'a page path opens in this tab');
      assert.equal(await chat.getAttribute('aria-label'), 'Open link');
      assert.equal(await row(page, 3).locator('.h5-attention-row-link').count(), 0, 'no link, no button');
      assert.equal(await row(page, 5).locator('.h5-attention-row-link').count(), 0, 'an unsafe link gets no button');
      const linkBox = await spec.boundingBox();
      assert.ok(linkBox.width >= 43.99 && linkBox.height >= 43.99, `a 44px target on touch: ${JSON.stringify(linkBox)}`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'att-link-row.png') });
      // A tap opens the link in a new tab and never the edit view.
      const [popup] = await Promise.all([context.waitForEvent('page'), spec.tap()]);
      await popup.close();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#h5-attention-edit').count(), 0, 'the edit view stays closed');
      // At 320px the row keeps room for its title and the link stays inside the row.
      await page.setViewportSize({ width: 320, height: 640 });
      const fit = await page.evaluate(() => { const r = document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="2"]'); const l = r.querySelector('.h5-attention-row-link').getBoundingClientRect(); const t = r.querySelector('.h5-attention-title').getBoundingClientRect(); const b = r.getBoundingClientRect(); return { right: l.right, rowRight: b.right, title: t.width, overlap: t.right > l.left + 0.5, wide: document.getElementById('h5-attention-body').scrollWidth > document.getElementById('h5-attention-body').clientWidth }; });
      assert.ok(fit.right <= fit.rowRight + 0.5 && fit.title >= 150 && !fit.overlap && !fit.wide, `fits at 320px: ${JSON.stringify(fit)}`);
      await page.setViewportSize({ width: 390, height: 844 });

      // The edit view: the link fields come filled from the task.
      const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
      await row(page, 1).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-edit-link-url').inputValue(), 'https://example.test/spec');
      assert.equal(await page.locator('#h5-attention-edit-link-label').inputValue(), 'Spec');
      assert.equal(await page.locator('#h5-attention-edit-link-url').getAttribute('type'), 'url');
      assert.equal(await page.locator('#h5-attention-edit-link-url').getAttribute('inputmode'), 'url');
      assert.equal(await page.locator('#h5-attention-edit-link-url').getAttribute('maxlength'), '2000');
      assert.equal(await page.locator('#h5-attention-edit-link-label').getAttribute('maxlength'), '200');
      assert.equal(await page.locator('#h5-attention-edit-link').getAttribute('href'), 'https://example.test/spec', 'the saved link');
      if (SHOTS) {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#h5-attention-edit .MuiDialog-container')).opacity === '1'); // the fade is over
        await page.locator('#h5-attention-edit-link-url').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(SHOTS, 'att-link-edit.png') });
      }
      // A refused address: the server's message in the error line, the view stays open.
      await page.locator('#h5-attention-edit-link-url').fill('ftp://example.test/x');
      await page.locator('#h5-attention-edit-save').tap();
      await page.locator('#h5-attention-edit-error').waitFor();
      assert.equal(await page.locator('#h5-attention-edit-error').textContent(), 'Could not save: link_url must be an http(s) address or a page path starting with /');
      assert.ok(await edit.isVisible());
      // A changed address and label: only they are sent.
      await page.locator('#h5-attention-edit-link-url').fill('https://example.test/spec/v2');
      await page.locator('#h5-attention-edit-link-label').fill('Spec v2');
      await page.locator('#h5-attention-edit-save').tap();
      await edit.waitFor({ state: 'hidden' });
      assert.deepEqual(calls.filter(call => call.method === 'PATCH').at(-1), { method: 'PATCH', path: '/api/attention/1', body: { link_url: 'https://example.test/spec/v2', link_label: 'Spec v2' } });
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"] .h5-attention-row-link').getAttribute('href') === 'https://example.test/spec/v2');
      assert.equal(await spec.getAttribute('aria-label'), 'Spec v2');
      // Emptied fields clear the link (null); the row loses its button.
      await row(page, 1).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      await page.locator('#h5-attention-edit-link-url').fill('');
      await page.locator('#h5-attention-edit-link-label').fill('');
      await page.locator('#h5-attention-edit-save').tap();
      await edit.waitFor({ state: 'hidden' });
      assert.deepEqual(calls.filter(call => call.method === 'PATCH').at(-1).body, { link_url: null, link_label: null });
      await page.waitForFunction(() => !document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"] .h5-attention-row-link'));
      // A new link on a task without one.
      await row(page, 3).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-edit-link-url').inputValue(), '');
      assert.equal(await page.locator('#h5-attention-edit-link').count(), 0);
      await page.locator('#h5-attention-edit-link-url').fill('/?openChat=c9');
      await page.locator('#h5-attention-edit-save').tap();
      await edit.waitFor({ state: 'hidden' });
      assert.deepEqual(calls.filter(call => call.method === 'PATCH').at(-1).body, { link_url: '/?openChat=c9' });
      await row(page, 3).locator('a.h5-attention-row-link[href="/?openChat=c9"]').waitFor();

      // Web addresses in the read-only texts are links; javascript: text is not.
      await row(page, 4).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      const reasonLinks = await page.$$eval('#h5-attention-edit-reason a', nodes => nodes.map(node => [node.getAttribute('href'), node.textContent, node.target, node.rel, node.getAttribute('translate')]));
      assert.deepEqual(reasonLinks, [['https://example.test/run/7', 'https://example.test/run/7', '_blank', 'noopener noreferrer', 'no']]);
      assert.equal(await page.locator('#h5-attention-edit-reason').textContent(), 'Check https://example.test/run/7. Then javascript:alert(1)', 'the text reads as before');
      assert.equal(await page.locator('#h5-attention-edit a[href^="javascript:"]').count(), 0);
      // The history: the activity text with an address.
      await page.locator('#h5-attention-history .h5-attention-event').first().waitFor();
      assert.deepEqual(await page.$$eval('#h5-attention-history a.h5-attention-text-link', nodes => nodes.map(node => [node.getAttribute('href'), node.target, node.rel])), [['https://example.test/build/3', '_blank', 'noopener noreferrer']]);
      assert.equal(await page.locator('#h5-attention-edit-link-url').evaluate(node => node.tagName), 'INPUT', 'the inputs stay inputs');
      await page.locator('#h5-attention-edit-close').tap();
      await edit.waitFor({ state: 'hidden' });
      await row(page, 6).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      const cardLinks = await page.$$eval('#h5-attention-context a.h5-attention-text-link', nodes => nodes.map(node => node.getAttribute('href')));
      assert.deepEqual(cardLinks, ['https://example.test/a', 'https://example.test/b', 'https://example.test/doc', 'https://example.test/pr/9'], 'needs you, summary, progress');
      await page.locator('#h5-attention-edit-close').tap();
      await edit.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 390x844, touch: rows from a T-Agent session ("Rows of a session" in docs/design/page-attention.md) ──
    {
      const { context, page, errors, calls, db } = await openPage(browser, { viewport: { width: 390, height: 844 }, items: SESSION_ITEMS(), activity: { 1: { t2: 'done' } } });
      const sheet = page.locator('#h5-attention-sheet .h5-attention-panel');
      const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
      const shownName = () => page.locator('#h5-session-name').textContent();
      const patches = () => calls.filter(call => call.method === 'PATCH').length;
      await page.locator('#h5-attention').tap();
      await sheet.waitFor({ state: 'visible' });
      await settled(page, '#h5-attention-sheet .h5-attention-panel');
      // The chip: the terminal glyph, the session's name in the task list and its live state (t2 finished: Needs you; t1 idle).
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"] .h5-attention-session-dot[data-state="waiting"]'));
      assert.equal(await row(page, 1).locator('.h5-attention-session-name').textContent(), 'Claude 1');
      assert.equal(await row(page, 1).locator('.h5-attention-session').getAttribute('data-terminal'), 't2');
      assert.equal(await row(page, 1).locator('.h5-attention-session-dot').getAttribute('title'), 'Needs you');
      assert.equal(await row(page, 2).locator('.h5-attention-session-name').textContent(), 'Terminal 1');
      assert.equal(await row(page, 2).locator('.h5-attention-session-dot').getAttribute('data-state'), 'idle');
      assert.equal(await row(page, 1).locator('.h5-attention-meta .h5-attention-status + .h5-attention-session').count(), 1, 'the chip follows the status pill in the meta line');
      // No chip: a task added by hand, one from the CLI, one whose session is gone (t9 is not among the task's terminals), one of another machine.
      for (const id of [4, 5, 9]) assert.equal(await row(page, id).locator('.h5-attention-session').count(), 0, `no chip on ${id}`);
      for (const id of [4, 5, 9]) assert.equal(await row(page, id).locator('.h5-attention-details').count(), 0, `no Details button on ${id}`);
      // The row's name says what a tap does; the Details button has its own name and a 44px target, always shown on a touch screen.
      assert.equal(await row(page, 1).locator('.h5-attention-open').getAttribute('aria-label'), 'Allow Bash in the repo, open session Claude 1');
      assert.equal(await row(page, 4).locator('.h5-attention-open').getAttribute('aria-label'), null, 'a row without a session keeps its content as its name');
      const details = row(page, 1).locator('.h5-attention-details');
      assert.equal(await details.getAttribute('aria-label'), 'Details');
      assert.equal(await details.getAttribute('title'), 'Details');
      const detailsBox = await details.boundingBox();
      assert.ok(detailsBox.width >= 43.99 && detailsBox.height >= 43.99, `44px Details button: ${JSON.stringify(detailsBox)}`);
      assert.equal(await details.evaluate(node => getComputedStyle(node).opacity), '1', 'always shown on a touch screen');
      assert.equal(await page.locator('#h5-attention-hint').count(), 0, 'the hint is for the side panel only');
      assert.equal(await shownName(), 'Terminal 1');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'att-session-list-phone.png') });

      // Details opens the edit view (its "Open terminal" stays); the session is not opened.
      await details.tap();
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-edit-name').inputValue(), 'Allow Bash in the repo');
      assert.equal(await page.locator('#h5-attention-jump').textContent(), 'Open terminal');
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });
      assert.equal(await shownName(), 'Terminal 1');
      // A session that is gone: a tap opens the details, where the resume command can still be copied.
      await row(page, 9).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-jump').textContent(), 'Copy resume command');
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });
      // A task added by hand opens its details as before.
      await row(page, 4).locator('.h5-attention-open').tap();
      await edit.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });

      // The row buttons of a session row act on their own: the link, Reject (its dialog), never the session.
      const stays = async what => {
        await page.waitForTimeout(250);
        assert.ok(await sheet.isVisible(), `${what}: the page stays`);
        assert.equal(await page.locator('#h5-attention-edit').count(), 0, `${what}: no edit view`);
        assert.equal(await shownName(), 'Terminal 1', `${what}: no session opened`);
      };
      const [popup] = await Promise.all([context.waitForEvent('page'), row(page, 2).locator('a.h5-attention-row-link').tap()]);
      await popup.close();
      await stays('the link');
      await row(page, 2).locator('.h5-attention-action[data-action="reject"]').tap();
      await page.locator('#h5-attention-reject .MuiDialog-paper').waitFor({ state: 'visible' });
      await page.locator('#h5-attention-reject-cancel').tap();
      await page.locator('#h5-attention-reject').waitFor({ state: 'detached' });
      await stays('Reject');

      // A tap on the row opens its session: the task and terminal are selected, the T-Attention page closes and the bottom navigation shows Sessions;
      // the status is not changed (no PATCH); a notice names the task with a Details action.
      const before = patches();
      await row(page, 1).locator('.h5-attention-open').tap();
      await sheet.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => window.sockets.some(socket => socket.url.includes('t2')) && document.getElementById('h5-session-name').textContent === 'Claude 1');
      assert.equal(await page.locator('#h5-bnav .h5-bnav-item[data-view="sessions"]').getAttribute('aria-current'), 'page', 'Sessions is the shown destination');
      assert.equal(await page.locator('#h5-bnav .h5-bnav-item[data-view="attention"]').getAttribute('aria-current'), null);
      const snack = page.locator('.MuiSnackbar-root .h5-notice-action');
      await snack.waitFor({ state: 'visible' });
      assert.equal(await snack.locator('.MuiSnackbarContent-message').textContent(), 'Opened from T-Attention: Allow Bash in the repo');
      assert.equal(await snack.locator('.h5-notice-action-button').textContent(), 'Details');
      const snackBox = await snack.boundingBox();
      assert.ok(snackBox.y < 100 && snackBox.x >= 0 && snackBox.x + snackBox.width <= 390, `the notice stays at the top, inside the screen: ${JSON.stringify(snackBox)}`);
      assert.equal(patches(), before, 'opening the session sends no PATCH');
      assert.equal(db.items.find(item => item.id === 1).status, 'waiting_user', 'a "Needs you" task stays "Needs you"');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'att-session-opened-phone.png') });
      // Details of the notice brings the T-Attention page back with that task's details.
      await snack.locator('.h5-notice-action-button').tap();
      await sheet.waitFor({ state: 'visible' });
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-edit-name').inputValue(), 'Allow Bash in the repo');
      assert.equal(await page.locator('#h5-bnav .h5-bnav-item[data-view="attention"]').getAttribute('aria-current'), 'page');
      await snack.waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });
      assert.equal(await row(page, 1).getAttribute('data-shown'), null, 'no marked row on a phone');

      // Handled, Confirm and the circle of session rows send their own PATCH and open nothing (Claude 1 stays shown).
      const kept = async what => {
        await page.waitForTimeout(250);
        assert.ok(await sheet.isVisible(), `${what}: the page stays`);
        assert.equal(await page.locator('#h5-attention-edit').count(), 0, `${what}: no edit view`);
        assert.equal(await shownName(), 'Claude 1', `${what}: the shown session is kept`);
      };
      await row(page, 1).locator('.h5-attention-action[data-action="handled"]').tap();
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"][data-status="working"]'));
      await kept('Handled');
      await row(page, 2).locator('.h5-attention-action[data-action="confirm"]').tap();
      await page.waitForFunction(() => !document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="2"][data-status="review"]'));
      await kept('Confirm');
      await row(page, 1).locator('.h5-attention-check').tap();
      await page.waitForFunction(() => !document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"][data-status="working"]'));
      await kept('the circle');
      assert.deepEqual(calls.filter(call => call.method === 'PATCH').map(call => [call.path, call.body.status]), [['/api/attention/1', 'working'], ['/api/attention/2', 'done'], ['/api/attention/1', 'done']]);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Phone 320x640, touch: the seven tools fit, Docs among them ──
    {
      const { context, page, errors } = await openPage(browser, { viewport: { width: 320, height: 640 } });
      await page.waitForFunction(() => document.getElementById('h5-attention').getAttribute('aria-label') === 'Attention (1)');
      const buttons = await row2(page);
      assert.equal(buttons.length, 7, `seven buttons at 320px: ${buttons.map(b => b.id)}`);
      assert.ok(buttons.some(b => b.id === 'h5-design'), 'Docs fits at 320px');
      assert.equal(await page.locator('#h5-bnav #h5-attention').isVisible(), true, 'T-Attention in the bottom navigation');
      assert.ok(buttons.every((b, i) => b.width >= 43.99 && b.height >= 43.99 && b.right <= 320.01 && (i === 0 || buttons[i - 1].right <= b.left + 0.01)), `44px buttons: ${JSON.stringify(buttons.map(b => [b.left, b.right, b.height]))}`);
      if (SHOTS) await page.locator('#h5-actions').screenshot({ path: path.join(SHOTS, 'h5-attention-row2-320.png') });
      await page.locator('#h5-design').tap();
      await page.locator('#h5-design-body h1', { hasText: 'Design of Fix login' }).waitFor();
      await page.locator('#h5-design-close').tap();
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
      await page.locator('#h5-attention').tap();
      await settled(page, '#h5-attention-sheet .h5-attention-panel');
      const small = await page.evaluate(() => [...document.querySelectorAll('#h5-attention-sheet button')].map(node => node.getBoundingClientRect()).filter(r => r.width && (r.width < 44 || r.height < 44)).length);
      assert.equal(small, 0);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-phone-320.png') });
      // Settings → T-Attention → Plugins at 320px: the rows and the long login command fit, the buttons are 44px.
      await page.keyboard.press('Escape');
      await page.locator('#h5-attention-sheet .h5-attention-panel').waitFor({ state: 'hidden' });
      await openPluginSettings(page, 'tap');
      assert.deepEqual(await pluginsFit(page), []);
      await page.locator('#h5-plugins .h5-plugin-notifier[data-name="telegram"]').tap();
      await page.locator('.h5-plugin-page[data-name="telegram"] #h5-plugin-config-telegram-callSeconds').waitFor();
      assert.deepEqual(await pluginsFit(page), []);
      assert.equal(await page.evaluate(() => document.querySelector('.h5-plugin-page-body').scrollWidth <= document.querySelector('.h5-plugin-page-body').clientWidth), true, 'the page has no sideways scroll at 320px');
      const backBox = await page.locator('.h5-plugin-page-back').boundingBox();
      assert.ok(backBox.width >= 44 && backBox.height >= 44, `the back button is a finger target: ${JSON.stringify(backBox)}`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'h5-attention-plugin-detail-320.png') });
      await page.locator('.h5-plugin-page-back').tap();
      await page.locator('.h5-plugin-page').waitFor({ state: 'detached' });
      const smallPlugin = await page.evaluate(() => [...document.querySelectorAll('#h5-plugins button, #h5-plugins-refresh')].map(node => node.getBoundingClientRect()).filter(r => r.width && (r.width < 44 || r.height < 44)).length);
      assert.equal(smallPlugin, 0);
      if (SHOTS) { await page.locator('#h5-plugins-notifiers').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'h5-attention-plugins-320.png') }); }
      assert.deepEqual(errors, []);
      await context.close();
    }
    // At 360px the seven tools fit too, and the saved commands list has no Docs entry.
    {
      const { context, page, errors } = await openPage(browser, { viewport: { width: 360, height: 740 } });
      assert.equal((await row2(page)).length, 7);
      await page.locator('#h5-commands').tap();
      await page.locator('.h5-add-menu').waitFor();
      assert.equal(await page.locator('#h5-commands-docs').count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ── Computer 1440x900, mouse: the floating side sheet ──
    {
      const { context, page, errors, calls } = await openPage(browser, { viewport: { width: 1440, height: 900 }, touch: false });
      const resizes = () => page.evaluate(() => window.sockets.reduce((sum, socket) => sum + socket.sent.filter(data => data.includes('"resize"')).length, 0));
      const sentCount = () => page.evaluate(() => window.sockets.reduce((sum, socket) => sum + socket.sent.length, 0));
      // The boxes of the page under the sheet, and the cols of the terminal (the xterm grid that the PTY size follows).
      const layout = () => page.evaluate(() => {
        const box = id => (r => [r.x, r.y, r.width, r.height])(document.getElementById(id).getBoundingClientRect());
        const last = window.sockets.flatMap(socket => socket.sent).filter(data => data.includes('"resize"')).at(-1);
        return { app: box('h5-app'), terminal: box('h5-terminal'), bottom: box('h5-bottom'), chat: box('h5-agent'), cols: last ? JSON.parse(last).cols : null, screen: document.querySelector('#h5-terminal .xterm-screen')?.getBoundingClientRect().width };
      });
      // Counts the events that reach the terminal box (a press swallowed by the sheet's outside layer reaches nothing).
      await page.evaluate(() => { window.termEvents = 0; for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) document.getElementById('h5-terminal').addEventListener(type, () => { window.termEvents += 1; }, true); });
      const settledPanel = () => page.waitForFunction(() => { const p = document.querySelector('#h5-attention-sheet .h5-attention-panel'); return p && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(p).transform); });
      await page.waitForTimeout(300); // the first fit has been sent
      const buttons = await row2(page);
      // The computer row ("Bottom bar"): T-Attention is an item of More tools, under its old id.
      assert.deepEqual(buttons.map(b => b.id), ['h5-image', 'h5-voice', 'h5-commands', 'h5-design', 'h5-cycle', 'h5-more', 'h5-translate-button']);
      assert.equal(await page.locator('#h5-more-menu #h5-attention[role="menuitem"]').count(), 1, 'T-Attention is in More tools');
      // (It waits until the menu has gone: its invisible backdrop takes presses until its exit transition ends.)
      const attention = async () => { await page.locator('#h5-more').click(); await page.locator('#h5-attention').click(); await page.locator('#h5-more-menu').waitFor({ state: 'hidden' }); };
      const layoutBefore = await layout();
      const resizesBefore = await resizes();
      assert.ok(await page.locator('#h5-design').isVisible(), 'the wide row has its Docs button');
      await attention();
      const panel = page.locator('#h5-attention-sheet .h5-attention-panel');
      await panel.waitFor({ state: 'visible' });
      await settledPanel();
      // A floating side sheet: 480px wide, 8px from the top, right and bottom edges, 8px corners, elevation 16 with the dark theme's overlay.
      const sheetBox = await panel.evaluate(node => { const r = node.getBoundingClientRect(); const style = getComputedStyle(node); return { x: r.x, y: r.y, width: r.width, height: r.height, radius: style.borderTopLeftRadius, shadow: style.boxShadow, image: style.backgroundImage, z: Number(style.zIndex), border: style.borderLeftWidth }; });
      assert.deepEqual({ x: sheetBox.x, y: sheetBox.y, width: sheetBox.width, height: sheetBox.height }, { x: 1440 - 8 - 480, y: 8, width: 480, height: 900 - 16 }, 'inset 8px, 480px wide');
      assert.equal(sheetBox.radius, '8px');
      assert.equal(sheetBox.border, '0px', 'no border: the elevation sets it apart');
      assert.ok(/rgba\(0, 0, 0/.test(sheetBox.shadow) && sheetBox.shadow.split('rgba').length === 4, `the theme's elevation shadow: ${sheetBox.shadow}`);
      assert.ok(/linear-gradient\(rgba\(255, 255, 255, 0\.145\)/.test(sheetBox.image), `the dark theme's overlay of elevation 16: ${sheetBox.image}`);
      assert.ok(sheetBox.z > 1260 && sheetBox.z < 1300, `above the rail, under the menus and dialogs: ${sheetBox.z}`);
      // Nothing below is squeezed: the same boxes and the same terminal cols, no PTY resize.
      await page.waitForTimeout(300);
      assert.deepEqual(await layout(), layoutBefore, 'the page, the terminal, the bottom row and the chat keep their width');
      assert.equal(await resizes(), resizesBefore, 'no PTY resize when it opens');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-side-panel')), false, 'no layout attribute any more');
      assert.ok(await page.locator('#h5-design').isVisible(), 'the bottom row stays the wide one (Docs keeps its button)');
      assert.equal(await page.locator('#h5-attention-sheet .MuiBackdrop-root').count(), 0, 'no scrim');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.h5-attention-outside')).backgroundColor), 'rgba(0, 0, 0, 0)', 'the outside layer is transparent');
      await page.locator('#h5-attention-sheet .h5-attention-row').first().waitFor();
      // The same panel as the phone: header, sections with their counts, rows, statuses, detail lines and row buttons; only the way out differs.
      assert.deepEqual(await panelLayout(page), phoneLayout, 'the side panel shows what the phone shows');
      assert.equal(await page.locator('#h5-attention-close').getAttribute('aria-label'), 'Close', 'a close button on the side panel');
      assert.equal(await page.evaluate(() => document.querySelector('.h5-attention-panel header').lastElementChild.id), 'h5-attention-close', 'the close button comes last');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-attention.png') });
      // The edit view is a normal dialog; Escape closes it first, then the panel.
      await row(page, 1).locator('.h5-attention-details').click();
      const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
      await edit.waitFor({ state: 'visible' });
      assert.ok((await edit.boundingBox()).width < 700, 'a normal dialog on a wide screen');
      assert.deepEqual(await editLayout(page), phoneEdit, 'the same edit view as on the phone');
      assert.equal(await page.locator('#h5-attention-context-command').textContent(), 'npm test -- --watch=false', 'the context card on a wide screen too');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-attention-edit.png') });
      // Dialogs opened from the panel are not outside: the delete confirmation and a press on the dialog's own backdrop leave the panel open.
      await page.locator('#h5-attention-edit-delete').click();
      const confirm = page.locator('#h5-attention-delete .MuiDialog-paper');
      await confirm.waitFor({ state: 'visible' });
      await page.locator('#h5-attention-delete-cancel').click();
      await confirm.waitFor({ state: 'hidden' });
      assert.ok(await panel.isVisible(), 'the delete confirmation did not close the panel');
      await page.mouse.click(400, 450); // the edit view's backdrop
      await edit.waitFor({ state: 'hidden' });
      assert.ok(await panel.isVisible(), 'a press on the dialog backdrop closes the dialog only');
      await row(page, 1).locator('.h5-attention-details').click();
      await edit.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });
      assert.ok(await panel.isVisible(), 'Escape in the edit view leaves the panel open');
      await page.locator('#h5-attention-close').focus();
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      // The focus goes back to what had it when the panel opened: the More menu gives the focus back to the terminal before its item runs.
      const focused = () => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));
      assert.equal(await focused(), 'xterm-helper-textarea', 'the focus goes back to where it was when the panel opened (the terminal)');
      assert.equal(await resizes(), resizesBefore, 'no PTY resize when it closes');
      assert.deepEqual(await layout(), layoutBefore);
      // A press on the terminal outside the sheet closes it and does nothing else: no event reaches the terminal, nothing is sent to it, and the
      // focus goes back to the rail's Attention button that opened it, not to the terminal under the press.
      await page.locator('#h5-nav-attention').click();
      await panel.waitFor({ state: 'visible' });
      await settledPanel();
      assert.equal(await focused(), '', 'opening blurs the button (the focus is on nothing)');
      let sent = await sentCount();
      const term = layoutBefore.terminal;
      await page.mouse.click(term[0] + term[2] / 3, term[1] + term[3] / 2);
      await panel.waitFor({ state: 'hidden' });
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.termEvents), 0, 'the press did not reach the terminal');
      assert.equal(await focused(), 'h5-nav-attention', 'the focus is back on the rail button, not on the terminal');
      assert.equal(await sentCount(), sent, 'nothing was sent to the terminal');
      assert.equal(await page.locator('.h5-attention-outside').count(), 0, 'the outside layer is gone after the press');
      // The same press after it closed reaches the terminal again.
      await page.mouse.click(term[0] + term[2] / 3, term[1] + term[3] / 2);
      assert.ok(await page.evaluate(() => window.termEvents) > 0, 'a later press is the terminal\'s');
      // The close button closes it, and the focus goes back to More.
      await attention();
      await panel.waitFor({ state: 'visible' });
      await page.locator('#h5-attention-close').click();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(await focused(), 'xterm-helper-textarea');
      // The rail's Attention button opens it and closes it with one press each (no double toggle).
      await page.locator('#h5-nav-attention').click();
      await panel.waitFor({ state: 'visible' });
      await settledPanel();
      await page.locator('#h5-nav-attention').click({ force: true }); // the outside layer lies over the rail and takes the press
      await panel.waitFor({ state: 'hidden' });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.H5UI.get().attention.open), false, 'one press closed it and did not open it again');
      assert.equal(await page.locator('#h5-nav-attention').getAttribute('aria-expanded'), 'false');
      // One at a time: Docs takes the place of T-Attention; the sheet is a modal, so it is closed before the panel can open again. With the panel open
      // a press on the Docs button would only close the panel, so it is pressed with the keyboard.
      const docs = async () => {
        if (await page.locator('#h5-attention-sheet .h5-attention-panel').isVisible()) { await page.locator('#h5-design').focus(); await page.keyboard.press('Enter'); return; }
        await page.locator('#h5-design').click();
      };
      await attention();
      await panel.waitFor({ state: 'visible' });
      await docs();
      await page.locator('#h5-design-body h1', { hasText: 'Design of Fix login' }).waitFor();
      await panel.waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
      await attention();
      await panel.waitFor({ state: 'visible' });
      // The Docs sheet's Files button opens the tree, and the tree's Design document button leads back to DESIGN.md.
      await docs();
      await page.locator('#h5-design-files').click();
      await page.locator('#h5-files-sheet .h5-files-panel').waitFor({ state: 'visible' });
      await page.locator('#h5-files-design').click();
      await page.locator('#h5-design-body h1', { hasText: 'Design of Fix login' }).waitFor();
      assert.ok(await page.locator('#h5-design-back').isVisible(), 'the design document lies over the tree');
      await page.keyboard.press('Escape');
      await page.locator('#h5-design-sheet .h5-design-panel').waitFor({ state: 'hidden' });
      // The upper sheet has left the page, but the focus comes back to the tree a moment later; an Escape before that lands on the body and closes nothing.
      await page.waitForFunction(() => document.querySelector("#h5-files-sheet .h5-files-panel").contains(document.activeElement));
      await page.keyboard.press('Escape');
      await page.locator('#h5-files-sheet .h5-files-panel').waitFor({ state: 'hidden' });
      // The Attention button shows and hides the panel; keys typed in it are not sent to the terminal.
      await attention();
      await panel.waitFor({ state: 'visible' });
      const sentBefore = await page.evaluate(() => window.sockets.at(-1).sent.filter(data => data === 'x' || data === 'y').length);
      await page.locator('#h5-attention-close').focus();
      await page.keyboard.type('xy');
      assert.equal(await page.evaluate(() => window.sockets.at(-1).sent.filter(data => data === 'x' || data === 'y').length), sentBefore, 'no keys reach the terminal from the panel');
      // A press on the translate field of the bottom row (outside, left of the panel) closes the panel and does not focus the field.
      const field = await page.locator('#h5-translate-input').boundingBox();
      assert.ok(field.x + 40 < 1440 - 8 - 480, 'the field starts left of the panel');
      await page.mouse.click(field.x + 40, field.y + field.height / 2);
      await panel.waitFor({ state: 'hidden' });
      await page.waitForTimeout(200);
      assert.notEqual(await focused(), 'h5-translate-input', 'the press only closed the panel: the field under it did not get the focus');
      assert.ok(calls.length >= 2);
      assert.equal(await resizes(), resizesBefore, 'no PTY resize in all of this');
      // Settings → T-Attention → Plugins on a computer: the same rows; the Refresh button is a compact icon button.
      await openPluginSettings(page, 'click');
      assert.deepEqual(await pluginsFit(page), []);
      assert.equal(await page.locator('#h5-plugins .h5-plugin').count(), 4);
      // On a computer the plugin's page is a dialog over the Settings page (not full screen), and the rows and Back work with the mouse.
      await page.locator('#h5-plugins .h5-plugin-notifier[data-name="telegram"]').click();
      await page.locator('.h5-plugin-page[data-name="telegram"] #h5-plugin-config-telegram-callSeconds').waitFor();
      const pageBox = await page.locator('.h5-plugin-page .h5-sheet-panel').boundingBox();
      assert.ok(pageBox.width <= 600 && pageBox.x > 72, `a dialog, not the whole window: ${JSON.stringify(pageBox)}`);
      assert.deepEqual(await pluginsFit(page), []);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pc-1440-attention-plugin-detail.png') });
      await page.locator('.h5-plugin-page-back').click();
      await page.locator('.h5-plugin-page').waitFor({ state: 'detached' });
      if (SHOTS) { await page.locator('#h5-plugins').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'pc-1440-attention-plugins.png') }); }
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ── Computer 1440x900, mouse: rows from a T-Agent session in the side panel ──
    {
      const { context, page, errors, calls } = await openPage(browser, { viewport: { width: 1440, height: 900 }, touch: false, items: SESSION_ITEMS(), activity: { 1: { t2: 'done' } } });
      const panel = page.locator('#h5-attention-sheet .h5-attention-panel');
      await page.locator('#h5-more').click();
      await page.locator('#h5-attention').click();
      await panel.waitFor({ state: 'visible' });
      await row(page, 1).locator('.h5-attention-session').waitFor();
      const shown = () => page.evaluate(() => [...document.querySelectorAll('#h5-attention-sheet .h5-attention-row[data-shown="true"]')].map(node => Number(node.dataset.id)));
      const opacity = id => row(page, id).locator('.h5-attention-details').evaluate(node => Number(getComputedStyle(node).opacity));
      // Terminal 1 is shown: the row of its task is marked (primary tint and a 3px indicator at the left), and its chip is stronger.
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="2"][data-shown="true"]'));
      assert.deepEqual(await shown(), [2]);
      const look = await row(page, 2).evaluate(node => ({ bg: getComputedStyle(node).backgroundColor, shadow: getComputedStyle(node).boxShadow }));
      assert.ok(look.bg !== 'rgba(0, 0, 0, 0)' && /inset/.test(look.shadow) && /3px 0px 0px/.test(look.shadow), `the selected look: ${JSON.stringify(look)}`);
      assert.equal(await row(page, 2).locator('.h5-attention-open').getAttribute('aria-current'), 'true');
      assert.equal(await page.locator('#h5-attention-hint').count(), 1, 'the side panel says how a session row works');
      // The Details button shows on hover and on keyboard focus; its place is kept, so nothing moves.
      await page.mouse.move(10, 890);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"] .h5-attention-details')).opacity) === 0);
      const titleBefore = await row(page, 1).locator('.h5-attention-title').boundingBox();
      await row(page, 1).locator('.h5-attention-title').hover();
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"] .h5-attention-details')).opacity) === 1);
      assert.deepEqual(await row(page, 1).locator('.h5-attention-title').boundingBox(), titleBefore, 'no layout shift');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'att-session-pc-hover.png') });
      await page.mouse.move(10, 890);
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"] .h5-attention-details')).opacity) === 0);
      await row(page, 1).locator('.h5-attention-details').focus();
      await page.waitForTimeout(200);
      assert.equal(await opacity(1), 1, 'shown while it has the keyboard focus');
      // Its own Tab stop after the row's buttons: Enter opens the details.
      await page.keyboard.press('Enter');
      const edit = page.locator('#h5-attention-edit .MuiDialog-paper');
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-edit-name').inputValue(), 'Allow Bash in the repo');
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#h5-session-name').textContent(), 'Terminal 1');
      // Enter on a focused session row opens the session; the panel stays open and the marked row follows.
      const before = calls.filter(call => call.method === 'PATCH').length;
      await row(page, 1).locator('.h5-attention-open').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('h5-session-name').textContent === 'Claude 1');
      assert.ok(await panel.isVisible(), 'the panel stays open beside the session');
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"][data-shown="true"]'));
      assert.deepEqual(await shown(), [1]);
      assert.equal(await page.locator('.MuiSnackbar-root .h5-notice-action').count(), 0, 'no notice on a computer');
      assert.equal(calls.filter(call => call.method === 'PATCH').length, before, 'no PATCH');
      // A click on the other session row opens Terminal 1 again; the mark moves back.
      await row(page, 2).locator('.h5-attention-title').click();
      await page.waitForFunction(() => document.getElementById('h5-session-name').textContent === 'Terminal 1');
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="2"][data-shown="true"]'));
      assert.deepEqual(await shown(), [2]);
      // The shown session changed elsewhere (the task list): the mark follows.
      // (With the keyboard: a press on the task list would only close the panel.)
      await page.locator('#h5-tasks .h5-terminal-row[data-session="t2"] .h5-terminal-main').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('h5-session-name').textContent === 'Claude 1');
      await page.waitForFunction(() => document.querySelector('#h5-attention-sheet .h5-attention-row[data-id="1"][data-shown="true"]'));
      assert.deepEqual(await shown(), [1]);
      // A row whose session is gone opens its details.
      await row(page, 9).locator('.h5-attention-open').click();
      await edit.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#h5-attention-jump').textContent(), 'Copy resume command');
      await page.keyboard.press('Escape');
      await edit.waitFor({ state: 'hidden' });
      await row(page, 1).locator('.h5-attention-title').hover();
      await page.waitForTimeout(200);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'att-session-pc-marked.png') });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('h5 attention browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
