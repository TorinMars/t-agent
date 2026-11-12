// `t-attention import-tasks-md` (lib/attention-import.js): a synthetic SELF-ATTENTION TASKS.md, parsed, planned and imported through the CLI
// into the real service (test/fixtures/attention-real-server.js). Chinese text is written with \u escapes: one title proves non-ASCII content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const importer = require('../lib/attention-import');
const { realServer } = require('./fixtures/attention-real-server');

const CLI = path.resolve(__dirname, '../scripts/t-attention.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-attention-import-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DASH = '\u2014';
const DOT = '\u00b7';
const ARROW = '\u2192';
const CONFIRM = '\u8bf7\u786e\u8ba4\u662f\u5426\u5b8c\u6210'; // the automatic confirm prompt of SELF-ATTENTION
const WEEKLY = '\u5199\u5468\u62a5'; // a Chinese task name ("write the weekly report")
const HEADER = '| ID | Task | Status | Updated | Notes | Attention | Custom Status | Result | Parent |\n|----|------|--------|---------|-------|-----------|---------------|--------|--------|';

const TASKS_MD = `# Tasks

Statuses: \`Not Started\` ${DOT} \`In Progress\` ${DOT} \`Awaiting Response\` ${DOT} \`Completed ${DASH} Awaiting Confirmation\` ${DOT} \`Completed ${DASH} Confirmed\`

## Needs Your Attention

${HEADER}
| T5 | Review the parser | Completed ${DASH} Awaiting Confirmation | 2026-11-11 21:27 |  | ${CONFIRM} |  | Parser done | T1 |
| T6 | Choose a date | In Progress | 2026-11-11 20:00 | Team offsite | Please choose a date |  |  |  |
| T10 | Check the numbers | Completed ${DASH} Awaiting Confirmation | 2026-11-11 22:00 |  | Look at row 3 first |  |  |  |

## Open

${HEADER}
| T1 | Main session | In Progress | 2026-11-10 11:16 | Pipes \\| inside the notes |  |  |  |  |
| T2 | ${WEEKLY} | Not Started | 2026-11-10 12:54 |  |  |  |  | t1 |
| T3 | Wait for the vendor | Awaiting Response | 2026-11-10 13:00 |  |  |  |  |
| T4 | Short row | Not Started | 2026-11-09 10:00 |
| T7 | Blocked thing | Awaiting Response | 2026-11-10 14:00 |  |  | Blocked | Waiting on legal | T99 |
| T11 | Grandchild | Not Started | 2026-11-10 15:00 |  |  |  |  | T2 |
| T12 |  | Not Started | 2026-11-10 15:00 |  |  |  |  |  |

## Completed ${DASH} Confirmed

${HEADER}
| T8 | Shipped | Completed ${DASH} Confirmed | 2026-11-09 17:00 |  |  |  | Released v1 | T1 |

## Status history

<!-- One line per change: YYYY-MM-DD HH:MM ${DOT} ID ${DOT} old status ${ARROW} new status ${DOT} reason -->
- 2026-11-09 16:24 ${DOT} T1 ${DOT} created ${ARROW} In Progress
- 2026-11-09 16:30 ${DOT} T2 ${DOT} created ${ARROW} Not Started
- 2026-11-09 16:32 ${DOT} T1 ${DOT} info (In Progress) ${DOT} Data collected
- 2026-11-09 17:00 ${DOT} T8 ${DOT} In Progress ${ARROW} Completed ${DASH} Confirmed ${DOT} user confirmed
- 2026-11-09 17:25 ${DOT} T99 ${DOT} deleted ${DOT} a test
- 2026-11-09 17:26 ${DOT} t2 ${DOT} notes: (none) ${ARROW} Draft ready
`;

function writeTasks(text = TASKS_MD) {
  const file = path.join(tmp, `TASKS-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, text);
  return file;
}

function run(args, env = {}) {
  return new Promise(resolve => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('parse: tables, escaped pipes, missing trailing columns, header names and the status history', () => {
  const parsed = importer.parseTasksMd(TASKS_MD);
  assert.deepEqual(parsed.rows.map(row => row.id), ['T5', 'T6', 'T10', 'T1', 'T2', 'T3', 'T4', 'T7', 'T11', 'T12', 'T8']);
  const t1 = parsed.rows.find(row => row.id === 'T1');
  assert.equal(t1.notes, 'Pipes | inside the notes');
  assert.equal(t1.section, 'Open');
  const t4 = parsed.rows.find(row => row.id === 'T4');
  assert.deepEqual([t4.task, t4.notes, t4.attention, t4.parent], ['Short row', '', '', ''], 'missing trailing columns are empty');
  assert.equal(parsed.rows.find(row => row.id === 'T2').task, WEEKLY);
  assert.equal(parsed.hasHistory, true);
  assert.deepEqual(parsed.history.get('T1'), [{ at: '2026-11-09 16:24', text: `created ${ARROW} In Progress` }, { at: '2026-11-09 16:32', text: `info (In Progress) ${DOT} Data collected` }]);
  assert.equal(parsed.history.get('T2').length, 2, 'IDs are matched without regard to case');
  assert.deepEqual(importer.splitRow('| a | b \\| c |  |'), ['a', 'b | c', ''], 'an empty last cell');
  assert.deepEqual(importer.splitRow('| a | b'), ['a', 'b'], 'no trailing pipe');
  // Columns are taken from the header row, in any order.
  const swapped = importer.parseTasksMd('| ID | Status | Task |\n|--|--|--|\n| T1 | In Progress | Swapped |\n');
  assert.deepEqual([swapped.rows[0].task, swapped.rows[0].status], ['Swapped', 'In Progress']);
  assert.equal(swapped.hasHistory, false);
  const twice = importer.parseTasksMd(`${HEADER}\n| T1 | One | Not Started |\n| t1 | Again | Not Started |\n`);
  assert.equal(twice.rows.length, 1);
  assert.match(twice.warnings[0], /T1 appears twice/i);
});

test('plan: status mapping, the confirm prompt, attention, awaiting response, parents and history notes', () => {
  const plan = importer.planImport(importer.parseTasksMd(TASKS_MD));
  const by = Object.fromEntries(plan.entries.map(entry => [entry.id, entry]));
  assert.deepEqual(Object.fromEntries(plan.entries.map(entry => [entry.id, entry.fields.status])), {
    T5: 'review', T6: 'waiting_user', T10: 'waiting_user', T1: 'working', T2: 'todo', T3: 'working', T4: 'todo', T7: 'working', T11: 'todo', T8: 'done',
  });
  assert.equal(by.T5.fields.attention_reason, null, 'the confirm prompt on a review row is dropped');
  assert.equal(by.T6.fields.attention_reason, 'Please choose a date');
  assert.equal(by.T10.fields.attention_reason, 'Look at row 3 first', 'any other attention text makes it waiting_user, even in review');
  assert.equal(by.T3.fields.custom_status, 'Awaiting Response');
  assert.equal(by.T7.fields.custom_status, 'Blocked', 'a custom status is kept');
  assert.equal(by.T8.fields.result, 'Released v1');
  assert.equal(by.T5.ref, 'self-attention:T5');
  assert.equal(by.T5.fields.source, 'self-attention');
  assert.deepEqual([by.T2.parent, by.T2.parentRef], ['T1', 'self-attention:T1'], 'parents match without regard to case');
  assert.equal(by.T7.parent, null);
  assert.ok(plan.warnings.some(text => /T7: parent T99 is not in the file/.test(text)));
  assert.deepEqual(plan.skipped, [{ id: 'T12', reason: 'no task name' }]);
  assert.deepEqual(by.T1.history, [`History 2026-11-09 16:24: created ${ARROW} In Progress`, `History 2026-11-09 16:32: info (In Progress) ${DOT} Data collected`]);
  assert.deepEqual(by.T1.meta, { self_attention_id: 'T1', imported_updated: '2026-11-10 11:16' });
  assert.equal(importer.planImport(importer.parseTasksMd(TASKS_MD), { source: 'k01' }).entries[0].ref, 'k01:T5');

  // Long values are cut to the server's limits; history is capped per task (the newest kept).
  const many = Array.from({ length: importer.HISTORY_CAP + 5 }, (_, i) => `- 2026-11-09 10:${String(i % 60).padStart(2, '0')} ${DOT} T1 ${DOT} line ${i}`).join('\n');
  const long = importer.planImport(importer.parseTasksMd(`${HEADER}\n| T1 | ${'x'.repeat(400)} | Not Started | | | | ${'c'.repeat(150)} | ${'r'.repeat(600)} | |\n## Status history\n${many}\n`));
  assert.equal(long.entries[0].fields.title.length, 300);
  assert.equal(long.entries[0].fields.custom_status.length, 100);
  assert.equal(long.entries[0].fields.result.length, 500);
  assert.equal(long.entries[0].history.length, importer.HISTORY_CAP);
  assert.match(long.entries[0].history.at(-1), /line 54$/);
  assert.ok(long.warnings.some(text => /only the newest 50 of its 55 history lines/.test(text)));
});

test('import: two passes for parents, file order kept per group, history once, idempotent re-run', async () => {
  const server = await realServer();
  const env = { TA_ATTENTION_URL: server.url, TA_ATTENTION_TOKEN: server.token };
  const { service } = server;
  try {
    const before = service.create({ title: 'Existing item' });
    const file = writeTasks();
    const first = await run(['import-tasks-md', file], env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^Imported .*: 10 created, 0 updated, 1 skipped, 5 history notes/);
    assert.match(first.stdout, /T12: no task name/);
    assert.match(first.stdout, /T7: parent T99 is not in the file/);

    const item = ref => service.getByRef(`self-attention:${ref}`);
    assert.equal(item('T2').title, WEEKLY);
    assert.equal(item('T2').parent_id, item('T1').id);
    assert.equal(item('T11').parent_id, item('T2').id, 'a child whose parent comes later in the file');
    assert.equal(item('T5').parent_id, item('T1').id, 'a parent in another table');
    assert.equal(item('T8').parent_id, item('T1').id);
    assert.equal(item('T7').parent_id, null);
    assert.deepEqual([item('T5').status, item('T5').attention_reason, item('T5').result], ['review', null, 'Parser done']);
    assert.deepEqual([item('T6').status, item('T6').attention_reason, item('T6').notes], ['waiting_user', 'Please choose a date', 'Team offsite']);
    assert.deepEqual([item('T3').status, item('T3').custom_status], ['working', 'Awaiting Response']);
    assert.equal(item('T8').status, 'done');
    assert.ok(item('T8').completed_at);
    assert.equal(item('T1').notes, 'Pipes | inside the notes');
    assert.equal(item('T1').source, 'self-attention');
    assert.deepEqual(item('T1').meta, { self_attention_id: 'T1', imported_updated: '2026-11-10 11:16', history_imported: true });

    // The file's order inside each group, above the items that were already there.
    assert.deepEqual(service.list({ status: 'todo' }).map(entry => entry.title), [WEEKLY, 'Short row', 'Grandchild', 'Existing item']);
    assert.deepEqual(service.list({ status: 'working' }).map(entry => entry.title), ['Main session', 'Wait for the vendor', 'Blocked thing']);
    assert.deepEqual(service.list({ status: 'waiting_user' }).map(entry => entry.title), ['Choose a date', 'Check the numbers']);
    assert.ok(service.get(before.id).sort_order < item('T4').sort_order);

    const notes = ref => service.events(item(ref).id).filter(event => event.type === 'activity').map(event => event.data.text).reverse();
    assert.deepEqual(notes('T1'), [`History 2026-11-09 16:24: created ${ARROW} In Progress`, `History 2026-11-09 16:32: info (In Progress) ${DOT} Data collected`]);
    assert.deepEqual(notes('T2'), [`History 2026-11-09 16:30: created ${ARROW} Not Started`, `History 2026-11-09 17:26: notes: (none) ${ARROW} Draft ready`]);
    assert.equal(service.events(item('T1').id).find(event => event.type === 'activity').data.kind, 'note');
    assert.equal(service.events(item('T1').id)[0].actor, 'self-attention');

    // A second run updates (no duplicates, no second copy of the history) and keeps a changed order.
    service.move(item('T4').id, { position: 'top' });
    const changed = writeTasks(TASKS_MD.replace('| T6 | Choose a date | In Progress | 2026-11-11 20:00 | Team offsite |', '| T6 | Choose a venue | In Progress | 2026-11-12 09:00 | Team offsite |'));
    const second = await run(['import-tasks-md', changed, '--json'], env);
    assert.equal(second.code, 0, second.stderr);
    const summary = JSON.parse(second.stdout);
    assert.deepEqual([summary.created, summary.updated, summary.notes, summary.skipped.length], [0, 10, 0, 1]);
    assert.equal(service.list({ includeDone: true }).length, 11, 'ten imported plus the existing item');
    assert.equal(item('T6').title, 'Choose a venue');
    assert.equal(item('T6').meta.imported_updated, '2026-11-12 09:00');
    assert.equal(item('T6').meta.history_imported, true);
    assert.equal(notes('T1').length, 2, 'history notes only once');
    assert.equal(service.list({ status: 'todo' })[0].title, 'Short row', 'a re-run keeps the order the person chose');
    assert.equal(summary.rows.find(row => row.id === 'T2').parent_id, item('T1').id);
  } finally {
    await server.close();
  }
});

test('import --dry-run sends nothing and prints the plan; a file that is not a task list is refused', async () => {
  const server = await realServer();
  const env = { TA_ATTENTION_URL: server.url, TA_ATTENTION_TOKEN: server.token };
  try {
    const dry = await run(['import-tasks-md', writeTasks(), '--dry-run', '--source', 'k01'], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^Dry run, nothing was sent: 10 tasks from /);
    assert.match(dry.stdout, /T2 -> k01:T2 \(todo, under T1, 2 history\)/);
    assert.equal(server.requests.length, 0, 'not a single request');
    const json = JSON.parse((await run(['import-tasks-md', writeTasks(), '--dry-run', '--json'], env)).stdout);
    assert.equal(json.dry_run, true);
    assert.equal(json.rows.length, 10);
    assert.equal(server.requests.length, 0);
    // Even without any server config a dry run works.
    assert.equal((await run(['import-tasks-md', writeTasks(), '--dry-run'])).code, 0);

    assert.equal((await run(['import-tasks-md', writeTasks('just some text\n')], env)).code, 1);
    assert.equal((await run(['import-tasks-md', path.join(tmp, 'missing.md')], env)).code, 1);
    assert.equal((await run(['import-tasks-md'], env)).code, 1);
    assert.equal((await run(['import-tasks-md', writeTasks(), '--source', 'bad source'], env)).code, 1);
    const noLogin = await run(['import-tasks-md', writeTasks()]);
    assert.equal(noLogin.code, 2, 'a real import needs the server config');
  } finally {
    await server.close();
  }
});

test('runImport waits out 429 answers and stops on an auth error', async () => {
  const calls = [];
  let refusals = 2;
  const api = {
    list: async () => [],
    upsertByRef: async (ref, body) => {
      calls.push({ ref, body });
      if (refusals > 0) { refusals -= 1; const error = new Error('Too many requests'); error.status = 429; error.retryAfter = 1; throw error; }
      return { created: true, item: { id: calls.length, status: body.status || 'todo', title: body.title || 'x', parent_id: null } };
    },
  };
  const waits = [];
  const plan = importer.planImport(importer.parseTasksMd(`${HEADER}\n| T1 | One | Not Started |\n`));
  const summary = await importer.runImport(api, plan, { wait: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(summary.created, 1);
  const auth = { list: async () => { const error = new Error('The attention token is missing, wrong or revoked'); error.kind = 'auth'; error.status = 401; throw error; } };
  await assert.rejects(importer.runImport(auth, plan), /revoked/);
});
