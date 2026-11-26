// T-Attention schedules in the service (services/attention.js), the timer (services/attention-scheduler.js), the notifiers' reminder path and the copy
// rules: a real schema on a temporary database, a clock the test moves, fixed zones and fake sessions (no PTY: see attention-script-run.test.js).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-attention-schedule-service-'));
process.env.T_AGENT_DATA_DIR = dataDir;

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createAttentionService, AttentionError, rowToItem } = require('../services/attention');
const { createAttentionScheduler } = require('../services/attention-scheduler');
const notify = require('../services/attention-notify');
const merge = require('../services/attention-copy-merge');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const T0 = Date.parse('2026-11-20T00:30:00.000Z'); // Friday 08:30 in Taipei
function fakeSessions() {
  const state = { sessions: new Map(), sent: [], scripts: [], removed: [], tasks: new Map([[1, 'ok'], [2, 'archived']]) };
  return {
    state,
    check: (taskId, terminalId) => state.sessions.get(`${taskId}:${terminalId}`) || 'gone',
    send: (taskId, terminalId, text) => { state.sent.push({ taskId, terminalId, text }); return state.sessions.get(`${taskId}:${terminalId}`) === 'idle'; },
    scriptTask: taskId => state.tasks.get(taskId) || 'gone',
    runScript: (taskId, options) => { const run = { taskId, ...options, terminal_id: `run-${state.scripts.length + 1}` }; state.scripts.push(run); return { terminal_id: run.terminal_id }; },
    removeTerminal: (taskId, terminalId) => { state.removed.push(`${taskId}:${terminalId}`); return true; },
  };
}
function setup({ file = null, tz = 'Asia/Taipei', clock = { now: T0 } } = {}) {
  const db = new Database(file || ':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const sessions = fakeSessions();
  const service = createAttentionService({ db, now: () => new Date(clock.now), timeZone: () => tz, sessions });
  const seen = [];
  service.onChange(change => seen.push(change));
  return { db, service, sessions, seen, clock, at: text => { clock.now = Date.parse(text); } };
}
const daily = (time = '09:00', extra = {}) => ({ kind: 'repeat', rule: { freq: 'daily', time }, ...extra });
const fails = (fn, code, status) => assert.throws(fn, error => error instanceof AttentionError && error.code === code && (status === undefined || error.statusCode === status));

test('saving a schedule computes next_at in the zone, sets waiting and opens a closed item; the same schedule again changes nothing; clearing it ends it', () => {
  const { service, seen } = setup();
  const item = service.create({ title: 'Standup', status: 'done', schedule: daily() });
  assert.deepEqual([item.next_at, item.schedule_state, item.status, item.runs, item.completed_at], ['2026-11-20T01:00:00.000Z', 'waiting', 'todo', 0, null]);
  assert.deepEqual(item.schedule, { kind: 'repeat', rule: { freq: 'daily', time: '09:00' }, tz: 'Asia/Taipei' });
  assert.equal(item.schedule_text, 'Every day at 09:00');
  assert.equal(item.then_action, null);
  for (const key of ['schedule', 'then_action', 'next_at', 'schedule_state', 'runs', 'last_fired_at', 'last_done_at', 'schedule_text', 'script_runs', 'last_exit']) assert.ok(key in item, key);
  const count = seen.length;
  service.update(item.id, { schedule: daily(), title: 'Standup' });
  service.update(item.id, { schedule: { ...daily(), tz: 'Asia/Taipei', ends: { kind: 'never' } } });
  assert.equal(seen.length, count, 'the same schedule sent back is no change');
  const cleared = service.update(item.id, { schedule: null });
  assert.deepEqual([cleared.schedule, cleared.next_at, cleared.schedule_state, cleared.schedule_text], [null, null, null, null]);
  assert.deepEqual(service.events(item.id)[0].data, { schedule: null, next_at: null, schedule_state: null });
  fails(() => service.create({ title: 'x', schedule: { kind: 'repeat', rule: { freq: 'weekly', days: [], time: '09:00' } } }), 'VALIDATION_FAILED', 400);
  fails(() => service.create({ title: 'x', schedule: daily('09:00', { ends: { kind: 'on', date: '2026-01-01' } }) }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 'x', schedule: daily(), bogus: 1, then_action: { kind: 'prompt', text: 'hi' } }), 'VALIDATION_FAILED');
});

