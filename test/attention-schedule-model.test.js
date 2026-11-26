// The schedules of T-Attention on the page (scripts/h5-shell/attention-model.mjs and attention-schedule.mjs; "Scheduled and recurring tasks" in
// docs/design/page-attention.md):
// the Scheduled and Recurring sections, the row line, the "When" / "Then" form and its save body, "Send now", the sessions a prompt can go to and the
// "Due now" reminder. Every time is made from a fixed local "now", so the results do not depend on the clock or the time zone of the machine.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-schedule-model-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

// The sections and the row line are in attention-model.mjs (part of the first screen); the form, the sessions and "Send now" in attention-schedule.mjs
// (only the T-Attention chunk). One object with both, for the tests.
const load = async () => ({
  ...(await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'attention-model.mjs')).href)),
  ...(await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'h5-shell', 'attention-schedule.mjs')).href)),
});
// Friday 2026-11-20 10:00 local time.
const NOW = new Date(2026, 10, 20, 10, 0);
const local = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const item = (id, status, extra = {}) => ({
  id, title: `T${id}`, status, parent_id: null, sort_order: id, priority: 'none', updated_at: '2026-11-01T00:00:00Z',
  schedule: null, then_action: null, next_at: null, schedule_state: null, runs: 0, last_fired_at: null, last_done_at: null, ...extra,
});
const ONCE = { kind: 'once', at: '2026-12-01T10:00', tz: 'Asia/Taipei' };
const WEEKLY = { kind: 'repeat', rule: { freq: 'weekly', days: [1], time: '09:00' }, starts: '2026-11-24', tz: 'Asia/Taipei' };
const WEEKDAYS = { kind: 'repeat', rule: { freq: 'weekdays', time: '09:30' }, tz: 'Asia/Taipei' };

test('Scheduled and Recurring: waiting tasks leave their status section, soonest first; due ones stay where their status puts them', async () => {
  const { homeGroups, timedSections } = await load();
  const items = [
    item(1, 'todo', { schedule: ONCE, schedule_state: 'waiting', next_at: local(30, 10) }),
    item(2, 'todo', { schedule: { ...ONCE, at: '2026-11-21T08:00' }, schedule_state: 'waiting', next_at: local(21, 8) }),
    item(3, 'todo', { schedule: WEEKLY, schedule_state: 'waiting', next_at: local(24, 9) }),
    item(4, 'todo', { schedule: WEEKDAYS, schedule_state: 'waiting', next_at: local(21, 9, 30) }),
    item(5, 'todo', { schedule: WEEKLY, schedule_state: 'due', next_at: local(27, 9) }),
    item(6, 'waiting_user', { schedule: WEEKDAYS, schedule_state: 'due', then_action: { kind: 'prompt', task_id: 1, terminal_id: 't1', text: 'go' } }),
    item(7, 'todo'),
    item(8, 'todo', { schedule: JSON.stringify(WEEKLY), schedule_state: 'waiting', next_at: null }),
  ];
  const [scheduled, recurring] = timedSections(items);
  assert.deepEqual([scheduled.key, scheduled.label, recurring.key, recurring.label], ['scheduled', 'Scheduled', 'recurring', 'Recurring']);
  assert.deepEqual(scheduled.items.map(entry => entry.id), [2, 1], 'once tasks, the soonest first');
  assert.deepEqual(recurring.items.map(entry => entry.id), [4, 3, 8], 'repeating tasks, the soonest next first, none last (a JSON string is read too)');
  const home = homeGroups(items);
  const ids = key => home.sections.find(section => section.key === key).nodes.map(node => node.item.id);
  assert.deepEqual(ids('todo').sort(), [5, 7], 'a due recurring task is in To do');
  assert.deepEqual(ids('needs_you'), [6], 'a busy prompt task is in Needs you');
  assert.deepEqual(timedSections([item(1, 'todo')]).map(section => section.items.length), [0, 0]);
});

