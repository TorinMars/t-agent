// The kernel of Shell notebooks (services/notebook-kernels.js) with real pseudo-terminals and real shells (/bin/bash, and /bin/zsh when it is there):
// state that carries over between cells, exit codes, the queue of Run all, Stop, input, restart, full-screen programs, saving into the .ipynb, the
// terminal environment (hook token) and the activity feed. A temporary data folder and HOME whose shell start files print text and set a fancy
// prompt, which must never reach a cell's output.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-notebook-kernel-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.HOME = path.join(root, 'home');
process.env.ZDOTDIR = process.env.HOME;
process.env.BASH_SILENCE_DEPRECATION_WARNING = '0';
process.env.TERM_PROGRAM = 'Apple_Terminal';
fs.mkdirSync(process.env.HOME, { recursive: true });
const noisy = 'echo "NOISE FROM START FILE"; printf "\\033]0;title\\007"';
fs.writeFileSync(path.join(process.env.HOME, '.zshrc'), `${noisy}\nPROMPT='%F{magenta}fancy %~ %#%f '\nRPROMPT='[%T]'\nprecmd() { print -n "\\033]2;precmd\\007"; echo PRECMD-NOISE; }\n`);
fs.writeFileSync(path.join(process.env.HOME, '.zprofile'), 'echo ZPROFILE-NOISE\n');
fs.writeFileSync(path.join(process.env.HOME, '.bash_profile'), `${noisy}\nPS1='\\[\\e[35m\\]fancy \\w \\$\\[\\e[0m\\] '\nPROMPT_COMMAND='echo PROMPT-COMMAND-NOISE'\n`);
fs.writeFileSync(path.join(process.env.HOME, '.bashrc'), '');
for (const name of ['TA_HOOK_URL', 'TA_HOOK_TOKEN', 'TA_ATTENTION_URL', 'TA_ATTENTION_TOKEN', 'TA_SESSION_NAME', 'TA_PEER_URL', 'TA_TCLI']) delete process.env[name];

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const terminal = require('../routes/terminal');
const format = require('../lib/notebook-format');
const { createNotebookKernels } = require('../services/notebook-kernels');

terminal.setHookEndpoint('http://127.0.0.1:9/hooks/terminal-activity');
const work = path.join(root, 'work');
fs.mkdirSync(path.join(work, 'sub dir'), { recursive: true });
const taskId = Number(db.prepare("INSERT INTO tasks (title, work_dir, user_id) VALUES ('Notebooks', ?, 'owner')").run(work).lastInsertRowid);
const task = { id: taskId, work_dir: work, md_path: null };
const managers = [];