test('a duration or all day is saved and read back; a change of only the length keeps the time, the runs and the state; a new time starts again', () => {
  const { service, seen, at } = setup();
  const item = service.create({ title: 'Review', schedule: daily('09:00', { duration: 90 }) });
  assert.deepEqual(item.schedule, { kind: 'repeat', rule: { freq: 'daily', time: '09:00' }, tz: 'Asia/Taipei', duration: 90 });
  assert.deepEqual([item.schedule_text, item.next_at], ['Every day at 09:00 \u00b7 for 1 hour 30 minutes', '2026-11-20T01:00:00.000Z']);
  assert.deepEqual(service.get(item.id).schedule, item.schedule, 'read back');
  const count = seen.length;
  service.update(item.id, { schedule: daily('09:00', { duration: 90, all_day: false }) });
  assert.equal(seen.length, count, 'the same length sent back is no change');
  at('2026-11-20T01:00:00.000Z');
  service.fireDue();
  const fired = service.get(item.id);
  assert.deepEqual([fired.schedule_state, fired.runs, fired.next_at], ['due', 1, '2026-11-21T01:00:00.000Z']);
  // The engine's zone changed meanwhile: a length-only change keeps the stored zone too.
  const allDay = service.update(item.id, { schedule: daily('09:00', { all_day: true }) });
  assert.deepEqual(allDay.schedule, { kind: 'repeat', rule: { freq: 'daily', time: '09:00' }, tz: 'Asia/Taipei', all_day: true });
  assert.deepEqual([allDay.schedule_state, allDay.runs, allDay.next_at, allDay.schedule_text], ['due', 1, '2026-11-21T01:00:00.000Z', 'Every day at 09:00 \u00b7 all day']);
  const moved = service.update(item.id, { schedule: daily('10:00', { all_day: true }) });
  assert.deepEqual([moved.schedule_state, moved.runs, moved.next_at], ['waiting', 0, '2026-11-20T02:00:00.000Z'], 'a new time is a new schedule');
  // A once item that already fired and is done: a new length does not open it or fire it again.
  const call = service.create({ title: 'Call', schedule: { kind: 'once', at: '2026-11-20T08:00', duration: 30 } });
  service.fireDue();
  service.update(call.id, { status: 'done' });
  const longer = service.update(call.id, { schedule: { kind: 'once', at: '2026-11-20T08:00', duration: 60 } });
  assert.deepEqual([longer.status, longer.next_at, longer.schedule_state, longer.runs, longer.schedule.duration], ['done', null, null, 1, 60]);
  fails(() => service.create({ title: 'x', schedule: { kind: 'once', at: '2026-11-20T23:30', duration: 45 } }), 'VALIDATION_FAILED', 400);
  fails(() => service.update(item.id, { schedule: daily('09:00', { duration: 30, all_day: true }) }), 'VALIDATION_FAILED', 400);
});

test('a once item in the past is due at once; the firing is stored before it is published, fires once and is never fired again by another service on the same database', () => {
  const file = path.join(dataDir, 'restart.sqlite');
  const first = setup({ file });
  const item = first.service.create({ title: 'Call the bank', schedule: { kind: 'once', at: '2026-11-19T10:00' } });
  assert.equal(item.next_at, '2026-11-19T02:00:00.000Z');
  let storedWhenPublished = null;
  first.service.onChange(change => { if (change.scheduled_due) storedWhenPublished = first.db.prepare('SELECT schedule_state, runs FROM attention_items WHERE id = ?').get(item.id); });
  const fired = first.service.fireDue();
  assert.equal(fired.length, 1);
  assert.deepEqual(storedWhenPublished, { schedule_state: 'due', runs: 1 });
  const due = first.service.get(item.id);
  assert.deepEqual([due.status, due.schedule_state, due.runs, due.next_at, due.last_fired_at], ['todo', 'due', 1, null, new Date(T0).toISOString()]);
  const change = first.seen.at(-1);
  assert.equal(change.scheduled_due, true);
  assert.equal(change.event.type, 'scheduled');
  assert.equal(first.service.fireDue().length, 0, 'not twice');
  first.db.close();
  // A restart: a new service on the same file finds nothing due.
  const second = setup({ file });
  assert.equal(second.service.fireDue().length, 0);
  assert.equal(second.service.events(item.id).filter(event => event.type === 'scheduled').length, 1);
  // Done of a once item: a normal done.
  const done = second.service.update(item.id, { status: 'done' });
  assert.deepEqual([done.status, done.schedule_state, done.next_at], ['done', null, null]);
  second.db.close();
});