test('Scheduled and Recurring with several engines: the time first, then the engine order', async () => {
  const { timedSections } = await load();
  const on = (engine, id, at) => ({ ...item(id, 'todo', { schedule: WEEKLY, schedule_state: 'waiting', next_at: at }), engine, key: `${engine}:${id}` });
  const [, recurring] = timedSections([on('remote:7', 1, local(24, 9)), on('local', 1, local(24, 9)), on('local', 2, local(23, 9))], { engines: ['local', 'remote:7'] });
  assert.deepEqual(recurring.items.map(entry => entry.key), ['local:2', 'local:1', 'remote:7:1']);
});

test('the rule in a few words: once, every day, weekdays, one weekday, several, every N days, monthly', async () => {
  const { ruleTokens, tokensText } = await load();
  const rule = (freq, extra = {}) => tokensText(ruleTokens({ kind: 'repeat', rule: { freq, time: '09:00', ...extra } }));
  assert.equal(tokensText(ruleTokens(ONCE)), 'Once');
  assert.equal(rule('daily'), 'Every day 09:00');
  assert.equal(rule('weekdays'), 'Weekdays 09:00');
  assert.equal(rule('weekly', { days: [1] }), 'Every Monday 09:00');
  assert.equal(rule('weekly', { days: [4, 1, 4] }), 'Every Mon, Thu 09:00');
  assert.equal(rule('weekly', { days: [1, 2, 3, 4, 5] }), 'Weekdays 09:00');
  assert.equal(rule('weekly', { days: [1, 2, 3, 4, 5, 6, 7] }), 'Every day 09:00');
  assert.equal(rule('every', { interval: 3 }), 'Every 3 days 09:00');
  assert.equal(rule('every', { interval: 1 }), 'Every day 09:00');
  assert.equal(rule('monthly', { day: 15 }), 'Monthly on day 15 09:00');
  assert.deepEqual(ruleTokens(null), []);
});

test('moments: today, tomorrow and yesterday by name, other days with the weekday and MM-DD, in local time', async () => {
  const { momentOf, momentTokens, tokensText } = await load();
  assert.deepEqual(momentOf(local(20, 21, 5), NOW), { rel: 'today', day: 'Fri', date: '11-20', time: '21:05' });
  assert.equal(momentOf(local(21, 9, 30), NOW).rel, 'tomorrow');
  assert.equal(momentOf(local(19, 9, 41), NOW).rel, 'yesterday');
  assert.equal(tokensText(momentTokens(momentOf(new Date(2026, 11, 1, 10, 0).toISOString(), NOW))), 'Tue 12-01 10:00');
  assert.equal(tokensText(momentTokens(momentOf(new Date(2027, 0, 1, 0, 0).toISOString(), new Date(2026, 11, 31, 12)))), 'tomorrow 00:00', 'across the year');
  assert.equal(momentOf(null, NOW), null);
});

