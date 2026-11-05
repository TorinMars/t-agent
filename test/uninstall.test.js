const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'uninstall.sh');

// A sandbox with an install directory, a home with a data folder, and stub service tools (nothing on the machine is touched).
function sandbox(t, envFile = 'PORT=\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-uninstall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const data = path.join(home, '.tagent');
  for (const dir of [app, data, bin, path.join(home, 'Library', 'LaunchAgents')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(app, '.env'), envFile);
  fs.writeFileSync(path.join(data, 'db.sqlite'), 'data');
  for (const tool of ['pm2', 'launchctl', 'systemctl', 'fuser']) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  const run = (answers, args = []) => {
    const tty = path.join(root, 'answers');
    fs.writeFileSync(tty, answers);
    return spawnSync('bash', [SCRIPT, ...args], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, HOME: home, T_AGENT_DIR: app, T_AGENT_UNINSTALL_TTY: tty, PATH: `${bin}:${process.env.PATH}` },
    });
  };
  return { root, app, home, data, run };
}

test('uninstall keeps the shared data folder by default and says how to delete it', t => {
  const box = sandbox(t);
  const result = box.run('UNINSTALL\n');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(box.app), 'the install directory is removed');
  assert.ok(fs.existsSync(path.join(box.data, 'db.sqlite')), 'the data folder is kept');
  assert.ok(!result.stdout.includes('  - Data folder'), 'the data folder is not in the delete list');
  assert.ok(result.stdout.includes(`The data folder is kept: ${box.data}`), result.stdout);
  assert.ok(result.stdout.includes(`rm -rf "${box.data}"`) && result.stdout.includes('--purge-data'));
});

test('--purge-data deletes the data folder only after its own confirmation', t => {
  const kept = sandbox(t);
  const declined = kept.run('UNINSTALL\nno\n', ['--purge-data']);
  assert.equal(declined.status, 0, declined.stderr);
  assert.ok(declined.stdout.includes(`  - Data folder (database, keys, backups; shared by every installed version): ${kept.data}`));
  assert.ok(fs.existsSync(path.join(kept.data, 'db.sqlite')), 'a wrong answer keeps the data');
  assert.match(declined.stdout, /The data folder is kept\./);

  const purged = sandbox(t);
  const result = purged.run('UNINSTALL\nDELETE DATA\n', ['--purge-data']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(purged.data));
  assert.ok(result.stdout.includes(`The data folder ${purged.data} was deleted.`), result.stdout);
});

test('the data folder named in .env is the one reported; cancelling or an unknown option changes nothing', t => {
  const box = sandbox(t);
  const custom = path.join(box.root, 'custom-data');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(box.app, '.env'), `PORT=\nTAGENT_HOME=${custom}\n`);
  const cancelled = box.run('no\n', ['--purge-data']);
  assert.equal(cancelled.status, 0);
  assert.match(cancelled.stdout, /Uninstall cancelled/);
  assert.ok(fs.existsSync(box.app) && fs.existsSync(custom));
  const unknown = box.run('UNINSTALL\n', ['--everything']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option --everything/);
  assert.ok(fs.existsSync(box.app));
  const result = box.run('UNINSTALL\n');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`The data folder is kept: ${custom}`), result.stdout);
  assert.ok(fs.existsSync(custom) && fs.existsSync(box.data));
});