test('missed times fire once with the count; a recurring reminder done goes back to To do for its next time; done before its time skips that time; ends after N', () => {
  const { service, seen, at } = setup();
  const item = service.create({ title: 'Water the plants', schedule: daily('09:00', { ends: { kind: 'after', count: 2 } }) });
  at('2026-11-23T03:00:00Z'); // the engine was off over four 09:00s
  service.fireDue();
  const fired = service.get(item.id);
  assert.deepEqual([fired.runs, fired.schedule_state, fired.next_at], [1, 'due', '2026-11-24T01:00:00.000Z']);
  const event = service.events(item.id)[0];
  assert.deepEqual([event.type, event.data.missed, event.data.action], ['scheduled', 4, 'remind']);
  const done = service.update(item.id, { status: 'done' });
  assert.deepEqual([done.status, done.schedule_state, done.next_at, done.last_done_at, done.completed_at], ['todo', 'waiting', '2026-11-24T01:00:00.000Z', '2026-11-23T03:00:00.000Z', null]);
  const doneEvent = service.events(item.id)[0];
  assert.deepEqual([doneEvent.type, doneEvent.to_status, doneEvent.data.recurring], ['status', 'done', true]);
  assert.equal(seen.at(-1).item.status, 'todo');
  // The second and last run.
  at('2026-11-24T01:00:00Z');
  service.fireDue();
  assert.equal(service.get(item.id).next_at, null, 'ends after 2 runs');
  const last = service.update(item.id, { status: 'done' });
  assert.deepEqual([last.status, last.schedule_state, last.next_at], ['done', null, null], 'a normal done item at the end');

  const early = service.create({ title: 'Report', schedule: daily('17:00') });
  assert.equal(early.next_at, '2026-11-24T09:00:00.000Z');
  const skipped = service.update(early.id, { status: 'done' });
  assert.deepEqual([skipped.status, skipped.schedule_state, skipped.next_at], ['todo', 'waiting', '2026-11-25T09:00:00.000Z'], 'done while it waits skips that time');
  // Cancelled ends what is left; opened again it picks up its next time.
  const cancelled = service.update(early.id, { status: 'cancelled' });
  assert.deepEqual([cancelled.next_at, cancelled.schedule_state], [null, null]);
  const reopened = service.update(early.id, { status: 'todo' });
  assert.deepEqual([reopened.next_at, reopened.schedule_state], ['2026-11-24T09:00:00.000Z', 'waiting']);
});

test('across a daylight saving change the stored zone decides, not the clock of the moment', () => {
  const { service, at } = setup({ tz: 'America/New_York', clock: { now: Date.parse('2027-03-13T12:00:00Z') } });
  const item = service.create({ title: 'Backup check', schedule: daily('02:30') });
  assert.equal(item.next_at, '2027-03-14T07:00:00.000Z', '02:30 does not exist that night: 03:00 EDT');
  at('2027-03-14T07:00:00Z');
  service.fireDue();
  assert.equal(service.get(item.id).next_at, '2027-03-15T06:30:00.000Z');
});