test('row lines: once, recurring with next and done, due now, a prompt with its session name, and the icon of each', async () => {
  const { scheduleLine, lineText } = await load();
  const line = (entry, name = '') => scheduleLine(entry, { now: NOW, targetName: () => name });
  const once = line(item(1, 'todo', { schedule: ONCE, schedule_state: 'waiting', next_at: new Date(2026, 11, 1, 10).toISOString() }));
  assert.deepEqual([once.icon, once.kind, lineText(once)], ['clockCircle', 'once', 'Once · Tue 12-01 10:00']);
  const daily = line(item(2, 'todo', { schedule: WEEKDAYS, schedule_state: 'waiting', next_at: local(21, 9, 30), last_done_at: local(20, 9, 41) }));
  assert.deepEqual([daily.icon, lineText(daily)], ['sync', 'Weekdays 09:30 · next tomorrow 09:30 · done today 09:41']);
  assert.equal(lineText(line(item(3, 'todo', { schedule: WEEKLY, schedule_state: 'due', next_at: local(20, 9) }))), 'Every Monday 09:00 · due now');
  const prompt = item(4, 'todo', { schedule: { kind: 'repeat', rule: { freq: 'daily', time: '02:00' } }, schedule_state: 'waiting', next_at: local(21, 2), then_action: { kind: 'prompt', task_id: 1, terminal_id: 't1', text: 'Run the tests' } });
  assert.deepEqual([line(prompt, 'ONCALL-CC').icon, lineText(line(prompt, 'ONCALL-CC'))], ['send', 'Every day 02:00 · next tomorrow 02:00 · sends a prompt to ONCALL-CC']);
  assert.deepEqual(line(prompt, 'ONCALL-CC').parts.at(-1), ['sends a prompt to', { name: 'ONCALL-CC' }], 'the session name is never translated');
  assert.equal(lineText(line(prompt)), 'Every day 02:00 · next tomorrow 02:00 · sends a prompt', 'a session the page does not know');
  assert.equal(lineText(line(item(5, 'todo', { schedule: WEEKLY, schedule_state: 'waiting', next_at: null }))), 'Every Monday 09:00 · no next time');
  assert.equal(line(item(6, 'todo')), null, 'no schedule, no line');
  const script = item(7, 'todo', { schedule: { kind: 'repeat', rule: { freq: 'daily', time: '03:00' } }, schedule_state: 'waiting', next_at: local(21, 3), last_exit: 0, then_action: { kind: 'script', task_id: 4, script: './backup.sh', timeout_min: 30 } });
  assert.deepEqual([line(script, 'Notes').icon, lineText(line(script, 'Notes'))], ['terminalKeyboard', 'Every day 03:00 · next tomorrow 03:00 · runs a script in Notes · last: exit 0']);
  assert.equal(lineText(line({ ...script, last_exit: null })), 'Every day 03:00 · next tomorrow 03:00 · runs a script', 'not run yet, task not known');
});

test('row buttons of a task whose time came: Send now for a busy prompt, Open terminal and Run again for a failed script', async () => {
  const { retryActions } = await load();
  const canSendNow = entry => retryActions(entry).includes('Send now');
  const script = { kind: 'script', task_id: 4, script: './backup.sh', timeout_min: 30 };
  assert.deepEqual(retryActions(item(9, 'waiting_user', { schedule: WEEKDAYS, schedule_state: 'due', then_action: script })), ['Open terminal', 'Run again']);
  assert.deepEqual(retryActions(item(10, 'todo', { schedule: WEEKDAYS, schedule_state: 'waiting', then_action: script })), []);
  const prompt = { kind: 'prompt', task_id: 1, terminal_id: 't1', text: 'go' };
  assert.equal(canSendNow(item(1, 'waiting_user', { schedule: WEEKDAYS, schedule_state: 'due', then_action: prompt })), true);
  assert.equal(canSendNow(item(2, 'waiting_user', { schedule: WEEKDAYS, schedule_state: 'due' })), false, 'remind');
  assert.equal(canSendNow(item(3, 'todo', { schedule: WEEKDAYS, schedule_state: 'waiting', then_action: prompt })), false, 'not its time yet');
  assert.equal(canSendNow(item(4, 'waiting_user', { then_action: prompt })), false, 'no schedule state');
});

test('the form echoes a saved schedule and starts from sensible defaults for a task without one', async () => {
  const { scheduleForm } = await load();
  const fresh = scheduleForm(item(1, 'todo'), NOW);
  assert.deepEqual(fresh, {
    when: 'none', onceDate: '2026-11-21', onceTime: '09:00', freq: 'weekly', time: '09:00', days: [5], day: '20', interval: '2', starts: '2026-11-20',
    endsKind: 'never', endsDate: '', endsCount: '10', then: 'remind', session: '', prompt: '', scriptTask: '', script: '', timeoutMin: '30',
    calendar: 'solar', month: '11', yearDay: '20', leap: false, occasion: '', year: '',
  });
  const scripted = scheduleForm(item(5, 'todo', { schedule: WEEKDAYS, then_action: { kind: 'script', task_id: '4', script: './backup.sh', timeout_min: 45 } }), NOW);
  assert.deepEqual([scripted.then, scripted.scriptTask, scripted.script, scripted.timeoutMin], ['script', '4', './backup.sh', '45']);
  const once = scheduleForm(item(2, 'todo', { schedule: ONCE }), NOW);
  assert.deepEqual([once.when, once.onceDate, once.onceTime], ['once', '2026-12-01', '10:00']);
  const weekly = scheduleForm(item(3, 'todo', {
    schedule: { ...WEEKLY, rule: { freq: 'weekly', days: [1, 4], time: '08:15' }, ends: { kind: 'after', count: 5 } },
    then_action: { kind: 'prompt', task_id: 7, terminal_id: 'h5-abc', text: 'Summarise the week' },
  }), NOW);
  assert.deepEqual([weekly.when, weekly.freq, weekly.days, weekly.time, weekly.starts, weekly.endsKind, weekly.endsCount, weekly.then, weekly.session, weekly.prompt],
    ['repeat', 'weekly', [1, 4], '08:15', '2026-11-24', 'after', '5', 'prompt', '7|h5-abc', 'Summarise the week']);
  assert.equal(scheduleForm(item(4, 'todo', { schedule: { ...WEEKDAYS } }), NOW).starts, '', 'a saved schedule without a start keeps none');
});

