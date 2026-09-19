const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['docker', 'scripts', 'bin', 'host-codex']) fs.mkdirSync(path.join(dir, name));
  for (const name of ['docker-client.sh', 'compose.client.yml', 'docker/client.env.example', 'docker/client.nginx.conf.example', 'scripts/docker-client-copy-codex.sh']) fs.copyFileSync(path.join(root, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'host-codex/auth.json'), 'host credentials');
  fs.writeFileSync(path.join(dir, 'bin/docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$*" in
 *'config --environment'*)
   printf 'T_AGENT_CLIENT_STORAGE_DIR=%s\\nT_AGENT_CLIENT_PORT=%s\\nT_AGENT_CLIENT_DOMAIN=agent.example.com\\n' "$TEST_STORAGE" "\${T_AGENT_CLIENT_PORT:-13500}"
   printf 'T_AGENT_CLIENT_WORKSPACE_DIR=%s\\nT_AGENT_CLIENT_BIND=%s\\n' "\${T_AGENT_CLIENT_WORKSPACE_DIR:-}" "\${T_AGENT_CLIENT_BIND:-127.0.0.1}" ;;
 *'pull client'*) exit "\${TEST_PULL_EXIT:-0}" ;;
 *'up -d'*) exit "\${TEST_UP_EXIT:-0}" ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(dir, 'bin') + ':' + process.env.PATH, TEST_LOG: path.join(dir, 'calls'), TEST_STORAGE: path.join(dir, 'client data') };
  const run = (...args) => spawnSync('bash', [path.join(dir, 'docker-client.sh'), '--codex-source', path.join(dir, 'host-codex'), ...args], { encoding: 'utf8', env });
  return { dir, env, run };
}
test('one command prepares an independent Codex copy and waits for Client health', t => {
  const f = fixture(t);
  const result = f.run('--domain', 'agent.example.com', '--port', '13500');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/agent.example.com/);
  assert.match(result.stdout, /client-auth-setup.js/);
  assert.equal(fs.readFileSync(path.join(f.env.TEST_STORAGE, 'codex/auth.json'), 'utf8'), 'host credentials');
  const calls = fs.readFileSync(f.env.TEST_LOG, 'utf8');
  assert.match(calls, /up -d.*--wait/);
  assert.match(fs.readFileSync(path.join(f.dir, 'docker/client.env'), 'utf8'), /T_AGENT_CLIENT_PORT="13500"/);
  fs.writeFileSync(path.join(f.env.TEST_STORAGE, 'codex/auth.json'), 'container refreshed');
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.env.TEST_STORAGE, 'codex/auth.json'), 'utf8'), 'container refreshed');
});
test('pull or startup failure never reports success', t => {
  const f = fixture(t);
  f.env.TEST_PULL_EXIT = '1';
  let result = f.run();
  assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /Client 已启动/);
  f.env.TEST_PULL_EXIT = '0'; f.env.TEST_UP_EXIT = '1';
  result = f.run(); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /Client 已启动/);
});
test('invalid options fail before starting Docker', t => {
  const f = fixture(t);
  for (const args of [['--port', '99999'], ['--domain', 'https://bad/path'], ['--unknown']]) assert.notEqual(f.run(...args).status, 0);
  assert.equal(fs.existsSync(f.env.TEST_LOG), false);
});

test('curl-style stdin execution delegates to an existing checkout and preserves arguments', t => {
  const f = fixture(t);
  const result = spawnSync('bash', ['-s', '--', '--domain', 'agent.example.com', '--port', '13500', '--codex-source', path.join(f.dir, 'host-codex')], {
    input: fs.readFileSync(path.join(root, 'docker-client.sh'), 'utf8'), encoding: 'utf8', env: { ...f.env, T_AGENT_CLIENT_APP_DIR: f.dir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/agent.example.com/);
});

test('workspace and remote access options persist and appear in the summary', t => {
  const f = fixture(t);
  const workspace = path.join(f.dir, 'project files');
  const result = f.run('--work-dir', workspace, '--remote-access', 'yes', '--non-interactive');
  assert.equal(result.status, 0, result.stderr);
  const config = fs.readFileSync(path.join(f.dir, 'docker/client.env'), 'utf8');
  assert.ok(config.includes(`T_AGENT_CLIENT_WORKSPACE_DIR="${workspace}"`));
  assert.match(config, /T_AGENT_CLIENT_BIND="0.0.0.0"/);
  assert.ok(result.stdout.includes(workspace));
  assert.match(result.stdout, /0\.0\.0\.0:13500/);
  assert.match(result.stdout, /HTTPS/);
});

async function interactive(f, answers) {
  const pty = require('node-pty');
  return new Promise((resolve, reject) => {
    const terminal = pty.spawn('/bin/bash', [path.join(f.dir, 'docker-client.sh'), '--configure', '--codex-source', path.join(f.dir, 'host-codex')], { env: f.env, cols: 140, rows: 35 });
    let output = '', index = 0;
    const prompts = ['default 恢复默认：', '宿主机端口 [13500]：', '允许远程连接此端口？'];
    const timeout = setTimeout(() => { terminal.kill(); reject(new Error('Installer prompt timed out: ' + output)); }, 10000);
    terminal.onData(data => {
      output += data;
      if (index < prompts.length && output.includes(prompts[index])) { terminal.write(answers[index] + '\r'); index++; }
    });
    terminal.onExit(({ exitCode }) => { clearTimeout(timeout); resolve({ exitCode, output }); });
  });
}

test('interactive install asks for workspace, host port and remote access', async t => {
  const f = fixture(t);
  const workspace = path.join(f.dir, 'interactive workspace');
  const result = await interactive(f, [workspace, '18080', 'yes']);
  assert.equal(result.exitCode, 0, result.output);
  assert.ok(result.output.includes(workspace + ' → /workspace'));
  assert.match(result.output, /0\.0\.0\.0:18080/);
  const config = fs.readFileSync(path.join(f.dir, 'docker/client.env'), 'utf8');
  assert.match(config, /T_AGENT_CLIENT_PORT="18080"/);
  assert.match(config, /T_AGENT_CLIENT_BIND="0.0.0.0"/);
});

test('accepting displayed default workspace keeps inheritance instead of fixing its path', async t => {
  const f = fixture(t);
  const result = await interactive(f, ['', '', '']);
  assert.equal(result.exitCode, 0, result.output);
  const config = fs.readFileSync(path.join(f.dir, 'docker/client.env'), 'utf8');
  assert.match(config, /^T_AGENT_CLIENT_WORKSPACE_DIR=$/m);
  assert.match(result.output, /127\.0\.0\.1:13500/);
});
