// 译文进入终端前必须清掉控制字符并压成一行，否则翻译结果可以注入按键序列或提前提交。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/terminal-translate.js'), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.T = TerminalTranslate;`, context);

test('sanitize strips escape sequences and control characters', () => {
  assert.equal(context.T.sanitize('fix \u001b[31mthe\u001b[0m bug'), 'fix [31mthe [0m bug');
  assert.equal(context.T.sanitize('a\u0007b\u0000c\u007fd'), 'a b c d');
  assert.equal(context.T.sanitize('line one\r\nline two line three'), 'line one line two line three');
  assert.equal(context.T.sanitize('  keep   spaces  tidy '), 'keep spaces tidy');
  assert.equal(context.T.sanitize('\u001b\u001b'), '');
});