test('the form as a save body: each kind of rule, the ends, the prompt, and a clear English error for what cannot be saved', async () => {
  const { scheduleForm, scheduleFromForm } = await load();
  const base = { ...scheduleForm(item(1, 'todo'), NOW) };
  assert.deepEqual(scheduleFromForm(base), { schedule: null, then_action: null }, 'No date');
  assert.deepEqual(scheduleFromForm({ ...base, when: 'once' }), { schedule: { kind: 'once', at: '2026-11-21T09:00' }, then_action: { kind: 'remind' } });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'repeat', days: [4, 1] }).schedule, { kind: 'repeat', rule: { freq: 'weekly', time: '09:00', days: [1, 4] }, starts: '2026-11-20' });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'repeat', freq: 'daily', starts: '' }).schedule, { kind: 'repeat', rule: { freq: 'daily', time: '09:00' } });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'repeat', freq: 'monthly', day: '31' }).schedule.rule, { freq: 'monthly', time: '09:00', day: 31 });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'repeat', freq: 'every', interval: '3' }).schedule.rule, { freq: 'every', time: '09:00', interval: 3 });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'repeat', freq: 'daily', endsKind: 'on', endsDate: '2026-12-31' }).schedule.ends, { kind: 'on', date: '2026-12-31' });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'repeat', freq: 'daily', endsKind: 'after', endsCount: '12' }).schedule.ends, { kind: 'after', count: 12 });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'once', then: 'prompt', session: '7|h5-abc', prompt: '  Run the tests\n' }).then_action, { kind: 'prompt', task_id: 7, terminal_id: 'h5-abc', text: 'Run the tests' });
  assert.deepEqual(scheduleFromForm({ ...base, when: 'once', then: 'script', scriptTask: '4', script: ' ./backup.sh && git push \n', timeoutMin: '30' }).then_action,
    { kind: 'script', task_id: 4, script: './backup.sh && git push', timeout_min: 30 });
  const errors = [
    [{ when: 'once', then: 'script', scriptTask: '', script: 'x' }, 'Choose the task the script runs in'],
    [{ when: 'once', then: 'script', scriptTask: '4', script: ' ' }, 'Write the script to run'],
    [{ when: 'once', then: 'script', scriptTask: '4', script: 'x'.repeat(4001) }, 'The script is longer than 4000 characters'],
    [{ when: 'once', then: 'script', scriptTask: '4', script: 'x', timeoutMin: '721' }, 'The time limit is 1 to 720 minutes'],
    [{ when: 'once', onceTime: '' }, 'Choose a date and a time'],
    [{ when: 'once', onceDate: '2026-13' }, 'Choose a date and a time'],
    [{ when: 'repeat', days: [] }, 'Choose at least one day'],
    [{ when: 'repeat', time: '25:00' }, 'Choose a time'],
    [{ when: 'repeat', freq: 'monthly', day: '32' }, 'The day of the month is 1 to 31'],
    [{ when: 'repeat', freq: 'every', interval: '0' }, 'Repeat every 1 to 365 days'],
    [{ when: 'repeat', freq: 'daily', endsKind: 'on', endsDate: '' }, 'Choose the end date'],
    [{ when: 'repeat', freq: 'daily', endsKind: 'on', endsDate: '2026-11-01' }, 'The end date is before the start'],
    [{ when: 'repeat', freq: 'daily', endsKind: 'after', endsCount: '0' }, 'End after 1 to 9999 times'],
    [{ when: 'once', then: 'prompt', session: '', prompt: 'x' }, 'Choose a session for the prompt'],
    [{ when: 'once', then: 'prompt', session: '7|t1', prompt: '   ' }, 'Write the prompt to send'],
    [{ when: 'once', then: 'prompt', session: '7|t1', prompt: 'x'.repeat(4001) }, 'The prompt is longer than 4000 characters'],
  ];
  for (const [change, error] of errors) assert.deepEqual(scheduleFromForm({ ...base, ...change }), { error }, JSON.stringify(change));
});