test('a prompt goes to an idle session and the run is done; a busy or missing session puts it in Needs you with the reason; run now', () => {
  const { service, sessions, seen, at } = setup();
  sessions.state.sessions.set('1:t1', 'idle');
  fails(() => service.create({ title: 'x', then_action: { kind: 'prompt', task_id: 9, terminal_id: 'nope', text: 'hi' } }), 'VALIDATION_FAILED');
  const item = service.create({ title: 'Morning check', schedule: daily(), then_action: { kind: 'prompt', task_id: 1, terminal_id: 't1', text: 'Check the build' } });
  assert.deepEqual(item.then_action, { kind: 'prompt', task_id: '1', terminal_id: 't1', text: 'Check the build' });
  at('2026-11-20T01:00:00Z');
  service.fireDue();
  assert.deepEqual(sessions.state.sent, [{ taskId: 1, terminalId: 't1', text: 'Check the build' }]);
  const sent = service.get(item.id);
  assert.deepEqual([sent.status, sent.schedule_state, sent.runs, sent.next_at, sent.last_done_at], ['todo', 'waiting', 1, '2026-11-21T01:00:00.000Z', '2026-11-20T01:00:00.000Z']);
  assert.deepEqual(service.events(item.id).slice(0, 2).map(event => event.type), ['prompt_sent', 'scheduled']);
  assert.equal(seen.at(-1).scheduled_due, undefined, 'a sent prompt is no reminder');

  sessions.state.sessions.set('1:t1', 'busy');
  at('2026-11-21T01:00:00Z');
  service.fireDue();
  const busy = service.get(item.id);
  assert.deepEqual([busy.status, busy.schedule_state, busy.attention_reason], ['waiting_user', 'due', 'The session was busy at 09:00; the prompt was not sent']);
  assert.equal(sessions.state.sent.length, 1, 'nothing typed into a busy session');
  fails(() => service.runNow(item.id), 'SESSION_BUSY', 409);
  sessions.state.sessions.set('1:t1', 'stopped');
  fails(() => service.runNow(item.id), 'SESSION_NOT_RUNNING', 409);
  sessions.state.sessions.set('1:t1', 'idle');
  const again = service.runNow(item.id, { actor: 'user' });
  assert.deepEqual([again.status, again.schedule_state, again.attention_reason, again.next_at], ['todo', 'waiting', null, '2026-11-22T01:00:00.000Z']);
  assert.equal(sessions.state.sent.length, 2);
  // A once prompt is done when it was sent.
  const once = service.create({ title: 'Once', schedule: { kind: 'once', at: '2026-11-21T09:30' }, then_action: { kind: 'prompt', task_id: 1, terminal_id: 't1', text: 'go' } });
  at('2026-11-21T01:30:00Z');
  service.fireDue();
  assert.equal(service.get(once.id).status, 'done');
  // A session that is gone at the moment of typing: stored as not sent.
  sessions.state.sessions.set('1:t2', 'idle');
  const lost = service.create({ title: 'Lost', then_action: { kind: 'prompt', task_id: 1, terminal_id: 't2', text: 'go' } });
  sessions.send = () => false;
  service.setSessions({ ...sessions, send: () => false });
  const after = service.runNow(lost.id);
  assert.deepEqual([after.status, after.attention_reason], ['waiting_user', 'The session was not running at 09:30; the prompt was not sent']);
  // A remind item fires now; one without schedule or prompt cannot.
  const plain = service.create({ title: 'Plain' });
  fails(() => service.runNow(plain.id), 'VALIDATION_FAILED', 400);
});