test.after(() => {
  for (const manager of managers) manager.shutdown();
  terminal.shutdownTerminals();
  db.close();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a shell that is still ending */ }
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const shells = ['/bin/bash', '/bin/zsh'].filter(shell => fs.existsSync(shell));

for (const shell of shells) {
  const name = path.basename(shell);
  // A manager whose shells are this one; everything else (environment, user, tokens) comes from the terminal module as in the server.
  const manager = createNotebookKernels({
    terminal: () => ({ ...terminal, terminalShell: () => shell, terminalLaunch: (...args) => ({ ...terminal.terminalLaunch(...args), shell }) }),
    notifyActivity: () => terminal.notifyActivity(),
  });
  managers.push(manager);
  const made = terminal.createTerminal(taskId, { agent: 'notebook', title: `${name} book` });
  const id = made.terminal_id;
  const events = [];
  manager.subscribe(task, id, text => events.push(JSON.parse(text)));
  const doc = () => manager.get(task, id);
  const cell = cellId => doc().cells.find(item => item.id === cellId);
  let n = 0;
  const add = (source, cellId = `${name.slice(0, 2)}${String(++n).padStart(6, '0')}`) => {
    manager.applyOps(task, id, { client: 'test', ops: [{ op: 'insert', index: doc().cells.length, cell: { id: cellId, type: 'code', source } }] });
    return cellId;
  };
  const ended = cellId => waitFor(() => { const c = cell(cellId); return c && !['queued', 'running'].includes(c.state) && c; }, `cell ${cellId} to end`);
  const runCells = async (...ids) => { manager.run(task, id, { ids, client: 'test' }); return Promise.all(ids.map(ended)); };

  test(`${name}: state carries over between cells (cd, export, functions, arrays), and start files never reach the output`, async () => {
    const first = add('cd "sub dir"\nexport GREETING=hello\ngreet() { echo "$GREETING, $1"; }\nlist=(one two three)\necho first');
    const second = add('pwd\ngreet notebook\necho "${#list[@]} items"\nprintf "\\033[32mgreen\\033[0m\\n"');
    const [a, b] = await runCells(first, second);
    assert.deepEqual([a.state, a.exit, a.count, a.lines], ['done', 0, 1, ['first']]);
    assert.equal(b.state, 'done');
    assert.equal(fs.realpathSync(b.lines[0]), fs.realpathSync(path.join(work, 'sub dir')));
    assert.deepEqual(b.lines.slice(1), ['hello, notebook', '3 items', '\x1b[32mgreen\x1b[0m']);
    assert.equal(doc().kernel.shell, name);
    assert.equal(doc().kernel.state, 'idle');
    assert.ok(b.duration_ms >= 0 && b.started_at && b.ended_at >= b.started_at);
  });

  test(`${name}: exit codes; a failed cell clears the rest of the queue (Run all)`, async () => {
    const ok = add('true');
    const bad = add('echo before; (exit 7)');
    const after = add('echo never');
    manager.run(task, id, { ids: [ok, bad, after] });
    assert.deepEqual(doc().kernel.queue.length >= 2, true, 'queued in order');
    await ended(bad);
    const left = await waitFor(() => cell(after).state === 'idle' && cell(after), 'the cell after the failure to be idle');
    assert.deepEqual([cell(ok).state, cell(ok).exit], ['done', 0]);
    assert.deepEqual([cell(bad).state, cell(bad).exit, cell(bad).lines], ['failed', 7, ['before']]);
    assert.deepEqual([left.count, left.lines], [null, []]);
    assert.deepEqual(doc().kernel.queue, []);
  });

  test(`${name}: Stop interrupts sleep 30 quickly (stopped, 130), and the shell goes on`, async () => {
    const long = add('echo going; sleep 30; echo never');
    manager.run(task, id, { ids: [long] });
    await waitFor(() => cell(long).state === 'running' && cell(long).lines.includes('going'), 'the sleep to run');
    terminal.setNotebookKernels(manager);
    assert.equal(terminal.activitySnapshot([taskId])[taskId][id], 'running', 'a running cell is a running terminal in the feeds');
    assert.ok(terminal.liveTerminalIds(taskId).includes(id));
    assert.equal(terminal.liveTerminalActivity().find(item => item.terminal_id === id).agent, 'notebook');
    terminal.setNotebookKernels(null);
    const started = Date.now();
    manager.interrupt(task, id);
    const done = await ended(long);
    assert.ok(Date.now() - started < 5000, 'within a few seconds');
    assert.deepEqual([done.state, done.exit], ['stopped', 130]);
    assert.ok(!done.lines.includes('never'));
    const next = add('echo still here');
    const [again] = await runCells(next);
    assert.deepEqual([again.state, again.lines], ['done', ['still here']]);
  });

  test(`${name}: a cell that reads input waits for it, and POST input answers`, async () => {
    const asking = add('printf "Name? "; read answer; echo "got $answer"');
    manager.run(task, id, { ids: [asking] });
    await waitFor(() => doc().kernel.waiting_input, 'the kernel to wait for input');
    assert.throws(() => manager.input(task, id, { text: 42 }), error => error.message === 'INVALID_NOTEBOOK_INPUT');
    assert.deepEqual(manager.input(task, id, { text: 'Ada' }), { ok: true });
    const done = await ended(asking);
    assert.equal(done.state, 'done');
    assert.equal(done.lines[done.lines.length - 1], 'got Ada');
    assert.throws(() => manager.input(task, id, { text: 'late' }), error => error.message === 'NO_RUNNING_CELL' && error.statusCode === 409);
  });

  test(`${name}: restart interrupts the running cell and gives a fresh shell`, async () => {
    const set = add('MARK=set-before');
    await runCells(set);
    const long = add('sleep 30');
    manager.run(task, id, { ids: [long] });
    await waitFor(() => cell(long).state === 'running', 'the sleep to run');
    const answer = manager.restart(task, id);
    assert.equal(answer.kernel.state, 'starting');
    assert.equal(cell(long).state, 'interrupted');
    assert.equal(cell(long).exit, null);
    await waitFor(() => doc().kernel.state === 'idle', 'the new shell');
    const check = add('echo "[$MARK]"');
    const [fresh] = await runCells(check);
    assert.deepEqual(fresh.lines, ['[]'], 'nothing carried over from the old shell');
    assert.equal(fresh.count, 1, 'counts start again in a new shell');
    manager.stop(task, id);
    assert.equal(doc().kernel.state, 'stopped');
  });

  test(`${name}: a full-screen program is stopped at once`, async () => {
    const screen = add("printf 'before\\n'; printf '\\033[?1049h'; printf 'drawn on the alternate screen'; sleep 30");
    const started = Date.now();
    const [done] = await runCells(screen);
    assert.equal(done.state, 'fullscreen');
    assert.ok(Date.now() - started < 8000);
    assert.deepEqual(done.lines, ['before'], 'what the program drew is not kept');
    assert.ok(typeof done.program === 'string' && done.program);
  });

  test(`${name}: outputs are saved into the .ipynb, and the shell has the terminal's hook token`, async () => {
    const env = add('echo "$TA_HOOK_TOKEN"; echo "$TA_HOOK_URL"; echo "$TERM"; echo "pager=$PAGER/$GIT_PAGER"; echo "term=${TERM_PROGRAM:-none}"');
    const [done] = await runCells(env);
    const [token, url, term, pager, program] = done.lines;
    assert.equal(pager, 'pager=cat/cat', 'no pager takes the screen');
    assert.equal(program, 'term=none', 'the terminal program the server runs in is not passed on');
    assert.equal(terminal.verifyHookToken(taskId, id, token), true, 'tcli and the relays accept this terminal id');
    assert.match(url, new RegExp(`terminal=${id}`));
    assert.equal(term, 'xterm-256color');
    const file = path.join(work, made.notebook);
    await waitFor(() => {
      const saved = format.parseNotebook(fs.readFileSync(file, 'utf8')).cells.find(item => item.id === env);
      return saved && saved.state === 'done' && saved.lines[0] === token;
    }, 'the output in the file');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = written.cells.find(item => item.id === env);
    assert.deepEqual(raw.outputs[0].name, 'stdout');
    assert.equal(raw.metadata['t-agent'].exit, 0);
    assert.equal(written.metadata.kernelspec.name, 'bash');
    for (const item of written.cells.filter(c => c.cell_type === 'code')) {
      const text = item.outputs.map(output => [].concat(output.text || []).join('')).join('');
      assert.doesNotMatch(text, /NOISE|fancy|PRECMD|PROMPT-COMMAND/, 'nothing of the start files or the prompt');
    }
    const kinds = new Set(events.map(event => event.type));
    for (const kind of ['snapshot', 'ops', 'cell', 'output', 'kernel']) assert.ok(kinds.has(kind), kind);
    assert.equal(events[0].type, 'snapshot');
  });

  test(`${name}: a cell that ends the shell (exit 3) fails and the kernel stops`, async () => {
    const leave = add('exit 3');
    const [done] = await runCells(leave);
    assert.deepEqual([done.state, done.exit], ['failed', 3]);
    await waitFor(() => doc().kernel.state === 'stopped', 'the kernel to stop');
    manager.stop(task, id);
  });
}

test('a shell that cannot start fails the first queued cell with the reason, and the rest wait again', async () => {
  const manager = createNotebookKernels({
    terminal: () => ({ ...terminal, terminalLaunch: () => { throw new Error('No usable shell found'); } }),
  });
  managers.push(manager);
  const made = terminal.createTerminal(taskId, { agent: 'notebook', title: 'broken' });
  const nb = manager.get(task, made.terminal_id);
  manager.applyOps(task, made.terminal_id, { ops: [{ op: 'insert', index: 1, cell: { id: 'second01', type: 'code', source: 'echo 2' } }] });
  manager.run(task, made.terminal_id, { ids: [nb.cells[0].id, 'second01'] });
  const after = manager.get(task, made.terminal_id);
  assert.deepEqual([after.cells[0].state, after.cells[0].lines], ['failed', ['The shell did not start: No usable shell found']]);
  assert.equal(after.cells[1].state, 'idle');
  assert.equal(after.kernel.state, 'stopped');
});