test('the PATCH body takes "When" and "Then" only when they changed, compared by meaning (zone, a never end and the day order do not count)', async () => {
  const { schedulePatch, scheduleForm } = await load();
  const patchFor = (entry, form) => { const out = schedulePatch(entry, form); return Object.keys(out).length ? out : null; };
  const saved = item(1, 'todo', { schedule: { ...WEEKLY, rule: { freq: 'weekly', days: [4, 1], time: '09:00' }, ends: { kind: 'never' } }, then_action: null, schedule_state: 'waiting' });
  const form = { title: 'T1', notes: '', status: 'todo', priority: 'none', due_date: '', ...scheduleForm(saved, NOW) };
  assert.equal(patchFor(saved, form), null, 'an untouched form sends nothing');
  assert.deepEqual(patchFor(saved, { ...form, time: '10:00' }), { schedule: { kind: 'repeat', rule: { freq: 'weekly', time: '10:00', days: [1, 4] }, starts: '2026-11-24' } });
  assert.deepEqual(patchFor(saved, { ...form, then: 'prompt', session: '7|t1', prompt: 'Go' }), { then_action: { kind: 'prompt', task_id: 7, terminal_id: 't1', text: 'Go' } });
  assert.deepEqual(patchFor(saved, { ...form, when: 'none' }), { schedule: null }, 'No date clears the schedule (its action was already none)');
  const prompted = { ...saved, then_action: { kind: 'prompt', task_id: 7, terminal_id: 't1', text: 'Go' } };
  assert.deepEqual(patchFor(prompted, { ...form, ...scheduleForm(prompted, NOW), when: 'none' }), { schedule: null, then_action: null }, 'No date clears a prompt too');
  assert.deepEqual(patchFor(saved, { ...form, then: 'script', scriptTask: '4', script: './backup.sh', timeoutMin: '30' }), { then_action: { kind: 'script', task_id: 4, script: './backup.sh', timeout_min: 30 } });
  const scripted = { ...saved, then_action: { kind: 'script', task_id: '4', script: './backup.sh', timeout_min: 30 } };
  assert.equal(patchFor(scripted, { ...form, ...scheduleForm(scripted, NOW) }), null, 'a saved script (the server keeps the task id as text) is not sent again');
  assert.equal(patchFor(saved, { ...form, days: [] }), null, 'a form with an error sends no schedule (the edit view shows the error first)');
  const plain = item(2, 'todo');
  const plainForm = { title: 'T2', notes: '', status: 'todo', priority: 'none', due_date: '', ...scheduleForm(plain, NOW) };
  assert.equal(patchFor(plain, plainForm), null);
  assert.deepEqual(patchFor(plain, { ...plainForm, when: 'once' }), { schedule: { kind: 'once', at: '2026-11-21T09:00' } }, 'Remind me is what a null action means already');
  assert.equal(patchFor(plain, { title: 'T2', notes: '', status: 'todo', priority: 'none', due_date: '' }), null, 'a form without the fields (an older engine) sends none');
});