test('a script runs in a new terminal: exit 0 is done, another exit or the time limit is Needs you with its terminal; the last 5 terminals are kept', () => {
  const { service, sessions, at } = setup();
  fails(() => service.create({ title: 'x', then_action: { kind: 'script', task_id: 2, script: 'make' } }), 'VALIDATION_FAILED');
  fails(() => service.create({ title: 'x', then_action: { kind: 'script', task_id: 99, script: 'make' } }), 'VALIDATION_FAILED');
  const item = service.create({ title: 'Nightly build', schedule: daily('09:00'), then_action: { kind: 'script', task_id: 1, script: 'npm test', timeout_min: 5 } });
  at('2026-11-20T01:00:00Z');
  service.fireDue();
  const run = sessions.state.scripts[0];
  assert.deepEqual([run.taskId, run.script, run.timeoutMs, run.title], [1, 'npm test', 5 * 60 * 1000, 'Nightly build · 09:00']);
  const running = service.get(item.id);
  assert.deepEqual([running.status, running.schedule_state, running.context.tagent, running.script_runs.length], ['working', 'due', { task_id: '1', terminal_id: 'run-1' }, 1]);
  // While it runs, the next time does not start a second run, and run now is refused.
  fails(() => service.runNow(item.id), 'SCRIPT_RUNNING', 409);
  at('2026-11-21T01:00:00Z');
  service.fireDue();
  assert.equal(sessions.state.scripts.length, 1);
  assert.equal(service.events(item.id)[0].data.outcome, 'skipped');
  run.onEnd({ outcome: 'exit', exit: 0, duration_ms: 1200, terminal_id: 'run-1' });
  const ok = service.get(item.id);
  assert.deepEqual([ok.status, ok.schedule_state, ok.script_runs[0].exit, ok.script_runs[0].outcome, ok.last_exit], ['todo', 'waiting', 0, 'exit', 0]);
  assert.deepEqual(service.events(item.id)[0].data, { terminal_id: 'run-1', outcome: 'exit', exit: 0, duration_ms: 1200 });
  assert.equal(service.events(item.id)[0].type, 'script_done');
  run.onEnd({ outcome: 'exit', exit: 3, terminal_id: 'run-1' });
  assert.equal(service.get(item.id).status, 'todo', 'a run ends once');

  // Run again, exit 2.
  at('2026-11-21T02:00:00Z');
  service.runNow(item.id, { actor: 'user' });
  sessions.state.scripts[1].onEnd({ outcome: 'exit', exit: 2, duration_ms: 50, terminal_id: 'run-2' });
  const failed = service.get(item.id);
  assert.deepEqual([failed.status, failed.schedule_state, failed.attention_reason, failed.context.tagent.terminal_id], ['waiting_user', 'due', 'Script failed (exit 2) at 10:00', 'run-2']);
  assert.equal(failed.last_exit, 2);
  assert.equal(service.events(item.id)[0].type, 'script_failed');
  // The time limit.
  service.runNow(item.id, { actor: 'user' });
  sessions.state.scripts[2].onEnd({ outcome: 'timeout', exit: null, duration_ms: 300000, terminal_id: 'run-3' });
  assert.equal(service.get(item.id).attention_reason, 'Script stopped after 5 min at 10:00');
  assert.equal(service.get(item.id).last_exit, null, 'a run stopped by the time limit has no exit status');
  // Four more runs: the oldest two terminals are removed, five are kept.
  for (let index = 4; index <= 7; index += 1) {
    service.runNow(item.id, { actor: 'user' });
    sessions.state.scripts[index - 1].onEnd({ outcome: 'exit', exit: 0, terminal_id: `run-${index}` });
  }
  assert.deepEqual(sessions.state.removed, ['1:run-1', '1:run-2']);
  assert.deepEqual(service.get(item.id).script_runs.map(entry => entry.terminal_id), ['run-3', 'run-4', 'run-5', 'run-6', 'run-7']);
  // A run open when the server stopped is ended as stopped at the next start.
  service.runNow(item.id, { actor: 'user' });
  assert.equal(service.recoverScripts().length, 1);
  assert.equal(service.get(item.id).attention_reason, 'Script stopped at 10:00');
});

