const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = file => fs.readFileSync(path.join(__dirname, '..', 'public', 'css', file), 'utf8');
const VARIABLES = ['--term-bg', '--term-chrome', '--term-line', '--term-btn', '--term-btn-hover', '--term-btn-line', '--term-pop', '--term-text', '--term-tab-active', '--term-accent'];

test('the terminal colours are variables: the neutral greys are written once, as the defaults', () => {
  const style = css('style.css');
  for (const grey of ['#252526', '#1e1e1e', '#2d2d2d', '#4b4b4b', '#1b1b1c']) {
    assert.equal(style.split(grey).length - 1, 1, `${grey} is only the default of a variable, not repeated in a rule`);
  }
  for (const name of VARIABLES) assert.match(style, new RegExp(`^  ${name}: #[0-9a-f]{3,6};`, 'm'), `${name} has a default`);
});

test('the futuristic theme sets every terminal colour, so the terminal and its tabs are one shade family there', () => {
  const themes = css('themes.css');
  const tech = themes.slice(themes.indexOf(':root[data-theme="tech"] {'), themes.indexOf(':root[data-theme="tech"] body {'));
  for (const name of VARIABLES) assert.match(tech, new RegExp(`^  ${name}: #[0-9a-f]{3,6};`, 'm'), `${name} is set for the futuristic theme`);
});
