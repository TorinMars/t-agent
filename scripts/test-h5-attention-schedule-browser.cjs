// T-Attention scheduled and recurring tasks on the page (scripts/h5-shell/Attention.jsx, attention-model.mjs, attention-schedule.mjs; "Scheduled and
// recurring tasks" in docs/design/page-attention.md), in real Chromium with the API of the contract mocked by Playwright routes, a fake EventSource per
// stream and a fixed clock (Friday 2026-11-20 10:00 local time; timers run normally):
// - the list: Scheduled (once, soonest first) and Recurring (repeat, soonest next first) after To do with their counts and no status pill, a due
//   recurring task in To do with the repeat icon, the row lines (rule, next, done, "sends a prompt to <session>" of the OWNER engine, "runs a script
//   in <task> · last: exit 0") and their icons, no drag in those sections;
// - "Send now" of a busy prompt task (409 SESSION_BUSY shows the server's message, then it is sent), "Open terminal" (the run's terminal) and "Run
//   again" of a failed script, all on the item's own engine;
// - the edit view: When (No date / Once / Repeats), Repeats weekly with the day chips, monthly, every N days, the ends, the "Next time" line from the
//   owner's preview (debounced: one request for a burst of changes), Then: Remind me / Send a prompt (the owner engine's sessions, read when shown) /
//   Run a script (the owner engine's tasks, a monospace script field, the time limit), the PATCH bodies, the form's own errors, 403 SCRIPT_NEEDS_PERSON
//   in the error line, No date clearing the schedule, an older engine (no `schedule` key) without When / Then;
// - phone 390 touch (44px targets, nothing wider than the screen), computer 1440 mouse (the same rows and fields), Chinese.
// H5_SHOT_DIR=<dir> saves screenshots (sched-*.png).
const { chromium } = require('playwright');
const { bnavTap } = require('./h5-bottom-nav-tap.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ORIGIN = 'http://h5.test';
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const SHOTS = process.env.H5_SHOT_DIR || '';
const NOW = new Date(2026, 10, 20, 10, 0); // Friday, local time of the browser
const AT = new Date(2026, 10, 19, 8, 0).toISOString();
const local = (month, day, hour, minute = 0) => new Date(2026, month - 1, day, hour, minute).toISOString();
const SHEET = '#h5-attention-sheet';

const NONE = { schedule: null, then_action: null, next_at: null, schedule_state: null, runs: 0, last_fired_at: null, last_done_at: null };
const node = (id, title, status, order, extra = {}) => ({
  id, title, status, parent_id: null, sort_order: order, custom_status: null, result: null, priority: 'none', source: 'user', updated_at: AT, created_at: AT, ...NONE, ...extra,
});
const repeat = (freq, time, extra = {}) => ({ kind: 'repeat', rule: { freq, time, ...extra }, tz: 'Asia/Taipei' });
const LOCAL_ITEMS = () => [
  node(1, 'Allow Bash', 'waiting_user', 90, { source: 'claude', attention_reason: 'Claude needs your permission' }),
  node(2, 'Weekly review', 'todo', 80, { schedule: repeat('weekly', '09:00', { days: [1] }), schedule_state: 'due', next_at: local(11, 23, 9), runs: 3 }),
  node(3, 'Release 2.0', 'todo', 70),
  node(4, 'Renew the TLS certificate', 'todo', 60, { schedule: { kind: 'once', at: '2026-12-01T10:00', tz: 'Asia/Taipei' }, schedule_state: 'waiting', next_at: local(12, 1, 10) }),
  node(5, 'Daily standup notes', 'todo', 50, { schedule: repeat('weekdays', '09:30'), schedule_state: 'waiting', next_at: local(11, 23, 9, 30), last_done_at: local(11, 20, 9, 41), runs: 9 }),
  node(6, 'Back up notes', 'todo', 40, { schedule: repeat('daily', '03:00'), schedule_state: 'waiting', next_at: local(11, 21, 3), last_exit: 0, then_action: { kind: 'script', task_id: '1', script: './scripts/backup.sh && git push', timeout_min: 30 } }),
  node(7, 'Nightly check', 'waiting_user', 30, { attention_reason: 'The session was busy at 02:00; the prompt was not sent', schedule: repeat('daily', '02:00'), schedule_state: 'due', next_at: local(11, 21, 2), then_action: { kind: 'prompt', task_id: '1', terminal_id: 't1', text: 'Run the checks' } }),
  node(8, 'Nightly backup', 'waiting_user', 20, {
    attention_reason: 'Script failed (exit 2) at 03:00', schedule: repeat('daily', '03:00'), schedule_state: 'due', next_at: local(11, 21, 3), last_exit: 2,
    then_action: { kind: 'script', task_id: '1', script: './backup.sh', timeout_min: 30 }, context: { tagent: { task_id: 1, terminal_id: 't9' } },
  }),
];
const REMOTE_ITEMS = () => [
  node(1, 'Nightly test run', 'todo', 10, { source: 'claude', schedule: repeat('daily', '02:00'), schedule_state: 'waiting', next_at: local(11, 21, 2), then_action: { kind: 'prompt', task_id: '1', terminal_id: 'r1', text: 'npm test' } }),
];

function makeWorld({ remotes = true, old = false } = {}) {
  const strip = items => (old ? items.map(({ schedule, then_action, next_at, schedule_state, runs, last_fired_at, last_done_at, last_exit, ...rest }) => rest) : items);
  return {
    remotes, calls: [], errors: [], busy: true, scriptRefused: false,
    dbs: { '/api/attention': { items: strip(LOCAL_ITEMS()), host: 'mac', instance: 'inst-local' }, '/api/remote-servers/7/attention': { items: strip(REMOTE_ITEMS()), host: 'k01', instance: 'inst-k01' } },
  };
}

// The engine's next times for a schedule (enough for the page: three times after "now", in the browser's local time) and its sentence.
function preview(schedule) {
  if (schedule.kind === 'once') { const [d, t] = schedule.at.split('T'); const [y, m, day] = d.split('-').map(Number); const [h, min] = t.split(':').map(Number); return { next: [new Date(y, m - 1, day, h, min).toISOString()], text: `Once on ${d} at ${t}` }; }
  const [h, min] = schedule.rule.time.split(':').map(Number);
  if (schedule.rule.freq === 'weekly') {
    const days = schedule.rule.days;
    const next = [];
    for (let add = 1; next.length < 3; add += 1) { const date = new Date(2026, 10, 20 + add, h, min); if (days.includes((date.getDay() + 6) % 7 + 1)) next.push(date.toISOString()); }
    const NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return { next, text: `Every ${days.map(day => NAMES[day - 1]).join(' and ')} at ${schedule.rule.time}` };
  }
  return { next: [1, 2, 3].map(add => new Date(2026, 10, 20 + add, h, min).toISOString()), text: `Every day at ${schedule.rule.time}` };
}

async function attention(world, base, rest, method, body, json) {
  const db = world.dbs[base];
  if (rest === '' && method === 'GET') return json({ items: db.items, host: db.host, instance_id: db.instance });
  if (rest === '/schedule/preview' && method === 'POST') return json(preview(body.schedule));
  const run = rest.match(/^\/(\d+)\/run-now$/);
  if (run && method === 'POST') {
    const item = db.items.find(entry => entry.id === Number(run[1]));
    if (world.busy && item.then_action && item.then_action.kind === 'prompt') return json({ error: 'SESSION_BUSY', message: 'The session is busy; the prompt was not sent' }, 409);
    // A script starts again in a new terminal and reports later (the item stays as it is until then); a prompt is sent at once.
    if (item.then_action.kind === 'prompt') Object.assign(item, { status: 'todo', schedule_state: 'waiting', attention_reason: null, updated_at: new Date(Date.now() + 1000).toISOString() });
    return json({ ok: true, item: { ...item } });
  }
  const one = rest.match(/^\/(\d+)$/);
  if (!one) return json({ error: 'not mocked' }, 404);
  const item = db.items.find(entry => entry.id === Number(one[1]));
  if (method === 'GET') return json({ item, events: [] });
  if (method === 'PATCH') {
    if (world.scriptRefused && body.then_action && body.then_action.kind === 'script') return json({ error: 'SCRIPT_NEEDS_PERSON', message: 'Only the person can set a script; an agent token cannot' }, 403);
    Object.assign(item, body, { updated_at: new Date(Date.now() + 1000).toISOString() });
    if ('schedule' in body) Object.assign(item, body.schedule ? { schedule_state: 'waiting', next_at: preview(body.schedule).next[0] } : { schedule_state: null, next_at: null });
    return json({ ...item });
  }
  return json({ error: 'not mocked' }, 404);
}

async function serve(world, route) {
  const request = route.request();
  const url = new URL(request.url());
  const p = url.pathname;
  const method = request.method();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (p === '/h5') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'public/h5.html'), 'utf8') });
  if (/^\/(js|css|vendor)\//.test(p)) return route.fulfill({ contentType: TYPES[path.extname(p)] || 'text/plain', body: fs.readFileSync(path.join(root, 'public', p)) });
  if (p === '/api/system/version') return json({ engine_name: 'Air', instance_id: 'inst-local' });
  if (p === '/api/remote-servers') return json(world.remotes ? [{ id: 7, name: 'K01', status: 'online', enabled: true, instance_id: 'inst-k01' }] : []);
  if (p === '/api/task-list/hidden-devices') return json({ hidden: [] });
  if (p === '/api/tasks' && method === 'GET') return json([{ id: 1, title: 'Fix login', status: 'doing', work_dir: '/work/fix-login', archived_at: null }, { id: 2, title: 'Notes', status: 'doing', work_dir: '/work/notes', archived_at: null }]);
  if (p === '/api/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
  if (p === '/api/tasks/1/terminals') { world.calls.push({ method, path: p }); return json([{ terminal_id: 't1', title: 'Claude 1' }, { terminal_id: 't9', title: 'Back up notes · 03:00' }]); }
  if (p === '/api/tasks/2/terminals') { world.calls.push({ method, path: p }); return json([{ terminal_id: 'n1', title: 'Notes shell' }]); }
  if (/\/agent\/conversations$/.test(p)) return json([]);
  const body = request.postData() ? JSON.parse(request.postData()) : undefined;
  if (p.startsWith('/api/attention')) {
    world.calls.push({ method, path: p + url.search, body });
    return attention(world, '/api/attention', p.slice('/api/attention'.length), method, body, json);
  }
  const remote = p.match(/^\/api\/remote-servers\/7(\/.*)$/);
  if (remote) {
    const rest = remote[1];
    if (rest.startsWith('/attention')) {
      world.calls.push({ method, path: p + url.search, body, remote: 7 });
      return attention(world, '/api/remote-servers/7/attention', rest.slice('/attention'.length), method, body, json);
    }
    if (rest === '/info') return json({ capabilities: ['attention:remote', 'terminal:control'] });
    if (rest === '/tasks' && method === 'GET') return json([{ id: 1, title: 'Deploy site', status: 'doing', work_dir: '/srv/site', archived_at: null }]);
    if (rest === '/task-groups') return json([{ key: 'doing', name: 'In progress', sort_order: 1 }]);
    if (rest === '/tasks/1/terminals') { world.calls.push({ method, path: p, remote: 7 }); return json([{ terminal_id: 'r1', title: 'ONCALL-CC' }]); }
    if (/terminal-activity$|terminal-subagents$/.test(rest)) return json({});
    return json({ error: 'not mocked' }, 404);
  }
  if (/terminal-activity$|terminal-subagents$/.test(p)) return json({});
  return json({ error: 'not mocked' }, 404);
}

async function openPage(browser, world, { viewport, touch = true, zh = false }) {
  const scale = SHOTS ? { deviceScaleFactor: touch ? 3 : 1 } : {};
  const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}), ...scale });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  page.on('pageerror', error => world.errors.push(error.message));
  await page.addInitScript(({ zh: chinese }) => {
    window.socketUrls = [];
    window.WebSocket = class {
      constructor(url) { window.socketUrls.push(url); this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = 3; }
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.streams = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.readyState = 0; window.streams.push(this); setTimeout(() => { if (this.readyState !== 2) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }, 0); }
      close() { this.readyState = 2; }
    };
    window.openStreams = pathname => window.streams.filter(s => s.readyState === 1 && new URL(s.url, location.href).pathname === pathname);
    window.emitOn = (pathname, change) => window.openStreams(pathname).at(-1).dispatchEvent(new MessageEvent('change', { data: JSON.stringify(change) }));
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() { return { type: '', frequency: {}, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
    try { if (chinese) localStorage.setItem('ta-lang', 'zh'); } catch { /* none */ }
  }, { zh });
  await page.route(`${ORIGIN}/**`, route => serve(world, route));
  await page.goto(`${ORIGIN}/h5`);
  const how = touch ? 'tap' : 'click';
  const terminal = page.locator('#h5-tasks .h5-terminal-list[aria-label="Fix login"] .h5-terminal-main').first();
  if (!(await terminal.isVisible())) await page.locator('.h5-task-item', { hasText: 'Fix login' })[how]();
  await terminal[how]();
  await page.waitForFunction(() => innerWidth >= 900 || !document.body.classList.contains('h5-tasks-open') && Math.abs(document.getElementById('h5-app').getBoundingClientRect().left) < 0.5);
  await page.waitForFunction(() => document.getElementById('h5-attention') && window.openStreams('/api/attention/stream').length === 1);
  if (world.remotes) await page.waitForFunction(() => window.openStreams('/api/remote-servers/7/attention/stream').length === 1);
  return { context, page };
}