test('a script is set or changed only by the person: a terminal token gets 403 SCRIPT_NEEDS_PERSON, and may still mark it done', () => {
  const { service, sessions } = setup();
  sessions.state.sessions.set('1:t1', 'idle');
  const tagent = { task_id: '1', terminal_id: 't1' };
  const script = { kind: 'script', task_id: 1, script: 'echo hi' };
  fails(() => service.create({ title: 'x', then_action: script }, { tagent }), 'SCRIPT_NEEDS_PERSON', 403);
  const item = service.create({ title: 'Mine', schedule: daily(), then_action: script }, { actor: 'cli' });
  fails(() => service.update(item.id, { then_action: { ...script, script: 'rm -rf ~' } }, { tagent }), 'SCRIPT_NEEDS_PERSON', 403);
  fails(() => service.update(item.id, { then_action: null }, { tagent }), 'SCRIPT_NEEDS_PERSON', 403);
  fails(() => service.update(item.id, { schedule: daily('10:00') }, { tagent }), 'SCRIPT_NEEDS_PERSON', 403);
  fails(() => service.runNow(item.id, { tagent }), 'SCRIPT_NEEDS_PERSON', 403);
  assert.equal(service.update(item.id, { status: 'done', title: 'Mine' }, { tagent }).schedule_state, 'waiting', 'reading and marking done are fine');
  // The person (no terminal token) changes it, and the event says who.
  service.update(item.id, { then_action: { ...script, script: 'echo bye' } }, { actor: 'user' });
  const event = service.events(item.id)[0];
  assert.deepEqual([event.actor, event.data.then_action.script], ['user', 'echo bye']);
  // A prompt is not restricted.
  assert.ok(service.create({ title: 'p', then_action: { kind: 'prompt', task_id: 1, terminal_id: 't1', text: 'x' } }, { tagent }));
});

test('the timer fires at the next time (at most a minute apart) and is set again by a change that brings a time closer', () => {
  const { service, clock } = setup();
  const pending = [];
  const timers = { setTimeout: (fn, ms) => { const entry = { fn, ms }; pending.push(entry); return entry; }, clearTimeout: entry => { const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1); } };
  const scheduler = createAttentionScheduler({ service, now: () => clock.now, timers, log: () => {} });
  scheduler.start();
  assert.deepEqual(pending.map(entry => entry.ms), [60000], 'nothing scheduled: a minute');
  const item = service.create({ title: 'Soon', schedule: { kind: 'once', at: '2026-11-20T08:30' } }); // now in Taipei
  assert.deepEqual(pending.map(entry => entry.ms), [0], 'a time that has come: at once');
  pending.shift().fn();
  assert.equal(service.get(item.id).schedule_state, 'due');
  assert.deepEqual(pending.map(entry => entry.ms), [60000]);
  service.create({ title: 'Later', schedule: { kind: 'once', at: '2026-11-20T08:30' } });
  clock.now += 20000;
  service.create({ title: 'In 30 s', schedule: { kind: 'once', at: '2026-11-20T08:31' } });
  assert.equal(pending.length, 1);
  scheduler.stop();
  assert.equal(pending.length, 0);
});

test('a scheduled reminder reaches the notifiers once per firing, through the rules of Needs you, at once', async () => {
  const { service, at } = setup();
  const calls = [];
  const plugin = { name: 'fake', label: 'Fake', configFields: [], ready: () => true, async notify(args) { calls.push(args); return { outcome: 'sent' }; }, async test() { return { ok: true }; } };
  const notifyDb = new Database(':memory:');
  notifyDb.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  let replay = null;
  const notifier = notify.createAttentionNotify({
    db: notifyDb, sessionSecret: 'attention-schedule-test-secret-0123456789', getOwner: () => 'owner', notifiers: [plugin], log: () => {},
    onChange: fn => { replay = fn; return service.onChange(fn); }, now: () => Date.parse('2026-11-20T01:00:00Z'),
  });
  notifier.saveRules('owner', { messageDelayMinutes: 5 });
  service.create({ title: 'Pay rent', schedule: daily('09:00') });
  at('2026-11-20T01:00:00Z');
  const [fired] = service.fireDue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'sent at once, without the message delay');
  assert.deepEqual([calls[0].item.title, calls[0].mode, calls[0].reason], ['Pay rent', 'message', 'status']);
  replay({ kind: 'updated', item: fired, previous: fired, event: { actor: 'schedule' }, scheduled_due: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'the same firing is not sent twice');
  notifier.saveRules('owner', { statuses: ['failed'] });
  at('2026-11-21T01:00:00Z');
  service.fireDue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'Needs you switched off: no reminder');
});

