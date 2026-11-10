// Finds out whether a process manager will start the service again after `process.exit(75)`. With none, that exit ends the service for good.
// The environment alone is not proof: a server started by hand in a T-Agent terminal inherits pm_id or INVOCATION_ID from the service that runs that terminal,
// and every macOS process has XPC_SERVICE_NAME (a Terminal window gives `application.com.apple.Terminal...` or `0`). So each check also looks at how this process was started.
const fs = require('fs');

function pm2Supervised({ env, hasIpc }) {
  // PM2 copies the fields of its process record into the environment of a process it starts, and always opens an IPC channel to it.
  return env.pm_id !== undefined && hasIpc && env.autorestart !== 'false';
}

function systemdSupervised({ env, ppid, platform, readFile }) {
  if (platform !== 'linux' || !env.INVOCATION_ID) return false;
  try { return readFile(`/proc/${ppid}/comm`, 'utf8').trim() === 'systemd'; }
  catch { return false; }
}

function launchdSupervised({ env, ppid, platform }) {
  const name = env.XPC_SERVICE_NAME;
  // A launchd job has its Label here and launchd (pid 1) as its parent.
  return platform === 'darwin' && ppid === 1 && Boolean(name) && name !== '0' && !name.startsWith('application.');
}

function detectSupervisor({ env, ppid, hasIpc, platform, readFile = fs.readFileSync }) {
  const facts = { env, ppid, hasIpc, platform, readFile };
  if (pm2Supervised(facts)) return 'pm2';
  if (systemdSupervised(facts)) return 'systemd';
  if (launchdSupervised(facts)) return 'launchd';
  return null;
}

module.exports = { detectSupervisor };