async function openSheet(page, how) {
  if (how === 'click' && await page.locator('#h5-more').isVisible()) await page.locator('#h5-more').click();
  await bnavTap(page, '#h5-attention', how);
  await page.locator('#h5-more-menu .MuiBackdrop-root').waitFor({ state: 'hidden' });
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'visible' });
  await page.waitForFunction(sheet => { const el = document.querySelector(`${sheet} .h5-attention-panel`); return el && ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(el).transform); }, SHEET);
  await page.locator(`${SHEET} .h5-attention-row`).first().waitFor();
}
const groupOrder = page => page.evaluate(sheet => [...document.querySelectorAll(`${sheet} #h5-attention-body > .h5-attention-group, ${sheet} #h5-attention-body .h5-attention-group`)].map(el => el.dataset.group), SHEET);
const keysIn = (page, group) => page.evaluate(([sheet, key]) => [...document.querySelectorAll(`${sheet} .h5-attention-group[data-group="${key}"] .h5-attention-row`)].map(el => el.dataset.key), [SHEET, group]);
const row = (page, key) => page.locator(`#h5-attention-body .h5-attention-row[data-key="${key}"]`);
const lineOf = async (page, key) => (await row(page, key).locator('.h5-attention-schedule-text').textContent()).replace(/\s+/g, ' ');
const notice = page => page.locator('.MuiSnackbar-root .MuiAlert-message');
const last = (world, method, test = () => true) => world.calls.filter(call => call.method === method && test(call)).at(-1);
const noOverflow = (page, scope) => page.evaluate(sel => { const panel = document.querySelector(sel); return [...panel.querySelectorAll('*')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 0.5; }).map(el => el.className.toString().split(' ')[0] || el.tagName); }, scope);
const small = (page, scope) => page.evaluate(sel => [...document.querySelectorAll(`${sel} button, ${sel} input, ${sel} select, ${sel} textarea`)]
  .filter(el => el.offsetParent !== null && el.type !== 'radio')
  .map(el => { const r = (el.closest('.MuiInputBase-root') || el).getBoundingClientRect(); return { id: el.id || el.className.split(' ')[0], w: r.width, h: r.height }; })
  .filter(r => r.w && (r.w < 44 || r.h < 44)), scope);