test('copies carry the fields; run now and a schedule change are refused while the owner is offline, an unchanged schedule is not', () => {
  const { db, service, sessions } = setup();
  sessions.state.sessions.set('1:t1', 'busy');
  const item = service.create({ title: 'Copied', schedule: daily(), then_action: { kind: 'prompt', task_id: 1, terminal_id: 't1', text: 'x' } });
  const row = db.prepare('SELECT * FROM attention_items WHERE id = ?').get(item.id);
  assert.equal(JSON.stringify(rowToItem(row)), JSON.stringify(service.get(item.id)), 'the check at start sees the journal as the bus wrote it');
  assert.ok(merge.rowFromPeer({ owner: 'peer-1', id: item.id, rev: 1, item, at: new Date(T0).toISOString() }).item.schedule_text);
  assert.deepEqual(merge.slimEvent({ type: 'scheduled', actor: 'schedule' }, { scheduled_due: true }), { type: 'scheduled', actor: 'schedule', scheduled_due: true });
  assert.equal(merge.queueRule('POST', '/run-now', {}).refuse.error, 'ATTENTION_OWNER_OFFLINE');
  assert.equal(merge.queueRule('PATCH', '', { schedule: daily('10:00') }).refuse.status, 409);
  assert.equal(merge.queueRule('PATCH', '', { then_action: { kind: 'remind' } }).refuse.status, 409);
  const body = merge.withoutSameSchedule({ title: 'New title', schedule: { rule: { time: '09:00', freq: 'daily' }, kind: 'repeat', tz: 'Asia/Taipei' }, then_action: item.then_action }, item);
  assert.deepEqual(body, { title: 'New title' });
  assert.deepEqual(merge.queueRule('PATCH', '', body).queue.fields, { title: 'New title' });
  const plain = service.create({ title: 'Plain' });
  assert.deepEqual(merge.withoutSameSchedule({ then_action: { kind: 'remind' }, schedule: null }, plain), {});
});

test('a yearly birthday is an ordinary scheduled item: next_at and waiting when saved, fired on its day, done puts it back for its next year', () => {
  const { service, at } = setup();
  const birthday = { kind: 'repeat', rule: { freq: 'yearly', month: 11, day: 20, occasion: 'birthday', year: 1964, time: '09:00' } };
  const item = service.create({ title: 'Mum', schedule: birthday });
  assert.deepEqual([item.next_at, item.schedule_state, item.status, item.schedule_text], ['2026-11-20T01:00:00.000Z', 'waiting', 'todo', 'Every year on 11-20 at 09:00 · birthday']);
  assert.deepEqual(item.schedule.rule, { freq: 'yearly', calendar: 'solar', month: 11, day: 20, occasion: 'birthday', year: 1964, time: '09:00' });
  at('2026-11-20T01:00:00Z');
  service.fireDue();
  const due = service.get(item.id);
  assert.deepEqual([due.schedule_state, due.runs, due.next_at], ['due', 1, '2027-11-20T01:00:00.000Z']);
  at('2026-11-20T02:00:00Z');
  const done = service.update(item.id, { status: 'done' });
  assert.deepEqual([done.status, done.schedule_state, done.next_at], ['todo', 'waiting', '2027-11-20T01:00:00.000Z']);
  // A lunar one: 10/7 was 2026-11-15, already past, so its next day is 2027-11-04.
  const lunarItem = service.create({ title: 'Grandpa', schedule: { kind: 'repeat', rule: { freq: 'yearly', calendar: 'lunar', month: 10, day: 7, time: '09:00' } } });
  assert.deepEqual([lunarItem.next_at, lunarItem.schedule_state], ['2027-11-04T01:00:00.000Z', 'waiting']);
  fails(() => service.create({ title: 'x', schedule: { kind: 'repeat', rule: { freq: 'yearly', month: 2, day: 30, time: '09:00' } } }), 'VALIDATION_FAILED', 400);
});
