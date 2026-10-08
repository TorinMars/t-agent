const { execFile } = require('node:child_process');

// 找出一组进程（及其全部子孙进程）正在监听的 TCP 端口。优先用 lsof，没有时用 ss。
// 任何一步失败都只返回空结果：端口检测是锦上添花，不能影响列表本身。
const isLoopback = address => /^(127\.|\[?::1\]?$|localhost$)/.test(address);

function run(exec, file, args, timeoutMs) {
  return new Promise(resolve => {
    exec(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

// `ps -A -o pid=,ppid=` → Map(pid → 子进程 pid 列表)
function parseChildren(output) {
  const children = new Map();
  for (const line of String(output || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const [pid, ppid] = [Number(match[1]), Number(match[2])];
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

function descendants(root, children, limit = 200) {
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length && seen.size < limit) {
    for (const child of children.get(queue.shift()) || []) {
      if (!seen.has(child)) { seen.add(child); queue.push(child); }
    }
  }
  return seen;
}

// lsof -Fpn：先是 "p<pid>"，随后是该进程的若干 "n<地址>:<端口>"。
function parseLsof(output) {
  const listeners = [];
  let pid = null;
  for (const line of String(output || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) {
      const match = /^n(.*):(\d+)$/.exec(line);
      if (match) listeners.push({ pid, port: Number(match[2]), local_only: isLoopback(match[1]) });
    }
  }
  return listeners;
}

// ss -ltnpH：LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=19))
function parseSs(output) {
  const listeners = [];
  for (const line of String(output || '').split('\n')) {
    const match = /^\s*LISTEN\s+\S+\s+\S+\s+(\S+):(\d+)\s+\S+\s*(.*)$/.exec(line);
    if (!match) continue;
    for (const pid of match[3].matchAll(/pid=(\d+)/g)) {
      listeners.push({ pid: Number(pid[1]), port: Number(match[2]), local_only: isLoopback(match[1]) });
    }
  }
  return listeners;
}

function createPortDetector({ exec = execFile, timeoutMs = 4000, cacheMs = 4000 } = {}) {
  let cache = { at: 0, key: '', value: null };

  // pids: PM2 进程的主 pid 列表。返回 Map(pid → [{ port, local_only }])，端口升序。
  async function detect(pids) {
    const roots = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
    const key = roots.join(',');
    if (!roots.length) return new Map();
    if (cache.value && cache.key === key && Date.now() - cache.at < cacheMs) return cache.value;

    const psOut = await run(exec, 'ps', ['-A', '-o', 'pid=,ppid='], timeoutMs);
    const children = parseChildren(psOut);
    let listeners = null;
    const lsof = await run(exec, 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], timeoutMs);
    if (lsof !== null) listeners = parseLsof(lsof);
    else {
      const ss = await run(exec, 'ss', ['-ltnpH'], timeoutMs);
      if (ss !== null) listeners = parseSs(ss);
    }

    const result = new Map();
    for (const root of roots) {
      const tree = descendants(root, children);
      const ports = new Map();
      for (const listener of (listeners || []).filter(item => tree.has(item.pid))) {
        // 同一端口既有对外监听又有回环监听时，按“可对外访问”处理。
        const known = ports.get(listener.port);
        ports.set(listener.port, { port: listener.port, local_only: known ? known.local_only && listener.local_only : listener.local_only });
      }
      result.set(root, [...ports.values()].sort((a, b) => a.port - b.port));
    }
    cache = { at: Date.now(), key, value: result };
    return result;
  }
  return { detect };
}

module.exports = { createPortDetector, parseLsof, parseSs, parseChildren, descendants, isLoopback };
