const test = require('node:test');
const assert = require('node:assert/strict');
const { RESET_INPUT_MODES, watchShellReturn } = require('../lib/terminal-input-modes');

test('前台程序退回 shell 时关闭残留的鼠标上报模式', async () => {
  const pty = { process: 'zsh' };
  let resets = 0;
  const stop = watchShellReturn(pty, '/bin/zsh', () => { resets += 1; }, 5);
  const wait = () => new Promise(resolve => setTimeout(resolve, 30));
  await wait(); assert.equal(resets, 0, 'idle shell is untouched');
  pty.process = 'claude'; await wait(); assert.equal(resets, 0, 'running program keeps its modes');
  pty.process = 'zsh'; await wait(); await wait(); assert.equal(resets, 1);
  stop();
  for (const mode of ['1000', '1002', '1003', '1006']) assert.match(RESET_INPUT_MODES, new RegExp(`\\x1b\\[\\?${mode}l`));
});
