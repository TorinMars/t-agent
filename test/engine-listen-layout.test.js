const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('独立 Engine 固定监听所有网卡', () => {
  const server = fs.readFileSync(path.join(root, 'apps', 'engine', 'server.js'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'compose.engine.yml'), 'utf8');

  assert.match(server, /const host = '0\.0\.0\.0'/);
  assert.doesNotMatch(server, /process\.env\.ENGINE_HOST/);
  assert.match(compose, /T_AGENT_ENGINE_BIND:-0\.0\.0\.0/);
});

test('安装应用中的终端使用动态 Flex 高度并跟随容器重新适配', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
  const localTerminal = fs.readFileSync(path.join(root, 'public', 'js', 'tasks.js'), 'utf8');
  const remoteTerminal = fs.readFileSync(path.join(root, 'public', 'js', 'remote-tasks.js'), 'utf8');

  assert.match(css, /body\s*\{[^}]*display:\s*flex[^}]*height:\s*100dvh/s);
  assert.match(css, /\.layout\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/s);
  assert.match(css, /#xterm-container > \.xterm-host\s*\{[^}]*inset:\s*4px 4px 8px/s);

  for (const source of [localTerminal, remoteTerminal]) {
    assert.match(source, /el\.className = 'xterm-host'/);
    assert.match(source, /new ResizeObserver/);
    assert.doesNotMatch(source, /el\.style\.cssText = 'width:100%;height:100%'/);
  }
});
