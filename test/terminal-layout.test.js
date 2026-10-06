const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

test('安装应用中的终端使用动态 Flex 高度并跟随容器重新适配', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
  const terminalSource = fs.readFileSync(path.join(root, 'public', 'js', 'tasks.js'), 'utf8');
  const viewport = fs.readFileSync(path.join(root, 'public', 'js', 'terminal-viewport.js'), 'utf8');

  assert.match(css, /body\s*\{[^}]*display:\s*flex[^}]*height:\s*100dvh/s);
  assert.match(css, /\.layout\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/s);
  assert.match(css, /#xterm-container > \.xterm-host\s*\{[^}]*inset:\s*4px 4px 8px/s);
  assert.match(css, /#xterm-container \.xterm-viewport\s*\{[^}]*overflow-y:\s*scroll !important[^}]*scrollbar-gutter:\s*stable/s);
  assert.doesNotMatch(css, /#xterm-container \.xterm-viewport\s*\{[^}]*overflow-y:\s*auto/s);

  // Phones now share the desktop stylesheet; installed apps use the window size.
  assert.match(css, /body\s*\{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom, 0px\)/s);
  assert.match(css, /@media\s*\(display-mode: standalone\)[^{]*\{\s*body\s*\{[^}]*min-width:\s*0;[^}]*max-height:\s*none/s);

  // Local and remote terminals share one implementation.
  assert.match(terminalSource, /el\.className = 'xterm-host'/);
  assert.match(terminalSource, /TerminalViewport\.observe\(/);
  assert.doesNotMatch(terminalSource, /el\.style\.cssText = 'width:100%;height:100%'/);
  assert.match(viewport, /new ResizeObserver/);
});