test('the sessions a prompt can go to are those of the item\'s owner engine, from the task list or as read; the row line names them', async () => {
  const { sessionTasks, targetName: promptSessionName, hasSchedule, scriptTerminal } = await load();
  const tasks = [
    { id: 1, title: 'Fix login', source: 'local', sessions: { note: null, rows: [{ kind: 'terminal', id: 't1', title: 'Claude' }, { kind: 'open', id: 'open' }] } },
    { id: 2, title: 'Docs', source: 'local', sessions: null },
    { id: 1, title: 'Deploy site', source: 'remote:7', sessions: null },
    { id: 3, title: 'Old', source: 'remote:7', stale: true },
  ];
  assert.deepEqual(sessionTasks(tasks, 'local'), [
    { taskId: 1, title: 'Fix login', sessions: [{ id: 't1', title: 'Claude', agent: null }] },
    { taskId: 2, title: 'Docs', sessions: null },
  ]);
  const read = new Map([['1', [{ id: 'r1', title: 'ONCALL-CC', agent: 'claude' }]]]);
  assert.deepEqual(sessionTasks(tasks, 'remote:7', read), [{ taskId: 1, title: 'Deploy site', sessions: [{ id: 'r1', title: 'ONCALL-CC', agent: 'claude' }] }], 'its own tasks only; a stale row is left out');
  assert.equal(promptSessionName({ kind: 'prompt', task_id: 1, terminal_id: 'r1' }, tasks, 'remote:7', read), 'ONCALL-CC');
  assert.equal(promptSessionName({ kind: 'prompt', task_id: 1, terminal_id: 't1' }, tasks, 'local'), 'Claude');
  assert.equal(promptSessionName({ kind: 'prompt', task_id: 2, terminal_id: 'x' }, tasks, 'local'), 'Docs', 'sessions not known: the task title');
  assert.equal(promptSessionName({ kind: 'prompt', task_id: 9, terminal_id: 'x' }, tasks, 'local'), '');
  assert.equal(promptSessionName({ kind: 'remind' }, tasks, 'local'), '');
  assert.equal(promptSessionName({ kind: 'script', task_id: 1, script: 'x' }, tasks, 'remote:7'), 'Deploy site', 'a script names its task');
  // The terminal of a failed script run: its task row on the item's own engine (the terminal is new, so the row need not list it yet).
  const rows = [{ id: 9, ref: 'local|9', source: 'local', sessions: { note: null, rows: [] } }, { id: 9, ref: 'remote:7|9', source: 'remote:7' }];
  assert.deepEqual(scriptTerminal({ tagent: { task_id: 9, terminal_id: 'h5-new' } }, 'remote:7', rows), { taskId: 'remote:7|9', terminalId: 'h5-new' });
  assert.deepEqual(scriptTerminal({ tagent: { task_id: '9', terminal_id: 'h5-new' } }, 'local', rows), { taskId: 'local|9', terminalId: 'h5-new' });
  assert.equal(scriptTerminal({ tagent: { task_id: 5, terminal_id: 'x' } }, 'local', rows), null);
  assert.equal(scriptTerminal({}, 'local', rows), null);
  assert.equal(hasSchedule([item(1, 'todo')]), true);
  assert.equal(hasSchedule([{ id: 1, status: 'todo' }]), false, 'an older engine');
});

test('a scheduled reminder: "Due now" once for the firing of a Remind me task; a busy prompt reminds as Needs you; closed or plain changes do not', async () => {
  const { reminderFor } = await load();
  const due = item(1, 'todo', { title: 'Weekly review', schedule: WEEKLY, schedule_state: 'due' });
  assert.deepEqual(reminderFor({ kind: 'updated', item: due, previous: { ...due, schedule_state: 'waiting' }, scheduled_due: true }), { id: 1, status: 'todo', label: 'Due now', title: 'Weekly review', reason: '' });
  assert.equal(reminderFor({ kind: 'updated', item: due, previous: due }), null, 'the same change without the flag');
  assert.equal(reminderFor({ kind: 'updated', item: { ...due, status: 'done' }, scheduled_due: true }), null);
  const busy = item(2, 'waiting_user', { title: 'Nightly run', attention_reason: 'The session was busy at 02:00; the prompt was not sent' });
  assert.equal(reminderFor({ kind: 'updated', item: busy, previous: { ...busy, status: 'todo' }, scheduled_due: true }).label, 'Needs you');
});
