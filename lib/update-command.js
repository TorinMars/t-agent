const { execFile } = require('child_process');

function redact(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/((?:token|password|_authToken|authorization)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]');
}

// Recent update log lines; the UI uses them to scroll the update progress like a terminal. Only the latest lines are kept in memory.
const MAX_LOG_LINES = 300;
const MAX_LOG_LINE = 400;
let recent = [];
function recentLog() { return recent.map(entry => ({ ...entry })); }
function clearLog() { recent = []; }

function logUpdate(stage, message) {
  const text = redact(message);
  const at = new Date().toISOString();
  console.log(`[update] ${at} [${stage}] ${text}`);
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    recent.push({ at, stage, text: line.slice(0, MAX_LOG_LINE) });
  }
  if (recent.length > MAX_LOG_LINES) recent = recent.slice(-MAX_LOG_LINES);
}

function runUpdateCommand(file, args, options, { stage, errorCode, streamOutput = false, onOutput } = {}) {
  const started = Date.now();
  logUpdate(stage, `Started: ${file} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const flushers = [];
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      flushers.forEach(flush => flush());
      const elapsed = Date.now() - started;
      if (error) {
        const wrapped = new Error(errorCode);
        wrapped.details = redact([
          `code=${error.code ?? 'unknown'} signal=${error.signal || 'none'} killed=${Boolean(error.killed)}`,
          error.message, stderr, stdout,
        ].filter(Boolean).join('\n')).slice(-2000);
        logUpdate(stage, `Failed after ${elapsed}ms: ${wrapped.details}`);
        reject(wrapped);
      } else {
        logUpdate(stage, `Finished in ${elapsed}ms`);
        resolve(String(stdout).trim());
      }
    });
    if (streamOutput) {
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
        let pending = '';
        const flush = () => {
          if (pending.trim()) {
            logUpdate(stage, `${name}: ${pending}`);
            if (onOutput) onOutput(redact(pending.trim()));
          }
          pending = '';
        };
        flushers.push(flush);
        stream?.setEncoding('utf8');
        stream?.on('data', chunk => {
          pending += chunk;
          const lines = pending.split(/[\r\n]+/);
          pending = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            logUpdate(stage, `${name}: ${line}`);
            if (onOutput) onOutput(redact(line.trim()));
          }
        });
      }
    }
  });
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)} min ${seconds % 60}s`;
}

// Progress text shown in the UI: elapsed time + the latest output line; when there is no output for a long time it says so, so it does not look hung.
const QUIET_WARNING_MS = 30_000;
function formatProgress(label, elapsedMs, lastLine, quietMs) {
  let text = `${label} · elapsed ${formatDuration(elapsedMs)}`;
  if (lastLine) text += ` · ${String(lastLine).slice(0, 100)}`;
  if (quietMs >= QUIET_WARNING_MS) text += ` (no output for ${formatDuration(quietMs)}; the network may be down or it may be compiling)`;
  else if (!lastLine) text += ' · waiting for output';
  return text;
}

// Long-running child command: periodically hand progress to report, and stop the timer once the command ends (success or failure).
// run(onOutput) returns the command's Promise and calls onOutput(line) for every output line.
function runWithProgress(label, run, report, { intervalMs = 2000 } = {}) {
  const started = Date.now();
  let lastLine = '';
  let lastOutputAt = started;
  const tick = () => report(formatProgress(label, Date.now() - started, lastLine, Date.now() - lastOutputAt));
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return Promise.resolve(run(line => { lastLine = line; lastOutputAt = Date.now(); })).finally(() => clearInterval(timer));
}

module.exports = { recentLog, clearLog, logUpdate, runUpdateCommand, runWithProgress, formatProgress };
