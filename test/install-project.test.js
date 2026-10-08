const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
// install.sh 在 Linux 上可能通过 sudo 安装编译工具，所以沙箱测试只在 macOS 上运行。
const enabled = process.platform === 'darwin';

// 每个用例都用自己的空闲端口，避免和本机正在运行的服务（如 3000）冲突。
let nextPort = 43000 + Math.floor(Math.random() * 15000);
const freePort = () => String(nextPort++);

// 把真实的 install.sh 放进临时项目目录，用桩替换 npm / pm2 / launchctl。
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
  // node 所在目录（如 nvm）里通常有真实的 npm/pm2；沙箱里只放 node 的链接，其余全部用桩，避免测试误用真实的 PM2。
  const nodeBin = path.join(root, 'nodebin');
  fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  const env = { HOME: home, PATH: `${stubs}:${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const run = (args = []) => spawnSync('bash', [path.join(app, 'install.sh'), ...args], { encoding: 'utf8', input: '', cwd: app, env });
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '');
  return { root, app, home, stubs, env, run, log, plistDir: path.join(home, 'Library/LaunchAgents'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('新安装默认由 PM2 管理：以项目目录为工作目录启动并保存，不再注册 LaunchAgent；重复运行改为重启', { skip: !enabled }, () => {
  const box = sandbox();
  try {
    const result = box.run(['--port', freePort()]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(box.log().includes(`pm2 start ${box.app}/server.js --name t-agent --cwd ${box.app}`), box.log());
    assert.ok(box.log().includes('pm2 save'));
    assert.match(result.stdout, /服务检查：pm2 status t-agent/);
    assert.match(result.stdout, /pm2 startup/);
    assert.ok(!fs.existsSync(box.plistDir), '不再注册 LaunchAgent');

    const again = box.run([]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /保留现有/);
    assert.ok(box.log().includes('pm2 restart t-agent --update-env'), '第二次运行重启而不是重复启动');
    assert.equal(box.log().split('pm2 start').length - 1, 1);
  } finally { box.cleanup(); }
});

test('--no-service 不启动；--system-service 仍然注册 LaunchAgent', { skip: !enabled }, () => {
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

test('已注册系统服务的老安装默认继续沿用，加 --pm2 才迁移到 PM2', { skip: !enabled }, () => {
  const box = sandbox();
  try {
    const plist = path.join(box.plistDir, 'com.tagent.client.plist');
    fs.mkdirSync(box.plistDir, { recursive: true });
    fs.writeFileSync(plist, '<plist/>');
    const kept = box.run(['--port', freePort()]);
    assert.equal(kept.status, 0, kept.stdout + kept.stderr);
    assert.match(kept.stdout, /继续沿用它/);
    assert.ok(!box.log().includes('pm2 start'), '不会悄悄切换到 PM2');
    assert.ok(fs.existsSync(plist));

    fs.writeFileSync(plist, '<plist/>');
    const migrated = box.run(['--pm2', '--port', freePort()]);
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    assert.match(migrated.stdout, /改由 PM2 管理/);
    assert.ok(box.log().includes('launchctl bootout'));
    assert.ok(!fs.existsSync(plist), '旧的 LaunchAgent 已移除');
    assert.ok(box.log().includes('pm2 start'));
  } finally { box.cleanup(); }
});

test('没有 PM2 时自动用 npm 安装；安装失败只警告并给出手动启动命令，不让整个安装失败', { skip: !enabled }, () => {
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
    assert.match(result.stderr, /无法安装或找到 PM2/);
    assert.match(result.stdout, /服务尚未启动/);
    assert.ok(!failing.log().includes('pm2 start'));
  } finally { failing.cleanup(); }
});

test('端口已被占用时不启动服务并给出提示', { skip: !enabled }, async () => {
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
    assert.match(result.out, new RegExp(`端口 ${port} 已被其他进程占用`));
    assert.ok(!box.log().includes('pm2 start'));
  } finally { server.close(); box.cleanup(); }
});
