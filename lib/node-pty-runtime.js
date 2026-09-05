const fs = require('fs');
const path = require('path');

function resolveNodePtyRoot(projectRoot) {
  const entry = require.resolve('node-pty', { paths: [projectRoot] });
  return path.resolve(path.dirname(entry), '..');
}

function findSpawnHelpers(root) {
  const helpers = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === 'spawn-helper') helpers.push(target);
    }
  };
  visit(root);
  return helpers;
}

function repairSpawnHelperPermissions(projectRoot, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') return [];
  const nodePtyRoot = options.nodePtyRoot || resolveNodePtyRoot(projectRoot);
  const repaired = [];
  for (const helper of findSpawnHelpers(nodePtyRoot)) {
    const stat = fs.statSync(helper);
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(helper, stat.mode | 0o755);
      repaired.push(helper);
    }
  }
  return repaired;
}

function verifyNodePty(projectRoot) {
  repairSpawnHelperPermissions(projectRoot);
  const nodePty = require(require.resolve('node-pty', { paths: [projectRoot] }));
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/c', 'exit', '0'] : ['-c', 'exit 0'];
  return new Promise((resolve, reject) => {
    let terminal;
    try {
      terminal = nodePty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 20,
        rows: 5,
        cwd: projectRoot,
        env: process.env,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      try { terminal.kill(); } catch {}
      reject(new Error('NODE_PTY_VERIFY_TIMEOUT'));
    }, 5000);
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(new Error(`NODE_PTY_VERIFY_EXIT_${exitCode}`));
    });
  });
}

module.exports = {
  findSpawnHelpers,
  repairSpawnHelperPermissions,
  resolveNodePtyRoot,
  verifyNodePty,
};
