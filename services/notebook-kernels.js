// Shell notebooks ("The kernel" in docs/design/shell-notebook.md): one long-lived shell (the "kernel") per notebook row of a task, which runs the
// notebook's code cells one at a time, in order, so `cd`, variables and functions carry over from cell to cell. The shell is a node-pty
// pseudo-terminal started the way a terminal's shell is (routes/terminal.js terminalLaunch: the same environment, user and tokens). Each cell runs as
// one typed line that sources a temporary file holding the cell's source between two invisible markers (OSC 6973); everything outside a start / end
// pair (the echo of the line, prompts) is dropped, everything inside goes through the output normaliser of lib/notebook-format.js.
//
// The notebook itself (its cells, outputs and revision) is held here while it is used and saved to its .ipynb file (debounced, atomically). Pages
// follow a notebook through subscribe() (Server-Sent Events in routes/notebooks.js); every change is sent to every subscriber.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const format = require('../lib/notebook-format');
const { baseName } = require('../lib/terminal-activity');

const MARK = '\x1b]6973;';
const MAX_OPS = 200;
const MAX_OPS_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_INPUT = 64 * 1024;
const COLS = 120;
const ROWS = 40;
// The programs that take the whole screen switch to the alternate screen: xterm's 1049 (and the older 47 / 1047).
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)h/;
const TERMINAL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const TIMING = {
  readyMs: 30000,        // the shell has this long to answer the ready marker
  interruptMs: 1500,     // after Ctrl+C: no end marker within this and the shell owns the terminal again -> stopped, exit 130
  stopPollMs: 300,
  killMs: 2000,          // SIGHUP, then SIGKILL after this
  fullscreenTermMs: 1000, // a full-screen program that ignores Ctrl+C gets SIGTERM (then SIGKILL) after this
  saveRunningMs: 2000,   // outputs of a running cell are saved at most this often
  saveIdleMs: 300,       // cell changes are saved this long after the last one
  flushMs: 80,           // output events of a running cell at most this often
  fullFlushMs: 1000,     // an output event that replaces every line (lines were cut from the front) at most this often
  quietMs: 800,          // no output for this long: the cell may wait for input
  inputPollMs: 300,
  evictMs: 10 * 60 * 1000, // a notebook nobody follows and no kernel runs is dropped from memory after this
};

// The variables of the terminal program the server itself was started from (Apple's Terminal makes zsh save sessions at every exit, even of a
// subshell) do not belong to a notebook's shell.
const FOREIGN_TERMINAL_ENV = ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'WT_SESSION'];
function kernelEnv(env) {
  const out = { ...env };
  for (const key of FOREIGN_TERMINAL_ENV) delete out[key];
  return out;
}

const fail = (code, statusCode) => Object.assign(new Error(code), { statusCode });
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const hex = bytes => crypto.randomBytes(bytes).toString('hex');

