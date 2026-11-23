// The rules of "Plan usage" in the session header (scripts/h5-shell/plan-usage.mjs, "Plan usage: the page" in docs/design/plan-usage-page.md): the bars,
// the low mark, a window whose reset has passed, not read yet, the pace projection, the English texts, the engine that is shown and the other engines'
// lines grouped by account hash, the running sessions; and that every text has its Chinese translation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const load = () => import('../scripts/h5-shell/plan-usage.mjs');
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A fixed local time (the texts use the clock of the person's device): Wednesday 2026-11-18 15:20 local.
const NOW = new Date(2026, 10, 18, 15, 20, 0).getTime();
const at = (days, hours, minutes) => new Date(2026, 10, 18 + days, hours, minutes, 0).getTime();
const win5 = (used, resetsAt) => ({ id: '5h', label: '5h', usedPercent: used, resetsAt });
const win7 = (used, resetsAt) => ({ id: '7d', label: '7d', usedPercent: used, resetsAt });
const usage = (agent, extra = {}) => ({ agent, state: 'ok', account: 'aaaaaaaaaaaa', read_at: NOW - 2 * MIN, windows: [], ...extra });
const answer = agents => ({ engine: { instance_id: 'i1', name: 'T01' }, agents });
const LOCAL = { key: 'local', label: 'This machine', name: 'T01', listed: true, capabilities: null };
const K01 = { key: 'remote:7', label: 'K01', listed: true, capabilities: ['agent-usage:read'], offline: false };
const K02 = { key: 'remote:8', label: 'K02', listed: true, capabilities: ['agent-usage:read'], offline: false };

function i18n() {
  const JS = path.join(__dirname, '..', 'public', 'js');
  const sandbox = { TALocalKeys: { get: () => 'zh', set() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-server.js', 'i18n-zh-extra.js']) vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox);
  return sandbox.I18n;
}

test('the bars: plan left and time left of each window, the 5-hour one first', async () => {
  const { agentView, barsOf } = await load();
  const view = agentView(usage('claude', { windows: [win7(19, NOW + 4 * DAY), win5(38, NOW + 3 * HOUR + 10 * MIN)] }), NOW);
  assert.deepEqual(view.windows.map(win => win.id), ['5h', '7d']);
  assert.equal(view.windows[0].left, 62);
  assert.equal(view.windows[1].left, 81);
  const bars = barsOf(view);
  assert.deepEqual(bars.map(bar => `${bar.window}:${bar.kind}`), ['5h:plan', '5h:time', '7d:plan', '7d:time']);
  assert.equal(bars[0].value, 0.62);
  assert.ok(Math.abs(bars[1].value - 190 / 300) < 1e-9, 'time left: 3 h 10 min of 5 h');
  assert.ok(Math.abs(bars[3].value - 4 / 7) < 1e-9);
  assert.equal(view.inBars, true);
  assert.equal(view.outlined, false);
  assert.equal(view.lowText, '');
});

test('10% or less left is low, and its number is the low text', async () => {
  const { agentView } = await load();
  const view = agentView(usage('codex', { windows: [win5(76, NOW + 3 * HOUR), win7(92, NOW + 2 * DAY)] }), NOW);
  assert.equal(view.windows[0].low, false);
  assert.equal(view.windows[1].low, true);
  assert.equal(view.lowText, '7d 8%');
  assert.equal(agentView(usage('codex', { windows: [win5(90, NOW + HOUR)] }), NOW).lowText, '5h 10%', 'exactly 10% is low');
  assert.equal(agentView(usage('codex', { windows: [win5(89.6, NOW + HOUR)] }), NOW).lowText, '', '10.4% is not');
});

test('a window whose reset has passed is full again, "not read since"', async () => {
  const { agentView, barsOf } = await load();
  const reset = at(0, 14, 30);
  const view = agentView(usage('claude', { read_at: NOW - 3 * HOUR, windows: [win5(97, reset), win7(50, NOW + 3 * DAY)] }), NOW);
  const [five] = view.windows;
  assert.equal(five.passed, true);
  assert.equal(five.left, 100);
  assert.equal(five.low, false);
  assert.equal(five.resetText, 'reset at 14:30, not read since');
  assert.equal(five.pace, '');
  assert.equal(barsOf(view)[0].value, 1);
  const old = agentView(usage('claude', { windows: [win7(10, at(-3, 9, 0))] }), NOW).windows[0];
  assert.equal(old.resetText, 'reset at Sun 09:00, not read since', 'more than a day ago: with the weekday');
});

test('not read yet: outlined bars with no fill; signed out and errors are left out of the bars', async () => {
  const { agentView, barsOf, agentMessage } = await load();
  const notRead = agentView({ agent: 'codex', state: 'not_read', account: null, read_at: null, windows: [] }, NOW);
  assert.equal(notRead.inBars, true);
  assert.equal(notRead.outlined, true);
  assert.deepEqual(barsOf(notRead).map(bar => bar.value), [0, 0, 0, 0]);
  assert.equal(agentMessage(notRead, 'T01'), 'Not read yet');
  const out = agentView({ agent: 'codex', state: 'signed_out', account: null, read_at: NOW, windows: [] }, NOW);
  assert.equal(out.inBars, false);
  assert.equal(agentMessage(out, 'T01'), 'Codex is not signed in on T01');
  const error = agentView({ agent: 'claude', state: 'error', account: null, read_at: NOW, windows: [] }, NOW);
  assert.equal(error.inBars, false);
  assert.equal(agentMessage(error, 'T01'), 'Could not read Claude on T01');
  const noPlan = agentView({ agent: 'claude', state: 'no_plan', account: null, read_at: NOW, windows: [] }, NOW);
  assert.equal(noPlan.inBars, false, 'no plan limits: not in the bars');
  assert.equal(agentMessage(noPlan, 'T01'), 'Claude on T01 reports no plan limits (an API key, or not signed in)');
});

test('reset texts: within a day "resets in 3 h 10 min · 18:30", later "resets Fri 09:00"', async () => {
  const { windowView, spanText, aboutText, ageText } = await load();
  assert.equal(windowView(win5(10, at(0, 18, 30)), NOW).resetText, 'resets in 3 h 10 min · 18:30');
  assert.equal(windowView(win5(10, NOW + 45 * MIN), NOW).resetText, `resets in 45 min · 16:05`);
  assert.equal(windowView(win7(10, at(2, 9, 0)), NOW).resetText, 'resets Fri 09:00');
  assert.equal(windowView({ id: '5h', label: '5h', usedPercent: 10, resetsAt: null }, NOW).resetText, '');
  assert.equal(spanText(2 * DAY + 19 * HOUR), '2 d 19 h');
  assert.equal(spanText(3 * HOUR), '3 h');
  assert.equal(spanText(10 * 1000), '1 min');
  assert.equal(aboutText(40 * MIN), '40 min');
  assert.equal(aboutText(2 * HOUR + 10 * MIN), '2 h');
  assert.equal(aboutText(DAY + HOUR), '1 day');
  assert.equal(aboutText(3 * DAY), '3 days');
  assert.equal(ageText(NOW - 20 * 1000, NOW), 'read just now');
  assert.equal(ageText(NOW - 2 * MIN, NOW), 'read 2 min ago');
  assert.equal(ageText(NOW - 3 * HOUR, NOW), 'read 3 h ago');
});

test('pace: a line only when the plan runs out more than 10 minutes and 2% of the window before the reset', async () => {
  const { paceText, windowView } = await load();
  // 5 h window, 2 h elapsed, 60% used: 100% at 3 h 20 min, 1 h 40 min before the reset.
  assert.equal(paceText(win5(60, NOW + 3 * HOUR), NOW), 'At this pace it runs out about 2 h before the reset');
  // On pace (40% used after 2 h of 5): no line.
  assert.equal(paceText(win5(40, NOW + 3 * HOUR), NOW), '');
  // Just a little early (41% used after 2 h): about 7 min early, under 10 min.
  assert.equal(paceText(win5(41, NOW + 3 * HOUR), NOW), '');
  // 7 days: 3 days elapsed, 60% used: 100% at 5 days, 2 days early.
  assert.equal(paceText(win7(60, NOW + 4 * DAY), NOW), 'At this pace it runs out about 2 days before the reset');
  // 7 days: about 2 h early is under 2% of the window (3.4 h): no line.
  assert.equal(paceText(win7(43.5, NOW + 4 * DAY), NOW), '');
  // Nothing used, all used, no reset time: no line.
  assert.equal(paceText(win5(0, NOW + 3 * HOUR), NOW), '');
  assert.equal(paceText(win5(100, NOW + 3 * HOUR), NOW), '');
  assert.equal(paceText(win5(60, null), NOW), '');
  // The projection is made at the reading, not now.
  assert.equal(windowView(win5(60, NOW + 3 * HOUR), NOW + HOUR, NOW).pace, 'At this pace it runs out about 2 h before the reset');
});

test('the button label names every agent in the bars and each window left', async () => {
  const { agentsOf, buttonLabel } = await load();
  const agents = agentsOf(answer([
    usage('codex', { windows: [win5(76, NOW + 3 * HOUR), win7(92, NOW + 2 * DAY)] }),
    usage('claude', { windows: [win5(38, NOW + 3 * HOUR), win7(19, NOW + 4 * DAY)] }),
  ]), NOW);
  assert.deepEqual(agents.map(view => view.agent), ['claude', 'codex'], 'Claude first');
  assert.equal(buttonLabel(agents), 'Plan usage: Claude 5 hours 62% left, 7 days 81% left; Codex 5 hours 24% left, 7 days 8% left');
  const some = agentsOf(answer([usage('claude', { state: 'not_read', windows: [] }), usage('codex', { state: 'signed_out', windows: [] })]), NOW);
  assert.equal(buttonLabel(some), 'Plan usage: Claude not read yet');
  assert.equal(buttonLabel([]), 'Plan usage');
});

test('the engine shown: the shown task\'s, this machine when none, and this machine when that engine has no plan usage', async () => {
  const { usageModel, shownKeyOf, usageEngines } = await load();
  assert.equal(shownKeyOf({ taskName: 'X', sourceKey: 'remote:7' }), 'remote:7');
  assert.equal(shownKeyOf({ taskName: '', sourceKey: 'remote:7' }), 'local');
  const older = { key: 'remote:9', label: 'OLD', listed: true, capabilities: ['tasks:archive'] };
  assert.deepEqual(usageEngines([LOCAL, K01, older, { ...K02, listed: false }]).map(engine => engine.key), ['local', 'remote:7']);
  const readings = {
    local: { status: 'ok', answer: answer([usage('claude', { windows: [win5(10, NOW + HOUR)] })]), fetchedAt: NOW },
    'remote:7': { status: 'ok', answer: answer([usage('claude', { account: 'bbbbbbbbbbbb', windows: [win5(50, NOW + HOUR)] })]), fetchedAt: NOW },
  };
  assert.equal(usageModel({ readings, sources: [LOCAL, K01], shownKey: 'remote:7', now: NOW }).key, 'remote:7');
  assert.equal(usageModel({ readings, sources: [LOCAL, K01], shownKey: 'local', now: NOW }).header, 'T01 · read 2 min ago');
  const fallback = usageModel({ readings, sources: [LOCAL, K01, older], shownKey: 'remote:9', now: NOW });
  assert.equal(fallback.key, 'local');
  assert.equal(fallback.olderNote, 'OLD cannot report plan usage until it is updated.');
  const missing = usageModel({ readings: { ...readings, 'remote:7': { status: 'missing', answer: null } }, sources: [LOCAL, K01], shownKey: 'remote:7', now: NOW });
  assert.equal(missing.key, 'local');
  assert.equal(usageModel({ readings: {}, sources: [LOCAL], shownKey: 'local', now: NOW }), null, 'nothing answered: no button');
  assert.equal(usageModel({ readings: { local: { status: 'ok', answer: answer([]) } }, sources: [LOCAL], now: NOW }), null, 'no agent: no button');
  const offline = usageModel({ readings: { ...readings, 'remote:7': { ...readings['remote:7'], status: 'offline' } }, sources: [LOCAL, K01], shownKey: 'remote:7', now: NOW + 3 * HOUR });
  assert.equal(offline.offline, true);
  assert.equal(offline.header, 'K01 is offline · read 3 h ago');
});

test('other engines: the same account in one line, other accounts grouped by their hash, states and offline engines', async () => {
  const { usageModel } = await load();
  const claude = (account, extra = {}) => usage('claude', { account, windows: [win5(38, NOW + 3 * HOUR), win7(19, NOW + 4 * DAY)], ...extra });
  const codex = (account, extra = {}) => usage('codex', { account, windows: [win5(29, NOW + 3 * HOUR), win7(34, NOW + 2 * DAY)], ...extra });
  const K03 = { key: 'remote:9', label: 'K03', listed: true, capabilities: ['agent-usage:read'] };
  const K04 = { key: 'remote:10', label: 'K04', listed: true, capabilities: ['agent-usage:read'] };
  const readings = {
    local: { status: 'ok', answer: answer([claude('aaaaaaaaaaaa'), codex('cccccccccccc')]) },
    'remote:7': { status: 'ok', answer: answer([claude('aaaaaaaaaaaa'), codex('dddddddddddd')]) },
    'remote:8': { status: 'ok', answer: answer([claude('aaaaaaaaaaaa'), codex('dddddddddddd', { read_at: NOW - MIN, windows: [win5(50, NOW + HOUR), win7(60, NOW + DAY * 2)] })]) },
    'remote:9': { status: 'ok', answer: answer([usage('claude', { state: 'signed_out', account: null }), codex(null)]) },
    'remote:10': { status: 'offline', answer: answer([claude('aaaaaaaaaaaa', { read_at: NOW - 3 * HOUR })]) },
  };
  const model = usageModel({ readings, sources: [LOCAL, K01, K02, K03, K04], shownKey: 'local', now: NOW });
  assert.deepEqual(model.others, [
    'K04 is offline · read 3 h ago',
    'K01, K02 use the same Claude account.',
    'Claude is not signed in on K03',
    'Codex on K01, K02: another account, 5 hours 50% left, 7 days 40% left.',
    'Codex on K03, account unknown: 5 hours 71% left, 7 days 66% left.',
  ]);
  const one = usageModel({ readings: { local: readings.local, 'remote:7': readings['remote:7'] }, sources: [LOCAL, K01], shownKey: 'local', now: NOW });
  assert.deepEqual(one.others, ['K01 uses the same Claude account.', 'Codex on K01: another account, 5 hours 71% left, 7 days 66% left.']);
  const notRead = usageModel({ readings: { local: readings.local, 'remote:7': { status: 'ok', answer: answer([usage('codex', { state: 'not_read', account: null })]) } }, sources: [LOCAL, K01], now: NOW });
  assert.deepEqual(notRead.others, ['Codex on K01: not read yet.']);
});

test('running sessions: Claude and Codex terminals of that engine, not notebooks or other kinds the list names', async () => {
  const { runningSessions } = await load();
  const state = {
    terminalActivity: { local: { 1: { a: 'running', b: 'running', c: 'done', n: 'running' }, 2: { x: 'running' } }, 'remote:7': { 3: { y: 'running' } } },
    taskList: { tasks: [{ id: 1, source: 'local', sessions: { rows: [{ kind: 'terminal', id: 'a', agent: 'claude' }, { kind: 'terminal', id: 'b', agent: 'codex' }, { kind: 'terminal', id: 'n', agent: 'notebook' }] } }] },
  };
  assert.deepEqual([...runningSessions(state, 'local')].sort(), ['1|a', '1|b', '2|x']);
  assert.deepEqual([...runningSessions(state, 'remote:7')], ['3|y']);
  assert.deepEqual([...runningSessions({}, 'local')], []);
});

test('every English text of the button and the details has its Chinese translation', async () => {
  const { usageModel, buttonLabel } = await load();
  const I18n = i18n();
  const readings = {
    local: { status: 'ok', answer: answer([
      usage('claude', { windows: [win5(60, NOW + 3 * HOUR), win7(60, NOW + 4 * DAY)] }),
      usage('codex', { windows: [win5(97, at(0, 14, 30)), win7(92, NOW + 40 * MIN)] }),
    ]) },
    'remote:7': { status: 'ok', answer: answer([usage('claude'), usage('codex', { account: 'dddddddddddd', windows: [win5(29, NOW + HOUR), win7(34, NOW + DAY * 2)] })]) },
    'remote:8': { status: 'offline', answer: answer([usage('claude', { read_at: NOW - 2 * DAY })]) },
    'remote:9': { status: 'ok', answer: answer([usage('claude', { state: 'signed_out' }), usage('codex', { state: 'error' })]) },
  };
  const K03 = { key: 'remote:9', label: 'K03', listed: true, capabilities: ['agent-usage:read'] };
  const model = usageModel({ readings, sources: [LOCAL, K01, K02, K03], now: NOW });
  const texts = [model.header, ...model.others];
  for (const view of model.details) for (const win of view.windows) texts.push(win.label, `${win.left}% left`, win.resetText, win.pace);
  const states = usageModel({ readings: { local: { status: 'ok', answer: answer([usage('claude', { state: 'not_read', read_at: null }), usage('codex', { state: 'signed_out' })]) } }, sources: [LOCAL], now: NOW });
  texts.push(states.header, ...states.details.map(view => view.message));
  const offline = usageModel({ readings: { local: readings.local, 'remote:7': { ...readings['remote:7'], status: 'offline' } }, sources: [LOCAL, K01], shownKey: 'remote:7', now: NOW + 20 * 1000 });
  texts.push(offline.header, 'K01 cannot report plan usage until it is updated.', 'Plan usage', 'Refresh', 'Refreshing…', 'Codex is not signed in on T01', 'Could not read Codex on T01');
  texts.push('read 1 day ago', 'T01 · read 1 day ago', 'T01 · read 5 days ago', 'T01 is offline · read just now', 'T01 · read 40 min ago', 'T01 · read 3 h ago');
  const missing = texts.filter(Boolean).filter(text => I18n.t(text) === text || /[A-Za-z]{3,}/.test(I18n.t(text).replace(/\b(T01|K0\d|Claude|Codex)\b/g, '')));
  assert.deepEqual(missing, []);
  const label = buttonLabel(model.agents, text => I18n.t(text));
  assert.ok(!/left|hours|days|Plan usage/.test(label), label);
});
