const { execFile } = require('child_process');

function redact(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/((?:token|password|_authToken|authorization)\s*[=:]\s*)[^\s]+/gi, '$1[redacted]');
}

function logUpdate(stage, message) {
  console.log(`[update] ${new Date().toISOString()} [${stage}] ${redact(message)}`);
}

function runUpdateCommand(file, args, options, { stage, errorCode, streamOutput = false }) {
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
          if (pending.trim()) logUpdate(stage, `${name}: ${pending}`);
          pending = '';
        };
        flushers.push(flush);
        stream?.setEncoding('utf8');
        stream?.on('data', chunk => {
          pending += chunk;
          const lines = pending.split(/[\r\n]+/);
          pending = lines.pop();
          for (const line of lines) if (line.trim()) logUpdate(stage, `${name}: ${line}`);
        });
      }
    }
  });
}

module.exports = { logUpdate, runUpdateCommand };