function createNotebookKernels({
  db = require('../db'),
  terminal = () => require('../routes/terminal'),
  spawn = (...args) => require('node-pty').spawn(...args),
  reaper = () => require('./terminal-reaper'),
  now = Date.now,
  notifyActivity = () => {},
  timing = {},
  log = message => console.warn(`[notebook] ${message}`),
} = {}) {
  const T = { ...TIMING, ...timing };
  const notebooks = new Map(); // "<task id>:<terminal id>" -> notebook

  const rowOf = (taskId, id) => db.prepare('SELECT terminal_id, title, agent, agent_session_id, work_dir FROM task_terminals WHERE task_id = ? AND terminal_id = ?').get(taskId, id);
  const taskOf = taskId => db.prepare('SELECT id, work_dir, md_path, archived_at FROM tasks WHERE id = ?').get(taskId);

  // The owner of files written for a root service that drops its shells to another user (TERMINAL_USER), so the person can edit them.
  function fileOwner() {
    if (!process.getuid || process.getuid() !== 0) return null;
    try {
      const user = require('../lib/terminal-user').resolveTerminalUser().user;
      return user ? { uid: user.uid, gid: user.gid } : null;
    } catch { return null; }
  }
  function defaultShellName() {
    try { return baseName(terminal().terminalShell()); } catch { return 'sh'; }
  }

  // ── Notebooks in memory ──
  function loadFromDisk(nb) {
    if (fs.existsSync(nb.file)) {
      const { notebook, stamp } = format.readNotebookFile(nb.file);
      Object.assign(nb, { metadata: notebook.metadata, extra: notebook.extra, cells: notebook.cells, stamp });
    } else {
      const notebook = format.emptyNotebook();
      Object.assign(nb, { metadata: notebook.metadata, extra: notebook.extra, cells: notebook.cells, stamp: null });
    }
    if (!nb.kernel) nb.counter = nb.cells.reduce((max, cell) => (cell.type === 'code' && Number.isInteger(cell.count) && cell.count > max ? cell.count : max), 0);
  }

  const busy = nb => Boolean(nb.kernel && (nb.kernel.run || nb.kernel.queue.length));

  // The file changed on disk since our last read or write (another editor, git) and nothing runs or waits to be saved: read it again.
  function refresh(nb) {
    if (busy(nb) || nb.saveTimer) return;
    const stamp = format.fileStamp(nb.file);
    if (!stamp || stamp === nb.stamp) return;
    try {
      loadFromDisk(nb);
    } catch (error) {
      log(`could not read ${nb.file} again: ${error.message}`);
      nb.stamp = stamp;
      return;
    }
    nb.revision += 1;
    broadcast(nb, { type: 'snapshot', notebook: doc(nb) });
  }

  function open(task, id) {
    if (!task || typeof id !== 'string' || !TERMINAL_ID.test(id)) throw fail('NOTEBOOK_NOT_FOUND', 404);
    const row = rowOf(task.id, id);
    if (!row || row.agent !== 'notebook' || !row.agent_session_id) throw fail('NOTEBOOK_NOT_FOUND', 404);
    const key = `${Number(task.id)}:${id}`;
    let nb = notebooks.get(key);
    if (!nb) {
      const folder = format.notebookFolder(task, row);
      const { file, relative } = format.resolveNotebookPath(folder, row.agent_session_id, { mustExist: false });
      nb = {
        key, taskId: Number(task.id), terminalId: id, folder, file, rel: relative, title: row.title, revision: 1, counter: 0,
        cells: [], metadata: {}, extra: {}, stamp: null, kernel: null, subscribers: new Set(), saveTimer: null, savedAt: 0, evictTimer: null,
      };
      loadFromDisk(nb);
      notebooks.set(key, nb);
    } else {
      refresh(nb);
    }
    nb.title = row.title;
    scheduleEvict(nb);
    return nb;
  }

  function scheduleEvict(nb) {
    clearTimeout(nb.evictTimer);
    nb.evictTimer = setTimeout(() => {
      nb.evictTimer = null;
      if (notebooks.get(nb.key) !== nb) return;
      if (nb.subscribers.size || nb.kernel || nb.saveTimer) { scheduleEvict(nb); return; }
      notebooks.delete(nb.key);
    }, T.evictMs);
    nb.evictTimer.unref?.();
  }

  const isLive = (nb, cell) => cell.type === 'code' && nb.cells.includes(cell);

  function kernelView(nb) {
    const k = nb.kernel;
    return {
      state: k ? k.state : 'stopped',
      shell: k && k.shellName ? k.shellName : defaultShellName(),
      running: k && k.run ? k.run.cell.id : null,
      queue: k ? k.queue.map(cell => cell.id) : [],
      waiting_input: Boolean(k && k.waitingInput),
      counter: nb.counter,
    };
  }

  function apiCell(cell) {
    if (cell.type !== 'code') return { id: cell.id, type: 'markdown', source: cell.source };
    return {
      id: cell.id, type: 'code', source: cell.source, count: cell.count, state: cell.state, exit: cell.exit, duration_ms: cell.duration_ms,
      started_at: cell.started_at, ended_at: cell.ended_at, lines: cell.lines, dropped: cell.dropped, ...(cell.program ? { program: cell.program } : {}),
    };
  }

  function doc(nb) {
    return { id: nb.terminalId, task_id: nb.taskId, title: nb.title, path: nb.rel, folder: nb.folder, revision: nb.revision, kernel: kernelView(nb), cells: nb.cells.map(apiCell) };
  }

  function broadcast(nb, event) {
    if (!nb.subscribers.size) return;
    const text = JSON.stringify(event);
    for (const sub of [...nb.subscribers]) {
      try { sub.write(text); } catch { nb.subscribers.delete(sub); }
    }
  }
  const sendKernel = nb => broadcast(nb, { type: 'kernel', kernel: kernelView(nb) });
  const sendCell = (nb, cell, patch) => { if (isLive(nb, cell)) broadcast(nb, { type: 'cell', id: cell.id, patch }); };
  const sendOutput = (nb, cell, from, lines) => { if (isLive(nb, cell)) broadcast(nb, { type: 'output', id: cell.id, from, lines, dropped: cell.dropped }); };

  // ── Saving ──
  function save(nb) {
    clearTimeout(nb.saveTimer);
    nb.saveTimer = null;
    const run = nb.kernel && nb.kernel.run;
    if (run) { run.cell.lines = run.out.view(); run.cell.dropped = run.out.dropped; }
    try {
      format.writeFileAtomic(nb.file, format.serializeNotebook(nb), { owner: fileOwner() });
      nb.stamp = format.fileStamp(nb.file);
      nb.savedAt = now();
    } catch (error) {
      log(`could not save ${nb.file}: ${error.message}`);
    }
  }
  function scheduleSave(nb) {
    if (nb.saveTimer) return;
    const running = Boolean(nb.kernel && nb.kernel.run);
    const delay = running ? Math.max(T.saveIdleMs, T.saveRunningMs - (now() - nb.savedAt)) : T.saveIdleMs;
    nb.saveTimer = setTimeout(() => { nb.saveTimer = null; save(nb); }, delay);
  }

  // ── The kernel ──
  function shellForeground(k) {
    try { return baseName(k.pty.process) === k.shellName; } catch { return false; }
  }

  // The first line: no history file, empty prompts, no pager, and in bash a prompt marker before the person's PROMPT_COMMAND (which still runs), so a line that
  // bash cut short (Ctrl+C) is known to have ended before anything the prompt prints; then the ready marker.
  function setupLine(k) {
    const parts = ['unset HISTFILE', "PS1=''", "PS2=''"];
    if (k.shellName === 'zsh') parts.push("PROMPT=''", "RPROMPT=''", "RPS1=''", "PROMPT_EOL_MARK=''");
    if (k.shellName === 'bash') parts.push('__ta_nb_pc=$PROMPT_COMMAND', `PROMPT_COMMAND='\\printf "\\033]6973;prompt;%s\\007" ${k.nonce}; eval "$__ta_nb_pc"'`);
    // A pager cannot work in a cell (less takes the full screen and would be stopped): `git log`, `man` and the like print straight through.
    parts.push('export PAGER=cat GIT_PAGER=cat MANPAGER=cat');
    parts.push(`\\printf '\\033]6973;ready;%s\\007' ${k.nonce}`);
    // Ctrl+U first: whatever was typed on the line before is dropped. The leading space keeps the line out of the history.
    return `\x15 ${parts.join('; ')}\r`;
  }

  function startKernel(nb, queue = []) {
    const k = {
      state: 'starting', queue: [], run: null, pty: null, shellName: defaultShellName(), nonce: hex(8), buf: '', tmpDir: null,
      waitingInput: false, exited: false, readyTimer: null, runAs: null,
    };
    nb.kernel = k;
    nb.counter = 0;
    for (const cell of queue) { k.queue.push(cell); cell.state = 'queued'; sendCell(nb, cell, { state: 'queued' }); }
    sendKernel(nb);
    try {
      const launch = terminal().terminalLaunch(nb.taskId, nb.terminalId, nb.folder, {});
      k.shellName = baseName(launch.shell);
      k.runAs = launch.runAs || null;
      k.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-notebook-'));
      fs.chmodSync(k.tmpDir, 0o700);
      if (k.runAs && process.getuid && process.getuid() === 0) fs.chownSync(k.tmpDir, k.runAs.uid, k.runAs.gid);
      k.pty = spawn(launch.shell, k.shellName === 'sh' ? [] : ['-l'], {
        name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: launch.cwd,
        ...(k.runAs ? { uid: k.runAs.uid, gid: k.runAs.gid } : {}),
        env: kernelEnv(launch.env),
      });
    } catch (error) {
      startFailed(nb, k, String(error.message || error));
      return k;
    }
    k.pty.onData(data => onData(nb, k, data));
    k.pty.onExit(event => onExit(nb, k, event || {}));
    k.readyTimer = setTimeout(() => startFailed(nb, k, `it gave no sign of being ready within ${Math.round(T.readyMs / 1000)} s`), T.readyMs);
    k.pty.write(setupLine(k));
    return k;
  }

  function removeTmp(k) {
    if (k.tmpDir) { try { fs.rmSync(k.tmpDir, { recursive: true, force: true }); } catch { /* gone */ } }
  }

  // Ends the shell: its foreground jobs get SIGTERM (services/terminal-reaper.js), the shell SIGHUP, and SIGKILL after killMs when it still runs.
  function kill(k) {
    if (!k.pty) return;
    const pty = k.pty;
    const hup = () => { try { pty.kill('SIGHUP'); } catch { /* ended */ } };
    try { reaper().reap([pty.pid], { graceMs: T.killMs, signalled: hup }); } catch { hup(); }
    const timer = setTimeout(() => {
      if (k.exited) return;
      try { process.kill(pty.pid, 'SIGKILL'); } catch { /* ended */ }
    }, T.killMs);
    timer.unref?.();
  }

  function endToken(nb) {
    try { terminal().endAttentionToken(nb.taskId, nb.terminalId); } catch { /* the terminal module is gone */ }
  }

  function clearQueue(nb, k) {
    const left = k.queue;
    k.queue = [];
    for (const cell of left) {
      if (cell.state !== 'queued') continue;
      cell.state = 'idle';
      sendCell(nb, cell, { state: 'idle' });
    }
  }

  // The shell could not start (spawn error, no ready marker, ended at once): the first queued cell shows why and fails; the others wait again.
  function startFailed(nb, k, reason) {
    if (nb.kernel !== k) return;
    clearTimeout(k.readyTimer);
    const [first, ...rest] = k.queue;
    k.queue = rest;
    k.state = 'stopped';
    nb.kernel = null;
    clearQueue(nb, k);
    if (first && isLive(nb, first)) {
      const at = now();
      delete first.rawOutputs;
      Object.assign(first, { state: 'failed', exit: null, started_at: at, ended_at: at, duration_ms: 0, lines: [`The shell did not start: ${reason}`], dropped: 0 });
      sendOutput(nb, first, 0, first.lines);
      sendCell(nb, first, { state: 'failed', exit: null, started_at: at, ended_at: at, duration_ms: 0 });
    }
    log(`the shell of notebook ${nb.terminalId} (task ${nb.taskId}) did not start: ${reason}`);
    kill(k);
    endToken(nb);
    removeTmp(k);
    sendKernel(nb);
    save(nb);
  }

  function onData(nb, k, data) {
    if (nb.kernel !== k) return;
    k.buf += data;
    for (;;) {
      const at = k.buf.indexOf(MARK);
      if (at < 0) {
        // Keep what may be the beginning of a marker for the next chunk.
        const esc = k.buf.lastIndexOf('\x1b');
        const keep = esc >= 0 && k.buf.length - esc < MARK.length && MARK.startsWith(k.buf.slice(esc)) ? k.buf.length - esc : 0;
        const text = k.buf.slice(0, k.buf.length - keep);
        k.buf = k.buf.slice(k.buf.length - keep);
        if (text) feed(nb, k, text);
        return;
      }
      if (at > 0) feed(nb, k, k.buf.slice(0, at));
      const bel = k.buf.indexOf('\x07', at);
      if (bel < 0) {
        k.buf = k.buf.slice(at);
        if (k.buf.length > 4096) { feed(nb, k, k.buf.slice(0, MARK.length)); k.buf = k.buf.slice(MARK.length); continue; }
        return;
      }
      const fields = k.buf.slice(at + MARK.length, bel).split(';');
      k.buf = k.buf.slice(bel + 1);
      marker(nb, k, fields);
      if (nb.kernel !== k) return;
    }
  }

  function marker(nb, k, [kind, id, exit]) {
    if (kind === 'ready' && id === k.nonce && k.state === 'starting') {
      clearTimeout(k.readyTimer);
      k.state = 'idle';
      sendKernel(nb);
      next(nb);
    } else if (kind === 'start' && k.run && id === k.run.runId) {
      k.run.started = true;
    } else if (kind === 'end' && k.run && id === k.run.runId) {
      const code = Number.parseInt(exit, 10);
      finishRun(nb, k, Number.isInteger(code) ? code : 1, 'end');
    } else if (kind === 'prompt' && id === k.nonce && k.run && k.run.started) {
      // bash shows its prompt while the cell's line runs: the line was cut short (Ctrl+C); what the prompt prints is not the cell's.
      finishRun(nb, k, 130, 'end');
    }
  }

  // Output of the shell outside the markers (the typed line, prompts) is dropped; inside, it is the running cell's output.
  function feed(nb, k, text) {
    const run = k.run;
    if (!run || !run.started || run.fullscreen) return;
    const scan = run.tail + text;
    const found = ALT_SCREEN.exec(scan);
    if (found) {
      const before = found.index - run.tail.length;
      if (before > 0) run.out.write(text.slice(0, before));
      enterFullscreen(nb, k, run);
      scheduleFlush(nb, run);
      return;
    }
    run.tail = scan.slice(-12);
    run.out.write(text);
    run.lastOutputAt = now();
    scheduleFlush(nb, run);
  }

  // A program switched to the alternate screen (vim, htop, less): a cell cannot show it. It gets Ctrl+C at once, SIGTERM to its process group
  // after fullscreenTermMs (vim and less ignore Ctrl+C), SIGKILL killMs later; the cell ends as 'fullscreen'.
  function enterFullscreen(nb, k, run) {
    run.fullscreen = true;
    let program = '';
    try { program = baseName(k.pty.process); } catch { program = ''; }
    run.cell.program = program && program !== k.shellName ? program : 'The program';
    try { k.pty.write('\x03'); } catch { /* ended */ }
    run.fullscreenTimer = setTimeout(() => {
      if (k.run !== run) return;
      try { reaper().reap([k.pty.pid], { graceMs: T.killMs }); } catch { /* the reaper is gone */ }
    }, T.fullscreenTermMs);
    watchStop(nb, k, run);
  }

  // After Ctrl+C the shell may drop the rest of the typed line (bash and zsh do when the job died of SIGINT), and the end marker never comes:
  // once the shell owns the terminal again, the cell has ended.
  function watchStop(nb, k, run) {
    if (run.stopTimer) return;
    const check = () => {
      run.stopTimer = null;
      if (k.run !== run) return;
      if (shellForeground(k)) finishRun(nb, k, 130, 'end');
      else run.stopTimer = setTimeout(check, T.stopPollMs);
    };
    run.stopTimer = setTimeout(check, T.interruptMs);
  }

  function scheduleFlush(nb, run) {
    if (run.flushTimer) return;
    run.flushTimer = setTimeout(() => flush(nb, run), T.flushMs);
  }
  function flush(nb, run) {
    run.flushTimer = null;
    if (!nb.kernel || nb.kernel.run !== run) return;
    if (run.out.cutSinceTake && now() - run.lastFull < T.fullFlushMs) {
      run.flushTimer = setTimeout(() => flush(nb, run), T.fullFlushMs - (now() - run.lastFull));
      return;
    }
    const cut = run.out.cutSinceTake;
    const change = run.out.takeChange();
    if (!change) return;
    if (cut) run.lastFull = now();
    run.cell.lines = run.out.view();
    run.cell.dropped = run.out.dropped;
    sendOutput(nb, run.cell, change.from, change.lines);
    scheduleSave(nb);
  }

  // Whether the running cell seems to wait for input: no output for quietMs, and either the shell itself owns the terminal (a `read`) or the
  // output stops in the middle of a line (a prompt such as "Continue? [y/N] ").
  function checkWaiting(nb, k, run) {
    if (k.run !== run) return;
    const waiting = run.started && !run.fullscreen && now() - run.lastOutputAt >= T.quietMs && (run.out.partial || shellForeground(k));
    if (waiting === k.waitingInput) return;
    k.waitingInput = waiting;
    sendKernel(nb);
  }

  function next(nb) {
    const k = nb.kernel;
    if (!k || k.state !== 'idle' || k.run) return;
    while (k.queue.length) {
      const cell = k.queue.shift();
      if (!isLive(nb, cell)) continue;
      startRun(nb, k, cell);
      return;
    }
  }

  function startRun(nb, k, cell) {
    const runId = hex(8);
    const file = path.join(k.tmpDir, `${runId}.sh`);
    const at = now();
    nb.counter += 1;
    delete cell.rawOutputs;
    delete cell.program;
    Object.assign(cell, { state: 'running', count: nb.counter, exit: null, duration_ms: null, started_at: at, ended_at: null, lines: [], dropped: 0 });
    const run = {
      runId, cell, file, out: format.createOutput(), startedAt: at, started: false, tail: '', interrupted: false, fullscreen: false,
      lastOutputAt: at, lastFull: 0, flushTimer: null, stopTimer: null, fullscreenTimer: null,
    };
    k.run = run;
    k.state = 'busy';
    k.waitingInput = false;
    sendCell(nb, cell, { state: 'running', count: cell.count, exit: null, duration_ms: null, started_at: at, ended_at: null });
    sendOutput(nb, cell, 0, []);
    sendKernel(nb);
    notifyActivity();
    try {
      fs.writeFileSync(file, cell.source.endsWith('\n') ? cell.source : `${cell.source}\n`, { mode: 0o600 });
      if (k.runAs && process.getuid && process.getuid() === 0) fs.chownSync(file, k.runAs.uid, k.runAs.gid);
    } catch (error) {
      run.out.write(`The cell could not be written to a temporary file: ${error.message}\n`);
      finishRun(nb, k, 1, 'end');
      return;
    }
    run.inputTimer = setInterval(() => checkWaiting(nb, k, run), T.inputPollMs);
    run.inputTimer.unref?.();
    // `\printf`: an alias of the person's never replaces it.
    const start = `\\printf '\\033]6973;start;%s\\007' ${runId}`;
    const end = `\\printf '\\033]6973;end;%s;%s\\007' ${runId} "$?"`;
    // zsh runs an `always` block also when Ctrl+C ends the cell, so its end marker always comes (and the interrupt is reset there).
    const line = k.shellName === 'zsh' ? `{ ${start}; . ${quote(file)}; } always { ${end}; TRY_BLOCK_INTERRUPT=0; }` : `${start}; . ${quote(file)}; ${end}`;
    k.pty.write(`\x15 ${line}\r`);
  }

  // The running cell ended. how: 'end' (its end marker, the shell back after Ctrl+C, or the shell exited with `exit`), or 'interrupted' (the
  // shell was restarted or stopped under it).
  function finishRun(nb, k, exit, how) {
    const run = k.run;
    if (!run) return;
    k.run = null;
    clearTimeout(run.flushTimer);
    clearTimeout(run.stopTimer);
    clearTimeout(run.fullscreenTimer);
    clearInterval(run.inputTimer);
    run.out.finish();
    const cell = run.cell;
    const ended = now();
    let state;
    if (how === 'interrupted') state = 'interrupted';
    else if (run.fullscreen) state = 'fullscreen';
    else if (run.interrupted) { state = 'stopped'; if (exit === 0) exit = 130; } // a cell cut by Ctrl+C did not succeed
    else state = exit === 0 ? 'done' : 'failed';
    const change = run.out.takeChange();
    cell.lines = run.out.view();
    cell.dropped = run.out.dropped;
    if (change) sendOutput(nb, cell, change.from, change.lines);
    Object.assign(cell, { state, exit: how === 'interrupted' ? null : exit, duration_ms: ended - run.startedAt, ended_at: ended });
    sendCell(nb, cell, { state, exit: cell.exit, duration_ms: cell.duration_ms, ended_at: ended });
    try { fs.rmSync(run.file, { force: true }); } catch { /* gone */ }
    k.waitingInput = false;
    if (state !== 'done') clearQueue(nb, k);
    if (k.state === 'busy') k.state = 'idle';
    notifyActivity();
    save(nb);
    sendKernel(nb);
    next(nb);
  }

  function onExit(nb, k, { exitCode }) {
    k.exited = true;
    clearTimeout(k.readyTimer);
    if (nb.kernel !== k) return; // ended by restart / stop / shutdown
    if (k.state === 'starting') { startFailed(nb, k, `the shell ended at once (exit code ${exitCode})`); return; }
    if (k.buf) { feed(nb, k, k.buf); k.buf = ''; }
    k.state = 'stopped';
    clearQueue(nb, k);
    if (k.run) finishRun(nb, k, Number.isInteger(exitCode) ? exitCode : 1, 'end');
    nb.kernel = null;
    endToken(nb);
    removeTmp(k);
    sendKernel(nb);
    notifyActivity();
  }

  // Ends the notebook's shell (restart, stop, a deleted row, a closed task): the running cell becomes 'interrupted', the queued ones wait again.
  function endKernel(nb) {
    const k = nb.kernel;
    if (!k) return;
    clearTimeout(k.readyTimer);
    k.state = 'stopped';
    clearQueue(nb, k);
    if (k.run) finishRun(nb, k, null, 'interrupted');
    nb.kernel = null;
    kill(k);
    endToken(nb);
    removeTmp(k);
    sendKernel(nb);
    notifyActivity();
  }

  // ── Operations ──
  function assertActive(task) {
    const row = taskOf(task.id);
    if (row && row.archived_at) throw fail('TASK_ARCHIVED', 409);
    let moving = false;
    try { moving = require('./task-move').isMoving(task.id); } catch { moving = false; }
    if (moving) throw fail('TASK_MOVING', 409);
  }

  const badOps = () => fail('INVALID_NOTEBOOK_OPS', 400);
  const validIndex = value => Number.isSafeInteger(value);
  const validSource = value => typeof value === 'string' && Buffer.byteLength(value) <= MAX_SOURCE_BYTES;
  const validType = value => value === 'code' || value === 'markdown';
  function validateOps(ops) {
    if (!Array.isArray(ops) || ops.length > MAX_OPS) throw badOps();
    let size = 0;
    try { size = Buffer.byteLength(JSON.stringify(ops)); } catch { throw badOps(); }
    if (size > MAX_OPS_BYTES) throw badOps();
    for (const op of ops) {
      if (!op || typeof op !== 'object') throw badOps();
      if (op.op === 'insert') {
        const cell = op.cell;
        if (!validIndex(op.index) || !cell || typeof cell !== 'object' || !validType(cell.type) || !validSource(cell.source ?? '')) throw badOps();
        if (cell.id !== undefined && cell.id !== null && (typeof cell.id !== 'string' || !format.CELL_ID.test(cell.id))) throw badOps();
      } else if (op.op === 'set') {
        if (typeof op.id !== 'string' || !validSource(op.source)) throw badOps();
      } else if (op.op === 'type') {
        if (typeof op.id !== 'string' || !validType(op.type)) throw badOps();
      } else if (op.op === 'delete') {
        if (typeof op.id !== 'string') throw badOps();
      } else if (op.op === 'move') {
        if (typeof op.id !== 'string' || !validIndex(op.index)) throw badOps();
      } else throw badOps();
    }
  }

  const clamp = (value, max) => Math.max(0, Math.min(max, value));
  function unqueue(nb, cell) {
    const k = nb.kernel;
    if (!k || !k.queue.includes(cell)) return false;
    k.queue = k.queue.filter(item => item !== cell);
    return true;
  }

  function applyOps(task, id, body = {}) {
    const ops = body && body.ops;
    validateOps(ops);
    const nb = open(task, id);
    const client = typeof body.client === 'string' ? body.client.slice(0, 128) : null;
    const applied = [];
    let queueChanged = false;
    const find = cellId => nb.cells.findIndex(cell => cell.id === cellId);
    for (const op of ops) {
      if (op.op === 'insert') {
        let cellId = op.cell.id || null;
        if (cellId && find(cellId) >= 0) continue; // sent again: it is there already
        while (!cellId || find(cellId) >= 0) cellId = format.newCellId();
        const source = op.cell.source ?? '';
        const cell = op.cell.type === 'code' ? format.newCodeCell(source, cellId) : format.newMarkdownCell(source, cellId);
        const index = clamp(op.index, nb.cells.length);
        nb.cells.splice(index, 0, cell);
        applied.push({ op: 'insert', index, cell: { id: cellId, type: cell.type, source } });
        continue;
      }
      const at = find(op.id);
      if (at < 0) continue;
      const cell = nb.cells[at];
      if (op.op === 'set') {
        cell.source = op.source;
        applied.push({ op: 'set', id: op.id, source: op.source });
      } else if (op.op === 'type') {
        if (cell.type === op.type) continue;
        if (unqueue(nb, cell)) queueChanged = true;
        const next = op.type === 'code' ? format.newCodeCell(cell.source, cell.id) : format.newMarkdownCell(cell.source, cell.id);
        next.metadata = cell.metadata;
        next.keep = { ...cell.keep };
        if (op.type === 'markdown') { delete next.keep.outputs; delete next.keep.execution_count; }
        nb.cells[at] = next;
        applied.push({ op: 'type', id: op.id, type: op.type });
      } else if (op.op === 'delete') {
        if (unqueue(nb, cell)) queueChanged = true;
        nb.cells.splice(at, 1);
        applied.push({ op: 'delete', id: op.id });
      } else if (op.op === 'move') {
        nb.cells.splice(at, 1);
        const index = clamp(op.index, nb.cells.length);
        nb.cells.splice(index, 0, cell);
        applied.push({ op: 'move', id: op.id, index });
      }
    }
    if (applied.length) {
      nb.revision += applied.length;
      broadcast(nb, { type: 'ops', revision: nb.revision, ops: applied, by: client });
      scheduleSave(nb);
    }
    if (queueChanged) sendKernel(nb);
    return { revision: nb.revision };
  }

  function run(task, id, body = {}) {
    const ids = body && body.ids;
    if (!Array.isArray(ids) || ids.length > 10000 || !ids.every(item => typeof item === 'string')) throw fail('INVALID_NOTEBOOK_OPS', 400);
    assertActive(task);
    const nb = open(task, id);
    const k = nb.kernel;
    const wanted = [];
    let known = 0;
    for (const cellId of ids) {
      const cell = nb.cells.find(item => item.id === cellId);
      if (!cell) continue;
      known += 1;
      if (cell.type !== 'code' || wanted.includes(cell)) continue;
      if (k && (k.queue.includes(cell) || (k.run && k.run.cell === cell))) continue;
      wanted.push(cell);
    }
    if (ids.length && !known) throw fail('CELL_NOT_FOUND', 404);
    if (!wanted.length) return { kernel: kernelView(nb) };
    if (!k) {
      startKernel(nb, wanted);
      return { kernel: kernelView(nb) };
    }
    for (const cell of wanted) { k.queue.push(cell); cell.state = 'queued'; sendCell(nb, cell, { state: 'queued' }); }
    sendKernel(nb);
    next(nb);
    return { kernel: kernelView(nb) };
  }

  function interrupt(task, id) {
    const nb = open(task, id);
    const k = nb.kernel;
    if (k) {
      clearQueue(nb, k);
      const current = k.run;
      if (current && !current.interrupted) {
        current.interrupted = true;
        try { k.pty.write('\x03'); } catch { /* ended */ }
        // bash only stops the command that got Ctrl+C and goes on with the rest of a sourced file; SIGINT to bash itself ends the whole line.
        if (k.shellName === 'bash') { try { process.kill(k.pty.pid, 'SIGINT'); } catch { /* ended */ } }
        watchStop(nb, k, current);
      }
      sendKernel(nb);
    }
    return { kernel: kernelView(nb) };
  }

  function restart(task, id) {
    assertActive(task);
    const nb = open(task, id);
    endKernel(nb);
    startKernel(nb);
    return { kernel: kernelView(nb) };
  }

  function stop(task, id) {
    const nb = open(task, id);
    endKernel(nb);
    return { kernel: kernelView(nb) };
  }

  function input(task, id, body = {}) {
    const text = body && body.text;
    if (typeof text !== 'string' || text.length > MAX_INPUT) throw fail('INVALID_NOTEBOOK_INPUT', 400);
    const nb = open(task, id);
    const k = nb.kernel;
    if (!k || !k.run) throw fail('NO_RUNNING_CELL', 409);
    k.pty.write(`${text.replace(/\r\n?|\n/g, '\r')}\r`);
    k.run.lastOutputAt = now();
    if (k.waitingInput) { k.waitingInput = false; sendKernel(nb); }
    return { ok: true };
  }

  function clear(task, id, body = {}) {
    const ids = body && Array.isArray(body.ids) ? new Set(body.ids.filter(item => typeof item === 'string')) : null;
    const nb = open(task, id);
    const running = nb.kernel && nb.kernel.run ? nb.kernel.run.cell : null;
    for (const cell of nb.cells) {
      if (cell.type !== 'code' || (ids && !ids.has(cell.id)) || cell === running) continue;
      delete cell.rawOutputs;
      delete cell.program;
      cell.lines = [];
      cell.dropped = 0;
      const patch = cell.state === 'queued' ? {} : { state: 'idle', exit: null, duration_ms: null, started_at: null, ended_at: null };
      Object.assign(cell, patch);
      sendOutput(nb, cell, 0, []);
      if (Object.keys(patch).length) sendCell(nb, cell, patch);
    }
    scheduleSave(nb);
    return { revision: nb.revision };
  }

  // Follows a notebook: `write(json)` gets every event as JSON text, the snapshot first; `end()` is called when the notebook goes away (its row was
  // deleted). Answers the function that stops following.
  function subscribe(task, id, write, end = () => {}) {
    const nb = open(task, id);
    const sub = { write, end };
    write(JSON.stringify({ type: 'snapshot', notebook: doc(nb) }));
    nb.subscribers.add(sub);
    return () => { nb.subscribers.delete(sub); scheduleEvict(nb); };
  }

  // ── Calls from the terminal module (routes/terminal.js) ──
  const find = (taskId, id) => notebooks.get(`${Number(taskId)}:${id}`) || null;
  function loaded(taskId, id) {
    const known = find(taskId, id);
    if (known) return known;
    const task = taskOf(Number(taskId));
    return task ? open(task, id) : null;
  }

  return {
    get: (task, id) => doc(open(task, id)),
    applyOps, run, interrupt, restart, stop, input, clear, subscribe,

    // The row's restart control ("Restart in the working directory"): a new shell, also when none ran. An archived or moving task gets none.
    restartKernel(taskId, id) {
      const nb = loaded(taskId, id);
      if (!nb) return false;
      endKernel(nb);
      try { assertActive({ id: nb.taskId }); } catch { return false; }
      startKernel(nb);
      return true;
    },
    // The row's close control: the shell ends, the notebook stays.
    stopKernel(taskId, id) {
      const nb = find(taskId, id);
      if (nb) endKernel(nb);
    },
    // The row was deleted: the shell ends, pending changes are saved, followers are told, and the notebook leaves memory. The file stays.
    forget(taskId, id) {
      const nb = find(taskId, id);
      if (!nb) return;
      endKernel(nb);
      if (nb.saveTimer) save(nb);
      clearTimeout(nb.evictTimer);
      notebooks.delete(nb.key);
      for (const sub of [...nb.subscribers]) { try { sub.end(); } catch { /* closed */ } }
      nb.subscribers.clear();
    },
    // The task was closed (archived, moved, deleted, its repository cleaned up): every notebook shell of it ends.
    closeTask(taskId) {
      for (const nb of [...notebooks.values()]) {
        if (nb.taskId !== Number(taskId)) continue;
        endKernel(nb);
        if (nb.saveTimer) save(nb);
      }
    },
    // Server exit (synchronous): running cells become 'interrupted' and are saved, the shells and their foreground jobs end.
    shutdown() {
      const ptys = [];
      for (const nb of notebooks.values()) {
        const k = nb.kernel;
        if (k) {
          clearTimeout(k.readyTimer);
          k.state = 'stopped';
          clearQueue(nb, k);
          if (k.run) finishRun(nb, k, null, 'interrupted');
          nb.kernel = null;
          if (k.pty) ptys.push(k.pty);
          removeTmp(k);
        }
        if (nb.saveTimer) save(nb);
        clearTimeout(nb.evictTimer);
      }
      if (!ptys.length) return;
      try { reaper().reapSync(ptys.map(pty => pty.pid)); } catch { /* best effort */ }
      for (const pty of ptys) { try { pty.kill('SIGHUP'); } catch { /* ended */ } }
    },
    // Activity for the terminal feeds: { [task id]: { [terminal id]: 'running' } } for the wanted tasks (a Set of numbers) whose notebook runs a cell.
    activity(wanted) {
      const result = {};
      for (const nb of notebooks.values()) {
        if (!nb.kernel || !nb.kernel.run || (wanted && !wanted.has(nb.taskId))) continue;
        (result[nb.taskId] ||= {})[nb.terminalId] = 'running';
      }
      return result;
    },
    // The notebooks that run a cell: [{ task_id, terminal_id, since }].
    running() {
      const out = [];
      for (const nb of notebooks.values()) if (nb.kernel && nb.kernel.run) out.push({ task_id: nb.taskId, terminal_id: nb.terminalId, since: nb.kernel.run.startedAt });
      return out;
    },
    // What every live kernel is doing, in the shape of lib/update-idle.js (a running cell blocks an automatic update; an idle shell does not).
    idleTerminals() {
      const out = [];
      for (const nb of notebooks.values()) {
        const k = nb.kernel;
        if (!k || !k.pty) continue;
        out.push({ state: k.run ? 'running' : 'idle', subagents: 0, awaiting: false, foreground: [k.shellName], shell: k.shellName, agent: null, resumable: false });
      }
      return out;
    },
    // The terminal ids of a task whose notebook shell runs.
    liveIds(taskId) {
      const out = [];
      for (const nb of notebooks.values()) if (nb.taskId === Number(taskId) && nb.kernel && nb.kernel.pty) out.push(nb.terminalId);
      return out;
    },
    isLive: (taskId, id) => Boolean(find(taskId, id) && find(taskId, id).kernel),
    size: () => notebooks.size,
  };
}

// The one instance of the server; it tells routes/terminal.js about itself, so the terminal feeds include running cells.
let shared = null;
function getNotebookKernels() {
  if (!shared) {
    const terminal = require('../routes/terminal');
    shared = createNotebookKernels({ notifyActivity: () => terminal.notifyActivity() });
    terminal.setNotebookKernels(shared);
  }
  return shared;
}

module.exports = { createNotebookKernels, getNotebookKernels, TIMING };