async function checkList(page, world, how) {
  // Sections: the status sections, then Scheduled and Recurring (with their counts), then Done.
  const order = await groupOrder(page);
  assert.deepEqual(order, ['needs_you', 'working', 'todo', 'scheduled', 'recurring', 'closed']);
  assert.deepEqual(await page.locator(`${SHEET} .h5-attention-group[data-group="scheduled"] .h5-attention-group-label`).textContent(), 'Scheduled');
  assert.deepEqual(await page.locator(`${SHEET} .h5-attention-group[data-group="scheduled"] .h5-attention-group-count`).textContent(), '1');
  assert.deepEqual(await page.locator(`${SHEET} .h5-attention-group[data-group="recurring"] .h5-attention-group-count`).textContent(), '3');
  assert.deepEqual(await keysIn(page, 'scheduled'), ['local:4']);
  assert.deepEqual(await keysIn(page, 'recurring'), ['remote:7:1', 'local:6', 'local:5'], 'the soonest next first (02:00, 03:00 tomorrow, Monday 09:30)');
  assert.deepEqual(await keysIn(page, 'todo'), ['local:2', 'local:3'], 'a due recurring task is in To do');
  assert.deepEqual(await keysIn(page, 'needs_you'), ['local:1', 'local:7', 'local:8']);
  // No status pill in the timed sections; their rows are not dragged.
  assert.equal(await page.locator(`${SHEET} .h5-attention-group[data-group="recurring"] .h5-attention-status`).count(), 0);
  assert.equal(await page.locator(`${SHEET} .h5-attention-group[data-group="recurring"] .h5-attention-node[data-movable="true"]`).count(), 0);
  assert.ok(await page.locator(`${SHEET} .h5-attention-group[data-group="todo"] .h5-attention-node[data-movable="true"]`).count() > 0, 'the other rows are');
  // Row lines and icons.
  assert.equal(await lineOf(page, 'local:4'), 'Once · Tue 12-01 10:00');
  assert.equal(await row(page, 'local:4').locator('.h5-attention-schedule').getAttribute('data-icon'), 'clockCircle');
  assert.equal(await lineOf(page, 'local:5'), 'Weekdays 09:30 · next Mon 11-23 09:30 · done today 09:41');
  assert.equal(await row(page, 'local:5').locator('.h5-attention-schedule').getAttribute('data-icon'), 'sync');
  assert.equal(await lineOf(page, 'local:2'), 'Every Monday 09:00 · due now');
  assert.equal(await row(page, 'local:2').locator('.h5-attention-schedule').getAttribute('data-icon'), 'sync', 'the repeat icon in To do');
  assert.equal(await lineOf(page, 'local:6'), 'Every day 03:00 · next tomorrow 03:00 · runs a script in Fix login · last: exit 0');
  assert.equal(await row(page, 'local:6').locator('.h5-attention-schedule').getAttribute('data-icon'), 'terminalKeyboard');
  assert.equal(await lineOf(page, 'remote:7:1'), 'Every day 02:00 · next tomorrow 02:00 · sends a prompt to Deploy site', 'the session of K01, named by its task while its sessions are not read');
  assert.equal(await row(page, 'remote:7:1').locator('.h5-attention-schedule').getAttribute('data-icon'), 'send');
  assert.equal(await row(page, 'remote:7:1').locator('.h5-attention-schedule-session').getAttribute('translate'), 'no');
  // Row buttons of the tasks whose time came.
  assert.deepEqual(await row(page, 'local:7').locator('.h5-attention-action').allTextContents(), ['Send now', 'Handled']);
  assert.deepEqual(await row(page, 'local:8').locator('.h5-attention-action').allTextContents(), ['Open terminal', 'Run again', 'Handled']);
  assert.equal(await row(page, 'local:8').locator('.h5-attention-reason').textContent(), 'Script failed (exit 2) at 03:00');
  void how;
}

