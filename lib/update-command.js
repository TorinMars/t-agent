const { execFile } = require('child_process');

function redact(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/((?:token|password|_authToken|authorization)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]');
}

function logUpdate(stage, message) {
  console.log(`[update] ${new Date().toISOString()} [${stage}] ${redact(message)}`);
}

function runUpdateCommand(file, args, options, { stage, errorCode, streamOutput = false, onOutput } = {}) {
  const started = Date.now();
  logUpdate(stage, `开始：${file} ${args.join(' ')}`);
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
        logUpdate(stage, `失败，耗时 ${elapsed}ms：${wrapped.details}`);
        reject(wrapped);
      } else {
        logUpdate(stage, `完成，耗时 ${elapsed}ms`);
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
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

// 界面上显示的进度文字：已用时间 + 最近一行输出；长时间没有输出时明确提示，避免看起来像卡死。
const QUIET_WARNING_MS = 30_000;
function formatProgress(label, elapsedMs, lastLine, quietMs) {
  let text = `${label} · 已用 ${formatDuration(elapsedMs)}`;
  if (lastLine) text += ` · ${String(lastLine).slice(0, 100)}`;
  if (quietMs >= QUIET_WARNING_MS) text += `（已 ${formatDuration(quietMs)}无输出，可能是网络不通或在编译）`;
  else if (!lastLine) text += ' · 等待输出';
  return text;
}

// 长时间运行的子命令：定时把进度交给 report，同时在命令结束（成功或失败）后停止计时。
// run(onOutput) 返回命令的 Promise，并在每行输出时调用 onOutput(line)。
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

module.exports = { logUpdate, runUpdateCommand, runWithProgress, formatProgress };
