// `tcli attention` (scripts/tcli-attention.js): every t-attention command under tcli, against the small fake T-Attention server, spawned as a
// terminal runs it; and the t-attention additions it brought: run-now, preview and the script action (--script / --script-file, --task,
// --timeout-min). Every run has a temporary HOME and data folder, so the real ~/.tagent is never read or written.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcli-attention-'));
process.env.T_AGENT_DATA_DIR = tmp;

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { fakeServer, TOKEN } = require('./fixtures/attention-fake-server');

const TCLI = path.resolve(__dirname, '../scripts/tcli.js');
const TATT = path.resolve(__dirname, '../scripts/t-attention.js');
let homes = 0;

function spawnCli(cli, args, { env = {}, input = '' } = {}) {
  const home = path.join(tmp, `home-${homes += 1}`);
  fs.mkdirSync(home);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, HOME: home, TAGENT_HOME: home, T_AGENT_DATA_DIR: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const tcli = (args, options) => spawnCli(TCLI, ['attention', ...args], options);
const tatt = (args, options) => spawnCli(TATT, args, options);
const auth = fake => ({ env: { TA_ATTENTION_URL: fake.url, TA_ATTENTION_TOKEN: TOKEN } });
const lastRequest = fake => fake.requests[fake.requests.length - 1];

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('help: tcli lists the attention group; tcli attention help is t-attention help under its own name', async () => {
  const top = await spawnCli(TCLI, ['help']);
  assert.equal(top.code, 0);
  assert.match(top.stdout, /^ {2}attention {2}T-Attention tasks/m);
  const help = await tcli(['help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: tcli attention <command>/m);
  assert.match(help.stdout, /run-now <id\|ref:R>/);
  assert.match(help.stdout, /preview --at T \| --every R/);
  assert.match(help.stdout, /--script T \| --script-file F/);
  assert.doesNotMatch(help.stdout, /\bt-attention (login|--help|add)/, 'every command example uses the name typed');
  for (const line of help.stdout.split('\n')) assert.ok(line.length <= 60, `help fits a phone terminal: ${line}`);
  const alone = await tcli([]);
  assert.equal(alone.code, 1, 'tcli attention alone prints the help as a usage error, like the other groups');
  assert.match(alone.stderr, /Usage: tcli attention/);
});

test('errors name tcli attention and keep t-attention exit codes: unknown command 1, not logged in 2', async () => {
  const unknown = await tcli(['frobnicate']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^tcli attention: Unknown command: frobnicate \(tcli attention --help\)/m);
  assert.match(unknown.stderr, /Run tcli attention --help for usage\./);
  const out = await tcli(['list']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /Not logged in: run tcli attention login --url/);
  const json = await tcli(['list', '--json']);
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.stderr).exit, 2);
});

test('the task commands work through tcli exactly as through t-attention, outside a T-Agent terminal too (no TA_HOOK_URL)', async () => {
  const fake = await fakeServer();
  try {
    const added = await tcli(['add', 'Write the report', '--notes', 'by Friday', '--ref', 'job:1', '--json'], auth(fake));
    assert.equal(added.code, 0, added.stderr);
    const id = JSON.parse(added.stdout).id;
    assert.deepEqual(lastRequest(fake).body, { notes: 'by Friday', title: 'Write the report', source: 'cli', external_ref: 'job:1' });
    assert.equal(lastRequest(fake).auth, `Bearer ${TOKEN}`);
    assert.equal((await tcli(['add', 'Child', '--parent', String(id)], auth(fake))).code, 0);

    const viaTcli = await tcli(['list'], auth(fake));
    const viaTatt = await tatt(['list'], auth(fake));
    assert.equal(viaTcli.code, 0);
    assert.equal(viaTcli.stdout, viaTatt.stdout, 'the same output');
    assert.match(viaTcli.stdout, /Write the report/);
    assert.equal((await tcli(['tree'], auth(fake))).stdout, (await tatt(['tree'], auth(fake))).stdout);

    assert.match((await tcli(['show', 'ref:job:1'], auth(fake))).stdout, /^#\d+ Write the report/);
    assert.equal((await tcli(['update', String(id), '--custom-status', 'Blocked', '--note', 'Waiting for data'], auth(fake))).code, 0);
    assert.deepEqual(lastRequest(fake).body, { custom_status: 'Blocked', activity: { kind: 'note', text: 'Waiting for data' } });
    assert.equal((await tcli(['wait', String(id), '--reason', 'Pick a date'], auth(fake))).code, 0);
    assert.equal(fake.items.get(id).status, 'waiting_user');
    assert.equal((await tcli(['handled', String(id)], auth(fake))).code, 0);
    assert.equal((await tcli(['review', String(id)], auth(fake))).code, 0);
    assert.equal((await tcli(['reject', String(id), '--reason', 'Add the charts'], auth(fake))).code, 0);
    assert.equal(fake.items.get(id).status, 'working');
    assert.equal((await tcli(['review', String(id)], auth(fake))).code, 0);
    assert.equal((await tcli(['confirm', String(id)], auth(fake))).code, 0);
    assert.equal(fake.items.get(id).status, 'done');
    const wrong = await tcli(['confirm', String(id)], auth(fake));
    assert.equal(wrong.code, 1, 'confirm of a task that is not in review');
    assert.equal((await tcli(['move', String(id), '--top', '--status', 'todo'], auth(fake))).code, 0);
    assert.equal(lastRequest(fake).path, `/api/attention/${id}/move`);
    assert.equal((await tcli(['upsert', '--ref', 'job:2', '--title', 'By ref'], auth(fake))).code, 0);
    const busy = await tcli(['rm', String(id)], auth(fake));
    assert.equal(busy.code, 1, 'a task with subtasks is not deleted');
    assert.match(busy.stderr, /subtasks: #\d+/);
    const gone = await tcli(['show', '999'], auth(fake));
    assert.equal(gone.code, 3, 'not found');
    const md = path.join(tmp, 'TASKS.md');
    fs.writeFileSync(md, '# Tasks\n');
    const imported = await tcli(['import-tasks-md', md, '--dry-run'], auth(fake));
    assert.equal(imported.code, 1, 'import-tasks-md is reachable (and checks its file)');
    assert.match(imported.stderr, /^tcli attention: .* does not look like a SELF-ATTENTION TASKS\.md/m);
  } finally {
    await fake.close();
  }
});

test('run-now: POST /:id/run-now (also by ref); a busy session is 1, a script refused to a terminal token is 2', async () => {
  let answer = null;
  const fake = await fakeServer({
    handler: (req, res, { url, send }) => {
      const match = /^\/api\/attention\/(\d+)\/run-now$/.exec(url.pathname);
      if (!match || req.method !== 'POST') return false;
      if (answer) return send(answer.status, answer.body);
      return send(200, { item: { id: Number(match[1]), title: 'Daily check', status: 'todo', schedule_text: 'Every day at 09:00', next_at: '2026-11-21T01:00:00.000Z', schedule: { kind: 'repeat' } } });
    },
  });
  try {
    const item = await tcli(['add', 'Daily check', '--ref', 'daily'], auth(fake));
    assert.equal(item.code, 0);
    const ran = await tcli(['run-now', '1'], auth(fake));
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Ran #1 Daily check now \(To do\)\n {2}Every day at 09:00 · next /);
    assert.equal(lastRequest(fake).path, '/api/attention/1/run-now');
    assert.equal((await tcli(['run', 'ref:daily', '--json'], auth(fake))).code, 0, 'run is the short form, a ref is resolved');
    assert.equal(lastRequest(fake).path, '/api/attention/1/run-now');

    answer = { status: 409, body: { error: 'SESSION_BUSY', message: 'The session is busy; the prompt was not sent' } };
    const busy = await tcli(['run-now', '1'], auth(fake));
    assert.equal(busy.code, 1);
    assert.match(busy.stderr, /The session is busy/);
    answer = { status: 403, body: { error: 'SCRIPT_NEEDS_PERSON', message: 'Only the person can run or change a script' } };
    const refused = await tcli(['run-now', '1', '--json'], auth(fake));
    assert.equal(refused.code, 2);
    assert.equal(JSON.parse(refused.stderr).error, 'SCRIPT_NEEDS_PERSON');
    assert.equal((await tcli(['run-now'], auth(fake))).code, 1, 'run-now needs a task');
  } finally {
    await fake.close();
  }
});

test('preview: the rule in words and the next times; a rule the server refuses is 1; action flags are not taken', async () => {
  let bodies = [];
  const fake = await fakeServer({
    handler: (req, res, { url, body, send }) => {
      if (url.pathname !== '/api/attention/schedule/preview') return false;
      bodies.push(body);
      if (body.schedule.rule && body.schedule.rule.day === 31) return send(200, { next: [], text: '', error: 'Monthly day must be 1 to 28 in this test' });
      return send(200, { text: 'Every Monday and Thursday at 09:00', next: ['2026-11-23T01:00:00.000Z', '2026-11-26T01:00:00.000Z', '2026-11-30T01:00:00.000Z'] });
    },
  });
  try {
    const out = await tcli(['preview', '--every', 'weekly:mon,thu', '--time', '9:00', '--ends', 'after:10'], auth(fake));
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /^Every Monday and Thursday at 09:00\nNext: \d{2}-\d{2} \d{2}:\d{2}, /);
    assert.deepEqual(bodies[0], { schedule: { kind: 'repeat', rule: { freq: 'weekly', time: '09:00', days: [1, 4] }, ends: { kind: 'after', count: 10 } } });
    const json = await tcli(['preview', '--at', '2026-12-01 10:00', '--json'], auth(fake));
    assert.equal(JSON.parse(json.stdout).next.length, 3);
    assert.deepEqual(bodies[1], { schedule: { kind: 'once', at: '2026-12-01T10:00' } });
    const refused = await tcli(['preview', '--every', 'monthly:31', '--time', '09:00'], auth(fake));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Monthly day must be 1 to 28/);
    bodies = [];
    assert.equal((await tcli(['preview'], auth(fake))).code, 1, 'no rule');
    assert.equal((await tcli(['preview', '--every', 'daily', '--time', '09:00', '--prompt', 'hi'], auth(fake))).code, 1, '--prompt is an action, not a rule');
    assert.equal(bodies.length, 0, 'usage errors send nothing');
  } finally {
    await fake.close();
  }
});

test('the script action: --script or --script-file with --task and --timeout-min; --script "" on update goes back to a reminder', async () => {
  const fake = await fakeServer();
  try {
    const added = await tcli(['add', 'Nightly backup', '--every', 'daily', '--time', '02:00', '--script', 'rsync -a ~/work /backup', '--task', '#7', '--timeout-min', '45'], auth(fake));
    assert.equal(added.code, 0, added.stderr);
    assert.deepEqual(lastRequest(fake).body.then_action, { kind: 'script', task_id: '7', script: 'rsync -a ~/work /backup', timeout_min: 45 });
    const file = path.join(tmp, 'job.sh');
    fs.writeFileSync(file, 'set -e\nnpm test\n');
    assert.equal((await tcli(['update', '1', '--script-file', file, '--task', '7'], auth(fake))).code, 0);
    assert.deepEqual(lastRequest(fake).body, { then_action: { kind: 'script', task_id: '7', script: 'set -e\nnpm test\n' } });
    assert.equal((await tcli(['update', '1', '--script', ''], auth(fake))).code, 0);
    assert.deepEqual(lastRequest(fake).body, { then_action: { kind: 'remind' } });

    const sent = fake.requests.length;
    const usage = async (args, pattern) => {
      const out = await tcli(args, auth(fake));
      assert.equal(out.code, 1, args.join(' '));
      assert.match(out.stderr, pattern);
    };
    await usage(['add', 'X', '--at', '2026-12-01T10:00', '--script', 'ls'], /--script needs --task <task id>/);
    await usage(['add', 'X', '--at', '2026-12-01T10:00', '--script', 'ls', '--task', '7', '--prompt', 'hi', '--session', '7:t1'], /--prompt .* or --script .*not both/);
    await usage(['add', 'X', '--at', '2026-12-01T10:00', '--script', 'ls', '--script-file', file, '--task', '7'], /--script or --script-file, not both/);
    await usage(['add', 'X', '--at', '2026-12-01T10:00', '--script', 'ls', '--task', '7', '--timeout-min', '0'], /--timeout-min must be a number of minutes from 1 to 720/);
    await usage(['add', 'X', '--at', '2026-12-01T10:00', '--script', 'x'.repeat(4001), '--task', '7'], /at most 4000 characters/);
    await usage(['add', 'X', '--at', '2026-12-01T10:00', '--script-file', path.join(tmp, 'missing.sh'), '--task', '7'], /Cannot read --script-file/);
    await usage(['add', 'X', '--at', '2026-12-01T10:00', '--script', ''], /--script cannot be empty/);
    await usage(['update', '1', '--no-schedule', '--every', 'daily', '--time', '09:00'], /--no-schedule cannot be used/);
    assert.equal(fake.requests.length, sent, 'usage errors send nothing');
    assert.equal((await tcli(['update', '1', '--no-schedule', '--script', ''], auth(fake))).code, 0, '--no-schedule may come with an action change');
  } finally {
    await fake.close();
  }
});