async function editView(page, key, how) {
  await row(page, key).locator('.h5-attention-open')[how]();
  await page.locator('#h5-attention-edit').waitFor();
  await page.locator('#h5-attention-schedule').waitFor();
}
// The notices of earlier steps are closed before a screenshot, so they do not cover the view.
const quiet = async page => { for (const button of await page.locator('.MuiSnackbar-root button[aria-label="Close"], .MuiSnackbar-root .MuiAlert-action button').all()) await button.click({ force: true }).catch(() => {}); await page.locator('.MuiSnackbar-root').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {}); };
const previews = world => world.calls.filter(call => call.path.endsWith('/schedule/preview'));

async function testPhone(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  await checkList(page, world, 'tap');
  assert.deepEqual(await noOverflow(page, `${SHEET} .h5-attention-panel`), []);
  if (SHOTS) {
    await page.locator(`${SHEET} .h5-attention-group[data-group="scheduled"]`).scrollIntoViewIfNeeded();
    await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-list-390.png') });
  }

  // Send now: busy (the server's message), then sent; on this machine's run-now.
  await row(page, 'local:7').locator('.h5-attention-action[data-action="send-now"]').tap();
  await notice(page).filter({ hasText: 'Could not send the prompt: The session is busy; the prompt was not sent' }).waitFor();
  assert.equal(last(world, 'POST', call => call.path.includes('run-now')).path, '/api/attention/7/run-now');
  world.busy = false;
  await row(page, 'local:7').locator('.h5-attention-action[data-action="send-now"]').tap();
  await notice(page).filter({ hasText: 'Prompt sent' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.h5-attention-group[data-group="recurring"] .h5-attention-row[data-key="local:7"]'));
  // Run again of a failed script.
  await row(page, 'local:8').locator('.h5-attention-action[data-action="run-again"]').tap();
  await notice(page).filter({ hasText: 'The script runs again' }).waitFor();
  assert.equal(last(world, 'POST', call => call.path.includes('run-now')).path, '/api/attention/8/run-now');

  // The edit view of a task without a schedule: When is "No date", no Then.
  await editView(page, 'local:3', 'tap');
  assert.equal(await page.locator('#h5-attention-when [aria-pressed="true"]').getAttribute('data-value'), 'none');
  assert.equal(await page.locator('#h5-attention-then').count(), 0);
  // Repeats: every week on the day of today (Friday) at 09:00, from today; the day chips; the preview after the burst of changes.
  await page.locator('#h5-attention-when [data-value="repeat"]').tap();
  assert.equal(await page.locator('#h5-attention-repeat-freq').inputValue(), 'weekly');
  assert.deepEqual(await page.locator('#h5-attention-repeat-days [aria-pressed="true"]').evaluateAll(els => els.map(el => el.dataset.day)), ['5']);
  assert.deepEqual(await page.locator('#h5-attention-repeat-days button').evaluateAll(els => els.map(el => el.getAttribute('aria-label'))), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  const before = previews(world).length;
  await page.locator('#h5-attention-repeat-days [data-day="1"]').tap();
  await page.locator('#h5-attention-repeat-days [data-day="5"]').tap();
  await page.locator('#h5-attention-schedule-next', { hasText: 'Every Monday at 09:00' }).waitFor();
  assert.equal(await page.locator('#h5-attention-schedule-next').textContent(), 'Next time: Mon 11-23 09:00 · Every Monday at 09:00');
  assert.ok(previews(world).length - before <= 2, 'debounced: the burst of changes asks once (or twice at most), not per change');
  assert.deepEqual(last(world, 'POST', call => call.path.endsWith('/schedule/preview')).body, { schedule: { kind: 'repeat', rule: { freq: 'weekly', time: '09:00', days: [1] }, starts: '2026-11-20' } });
  // No day: the form says so at once and Save refuses.
  await page.locator('#h5-attention-repeat-days [data-day="1"]').tap();
  await page.locator('#h5-attention-schedule-next[data-error="true"]', { hasText: 'Choose at least one day' }).waitFor();
  await page.locator('#h5-attention-edit-save').tap();
  assert.equal(await page.locator('#h5-attention-edit-error').textContent(), 'Choose at least one day');
  await page.locator('#h5-attention-repeat-days [data-day="1"]').tap();
  await page.locator('#h5-attention-schedule-next:not([data-error])', { hasText: 'Every Monday at 09:00' }).waitFor();
  const chips = await page.locator('#h5-attention-repeat-days button').evaluateAll(els => [...new Set(els.map(el => Math.round(el.getBoundingClientRect().top)))]);
  assert.equal(chips.length, 1, 'the seven day chips fit on one line at 390px');
  // Then: a prompt to a session of this machine (the sessions are read when the choice is shown).
  assert.equal(await page.locator('#h5-attention-then input[value="remind"]').isChecked(), true);
  await page.locator('#h5-attention-then input[value="prompt"]').tap();
  await page.locator('#h5-attention-then-session option[value="2|n1"]').waitFor({ state: 'attached' });
  assert.deepEqual(await page.locator('#h5-attention-then-session optgroup').evaluateAll(els => els.map(el => el.label)), ['Fix login', 'Notes'], 'this machine\'s tasks only');
  await page.locator('#h5-attention-then-session').selectOption('2|n1');
  await page.locator('#h5-attention-then-prompt').fill('Write the weekly notes');
  assert.deepEqual(await small(page, '#h5-attention-edit'), [], 'every control of the edit view is 44px on touch');
  assert.deepEqual(await noOverflow(page, '#h5-attention-edit .MuiDialog-paper'), []);
  if (SHOTS) {
    await page.locator('#h5-attention-schedule').scrollIntoViewIfNeeded();
    await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-edit-weekly-390.png') });
    await page.locator('#h5-attention-then-prompt').scrollIntoViewIfNeeded();
    await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-edit-prompt-390.png') });
  }
  await page.locator('#h5-attention-edit-save').tap();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'PATCH').body, {
    schedule: { kind: 'repeat', rule: { freq: 'weekly', time: '09:00', days: [1] }, starts: '2026-11-20' },
    then_action: { kind: 'prompt', task_id: 2, terminal_id: 'n1', text: 'Write the weekly notes' },
  });
  await page.waitForFunction(() => document.querySelector('.h5-attention-group[data-group="recurring"] .h5-attention-row[data-key="local:3"]'));
  assert.equal(await lineOf(page, 'local:3'), 'Every Monday 09:00 · next Mon 11-23 09:00 · sends a prompt to Notes shell', 'the session name as read for the edit view');

  // A saved script task: the form echoes it; the agent's token rule (403 SCRIPT_NEEDS_PERSON) shows the server's message.
  await editView(page, 'local:6', 'tap');
  assert.equal(await page.locator('#h5-attention-when [aria-pressed="true"]').getAttribute('data-value'), 'repeat');
  assert.equal(await page.locator('#h5-attention-repeat-freq').inputValue(), 'daily');
  assert.equal(await page.locator('#h5-attention-repeat-time').inputValue(), '03:00');
  assert.equal(await page.locator('#h5-attention-then input[value="script"]').isChecked(), true);
  assert.equal(await page.locator('#h5-attention-then-task').inputValue(), '1');
  assert.equal(await page.locator('#h5-attention-then-script').inputValue(), './scripts/backup.sh && git push');
  assert.equal(await page.locator('#h5-attention-then-timeout').inputValue(), '30');
  assert.match(await page.locator('#h5-attention-then-script').evaluate(el => getComputedStyle(el).fontFamily), /monospace|Menlo/);
  if (SHOTS) { await page.locator('#h5-attention-then-script').scrollIntoViewIfNeeded(); await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-edit-script-390.png') }); }
  const patches = world.calls.filter(call => call.method === 'PATCH').length;
  await page.locator('#h5-attention-edit-save').tap();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  assert.equal(world.calls.filter(call => call.method === 'PATCH').length, patches, 'an untouched form sends nothing');
  world.scriptRefused = true;
  await editView(page, 'local:6', 'tap');
  await page.locator('#h5-attention-then-task').selectOption('2');
  await page.locator('#h5-attention-edit-save').tap();
  await page.locator('#h5-attention-edit-error', { hasText: 'Only the person can set a script' }).waitFor();
  assert.deepEqual(last(world, 'PATCH').body, { then_action: { kind: 'script', task_id: 2, script: './scripts/backup.sh && git push', timeout_min: 30 } });
  await page.locator('#h5-attention-edit-cancel').tap();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });

  // Open terminal of a failed script: the terminal of that run; the T-Attention page closes.
  await row(page, 'local:8').locator('.h5-attention-action[data-action="open-terminal"]').tap();
  await page.locator(`${SHEET} .h5-attention-panel`).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.socketUrls.some(url => url.includes('t9')));
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testComputer(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 1440, height: 900 }, touch: false });
  await openSheet(page, 'click');
  await checkList(page, world, 'click');
  if (SHOTS) { await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-list-1440.png') }); }

  // K01's prompt task: its sessions are K01's (read through the proxy), and the save goes to K01.
  await editView(page, 'remote:7:1', 'click');
  assert.equal(await page.locator('#h5-attention-then input[value="prompt"]').isChecked(), true);
  await page.locator('#h5-attention-then-session option[value="1|r1"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#h5-attention-then-session').inputValue(), '1|r1', 'the saved session is chosen');
  assert.deepEqual(await page.locator('#h5-attention-then-session optgroup').evaluateAll(els => els.map(el => el.label)), ['Deploy site'], 'K01\'s tasks, not this machine\'s');
  assert.ok(world.calls.some(call => call.remote === 7 && call.path === '/api/remote-servers/7/tasks/1/terminals'));
  await page.locator('#h5-attention-schedule-next', { hasText: 'Every day at 02:00' }).waitFor();
  assert.equal(last(world, 'POST', call => call.path.endsWith('/schedule/preview')).path, '/api/remote-servers/7/attention/schedule/preview', 'the owner previews');
  await page.locator('#h5-attention-repeat-freq').selectOption('weekly');
  await page.locator('#h5-attention-repeat-days [data-day="1"]').click();
  await page.locator('#h5-attention-repeat-days [data-day="4"]').click();
  await page.locator('#h5-attention-repeat-days [data-day="5"]').click(); // today's default off again
  await page.locator('#h5-attention-schedule-next', { hasText: 'Monday and Thursday' }).waitFor();
  if (SHOTS) { await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-edit-weekly-1440.png') }); }
  await page.locator('#h5-attention-then-prompt').fill('npm test -- --runInBand');
  if (SHOTS) { await page.locator('#h5-attention-then-prompt').scrollIntoViewIfNeeded(); await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-edit-prompt-1440.png') }); }
  await page.locator('#h5-attention-edit-save').click();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  const patch = last(world, 'PATCH');
  assert.equal(patch.path, '/api/remote-servers/7/attention/1');
  assert.deepEqual(patch.body, {
    schedule: { kind: 'repeat', rule: { freq: 'weekly', time: '02:00', days: [1, 4] } },
    then_action: { kind: 'prompt', task_id: 1, terminal_id: 'r1', text: 'npm test -- --runInBand' },
  });
  await page.waitForFunction(() => /Every Mon, Thu 02:00/.test(document.querySelector('.h5-attention-row[data-key="remote:7:1"] .h5-attention-schedule-text').textContent));

  // Once, monthly, every N days, ends; then the script choice; then No date clears it.
  await editView(page, 'local:4', 'click');
  assert.equal(await page.locator('#h5-attention-once-date').inputValue(), '2026-12-01');
  assert.equal(await page.locator('#h5-attention-once-time').inputValue(), '10:00');
  await page.locator('#h5-attention-schedule-next', { hasText: 'Next time: Tue 12-01 10:00' }).waitFor();
  assert.equal(await page.locator('#h5-attention-schedule-next').textContent(), 'Next time: Tue 12-01 10:00', 'once: the time alone');
  await page.locator('#h5-attention-when [data-value="repeat"]').click();
  await page.locator('#h5-attention-repeat-freq').selectOption('monthly');
  await page.locator('#h5-attention-repeat-day').fill('31');
  assert.equal(await page.locator('#h5-attention-repeat-day-helper-text').textContent(), 'A month without that day uses its last day');
  await page.locator('#h5-attention-repeat-freq').selectOption('every');
  await page.locator('#h5-attention-repeat-interval').fill('3');
  await page.locator('#h5-attention-repeat-ends').selectOption('after');
  await page.locator('#h5-attention-repeat-ends-count').fill('4');
  await page.locator('#h5-attention-then input[value="script"]').click();
  await page.locator('#h5-attention-then-task').selectOption('2');
  await page.locator('#h5-attention-then-script').fill('./scripts/renew.sh');
  await page.locator('#h5-attention-then-timeout').fill('15');
  if (SHOTS) { await page.locator('#h5-attention-then-script').scrollIntoViewIfNeeded(); await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-edit-script-1440.png') }); }
  await page.locator('#h5-attention-edit-save').click();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'PATCH').body, {
    schedule: { kind: 'repeat', rule: { freq: 'every', time: '09:00', interval: 3 }, starts: '2026-11-20', ends: { kind: 'after', count: 4 } },
    then_action: { kind: 'script', task_id: 2, script: './scripts/renew.sh', timeout_min: 15 },
  });
  await editView(page, 'local:4', 'click');
  await page.locator('#h5-attention-when [data-value="none"]').click();
  assert.equal(await page.locator('#h5-attention-then').count(), 0);
  await page.locator('#h5-attention-edit-save').click();
  await page.locator('#h5-attention-edit').waitFor({ state: 'hidden' });
  assert.deepEqual(last(world, 'PATCH').body, { schedule: null, then_action: null });
  await page.waitForFunction(() => document.querySelector('.h5-attention-group[data-group="todo"] .h5-attention-row[data-key="local:4"]'));
  assert.equal(await row(page, 'local:4').locator('.h5-attention-schedule').count(), 0);
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testChinese(browser) {
  const world = makeWorld();
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 }, zh: true });
  await openSheet(page, 'tap');
  assert.equal(await page.locator(`${SHEET} .h5-attention-group[data-group="scheduled"] .h5-attention-group-label`).textContent(), '\u5df2\u6392\u671f');
  assert.equal(await lineOf(page, 'local:5'), '\u5de5\u4f5c\u65e5 09:30 · \u4e0b\u6b21 \u5468\u4e00 11-23 09:30 · \u5b8c\u6210\u4e8e \u4eca\u5929 09:41');
  assert.equal(await lineOf(page, 'local:2'), '\u6bcf\u5468\u4e00 09:00 · \u5df2\u5230\u65f6\u95f4');
  assert.equal(await lineOf(page, 'remote:7:1'), '\u6bcf\u5929 02:00 · \u4e0b\u6b21 \u660e\u5929 02:00 · \u53d1\u9001\u63d0\u793a\u5230 Deploy site', 'the task name stays as it is');
  await editView(page, 'local:3', 'tap');
  await page.locator('#h5-attention-when [data-value="repeat"]').tap();
  assert.deepEqual(await page.locator('#h5-attention-repeat-days button').allTextContents(), ['\u4e00', '\u4e8c', '\u4e09', '\u56db', '\u4e94', '\u516d', '\u65e5']);
  if (SHOTS) { await page.locator('#h5-attention-schedule').scrollIntoViewIfNeeded(); await quiet(page); await page.screenshot({ path: path.join(SHOTS, 'sched-edit-zh-390.png') }); }
  assert.deepEqual(world.errors, []);
  await context.close();
}

async function testOlder(browser) {
  const world = makeWorld({ remotes: false, old: true });
  const { context, page } = await openPage(browser, world, { viewport: { width: 390, height: 844 } });
  await openSheet(page, 'tap');
  assert.equal(await page.locator(`${SHEET} .h5-attention-group[data-group="scheduled"]`).count(), 0);
  assert.equal(await page.locator(`${SHEET} .h5-attention-schedule`).count(), 0);
  await row(page, 'local:3').locator('.h5-attention-open').tap();
  await page.locator('#h5-attention-edit').waitFor();
  assert.equal(await page.locator('#h5-attention-schedule').count(), 0, 'an engine without schedules has no When / Then');
  assert.equal(previews(world).length, 0);
  assert.deepEqual(world.errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const [name, run] of [['phone 390 touch', testPhone], ['computer 1440 mouse', testComputer], ['Chinese', testChinese], ['an older engine', testOlder]]) {
      await run(browser);
      console.log(`  ${name}: ok`);
    }
    console.log('h5 attention schedule browser test passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
