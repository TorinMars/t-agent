const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
// install.sh on Linux may install build tools through sudo, so the sandbox test only runs on macOS.
const enabled = process.platform === 'darwin';

// Every case uses its own free port so it does not collide with a service running on this machine (such as 3000).
let nextPort = 43000 + Math.floor(Math.random() * 15000);
const freePort = () => String(nextPort++);

// Put the real install.sh into a temporary project directory and replace npm / pm2 / launchctl with stubs.
function sandbox({ withPm2 = true, npmInstallsPm2 = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-project-')));
  const app = path.join(root, 'proj');
  const home = path.join(root, 'home');
  const stubs = path.join(root, 'stubs');
  for (const dir of [path.join(app, 'scripts'), path.join(app, 'node_modules'), home, stubs, path.join(root, 'npm-prefix')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(repo, 'install.sh'), path.join(app, 'install.sh'));
  fs.chmodSync(path.join(app, 'install.sh'), 0o755);
  fs.writeFileSync(path.join(app, 'server.js'), '// stub\n');
  fs.writeFileSync(path.join(app, 'scripts/verify-node-pty.js'), 'process.exit(0)\n');
  fs.symlinkSync(path.join(repo, 'node_modules/dotenv'), path.join(app, 'node_modules/dotenv'));
  const calls = path.join(root, 'calls.log');
  const stub = (name, body) => fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const pm2Body = `echo "pm2 $*" >> "${calls}"
case "$1" in
  describe) [ -f "${root}/pm2-running" ] && exit 0 || exit 1 ;;
  start) touch "${root}/pm2-running" ;;
esac
exit 0`;
  stub('npm', `echo "npm $*" >> "${calls}"
[ "$1 $2 $3" = "config get prefix" ] && echo "${root}/npm-prefix"
${npmInstallsPm2 ? `if [ "$1 $2" = "install -g" ]; then printf '#!/bin/sh\\n${pm2Body.replace(/\n/g, '\\n').replace(/'/g, "'\\''")}\\n' > "${stubs}/pm2"; chmod +x "${stubs}/pm2"; fi` : '[ "$1 $2" = "install -g" ] && exit 1'}
exit 0`);
  stub('launchctl', `echo "launchctl $*" >> "${calls}"\nexit 0`);
  if (withPm2) stub('pm2', pm2Body);
  // The directory containing node (for example nvm) usually has a real npm/pm2; in the sandbox only a link to node is put in and everything else is stubbed, so the test never uses a real PM2.
  const nodeBin = path.join(root, 'nodebin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  const env = { HOME: home, PATH: `${stubs}:${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const run = (args = []) => spawnSync('bash', [path.join(app, 'install.sh'), ...args], { encoding: 'utf8', input: '', cwd: app, env });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  return { root, app, home, stubs, env, run, log, plistDir: path.join(home, 'Library/LaunchAgents'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('A fresh install is managed by PM2: it starts and saves with the project directory as the working directory, no longer registers a LaunchAgent, and running again restarts', { skip: !enabled }, () => {
  const box = sandbox();
  try {
    const result = box.run(['--port', freePort()]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(box.log().includes(`pm2 start ${box.app}/server.js --name t-agent --cwd ${box.app}`), box.log());
    assert.ok(box.log().includes('pm2 save'));
    assert.match(result.stdout, /Service check: pm2 status t-agent/);
    assert.match(result.stdout, /pm2 startup/);
    assert.ok(!fs.existsSync(box.plistDir), 'no longer registers a LaunchAgent');

    const again = box.run([]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /Keeping the existing/);
    assert.ok(box.log().includes('pm2 restart t-agent --update-env'), 'The second run restarts instead of starting again');
    assert.equal(box.log().split('pm2 start').length - 1, 1);
  } finally { box.cleanup(); }
});

test('--no-service does not start; --system-service still registers a LaunchAgent', { skip: !enabled }, () => {
  const box = sandbox();
  try {
    assert.equal(box.run(['--no-service', '--port', freePort()]).status, 0);
    assert.ok(!box.log().includes('pm2 start'));
    const system = box.run(['--system-service', '--port', freePort()]);
    assert.equal(system.status, 0, system.stdout + system.stderr);
    assert.ok(fs.existsSync(path.join(box.plistDir, 'com.tagent.client.plist')));
    assert.ok(!box.log().includes('pm2 start'));
  } finally { box.cleanup(); }
});

test('Old installs with a registered system service keep using it by default; add --pm2 to migrate to PM2', { skip: !enabled }, () => {
  const box = sandbox();
  try {
    const plist = path.join(box.plistDir, 'com.tagent.client.plist');
    fs.mkdirSync(box.plistDir, { recursive: true });
    fs.writeFileSync(plist, '<plist/>');
    const kept = box.run(['--port', freePort()]);
    assert.equal(kept.status, 0, kept.stdout + kept.stderr);
    assert.match(kept.stdout, /will keep being used/);
    assert.ok(!box.log().includes('pm2 start'), 'does not silently switch to PM2');
    assert.ok(fs.existsSync(plist));

    fs.writeFileSync(plist, '<plist/>');
    const migrated = box.run(['--pm2', '--port', freePort()]);
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    assert.match(migrated.stdout, /PM2 will manage it instead/);
    assert.ok(box.log().includes('launchctl bootout'));
    assert.ok(!fs.existsSync(plist), 'The old LaunchAgent was removed');
    assert.ok(box.log().includes('pm2 start'));
  } finally { box.cleanup(); }
});

test('PM2 is installed with npm when missing; if that fails it only warns and prints the manual start command, without failing the whole install', { skip: !enabled }, () => {
  const auto = sandbox({ withPm2: false });
  try {
    const result = auto.run(['--port', freePort()]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(auto.log().includes('npm install -g pm2'));
    assert.ok(auto.log().includes('pm2 start'));
  } finally { auto.cleanup(); }

  const failing = sandbox({ withPm2: false, npmInstallsPm2: false });
  try {
    const result = failing.run(['--port', freePort()]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /cannot install or find PM2/);
    assert.match(result.stdout, /The service is not running yet/);
    assert.ok(!failing.log().includes('pm2 start'));
  } finally { failing.cleanup(); }
});

test('When the port is already taken the service is not started and a hint is given', { skip: !enabled }, async () => {
  const box = sandbox();
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const result = await new Promise(resolve => {
      const child = spawn('bash', [path.join(box.app, 'install.sh'), '--port', String(port)], { cwd: box.app, env: box.env });
      let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
      child.stdin.end(); child.on('close', code => resolve({ code, out }));
    });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, new RegExp(`port ${port} is used by another process`));
    assert.ok(!box.log().includes('pm2 start'));
  } finally { server.close(); box.cleanup(); }
});
