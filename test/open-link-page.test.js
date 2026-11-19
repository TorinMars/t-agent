// The page side of opening links where the person is (public/js/open-link.js, docs/design/open-links.md): what the page runs in (the Mac
// app, a Home Screen app on iOS or Android, a normal tab) and how a click opens a link there, with stub windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const OpenLink = require('../public/js/open-link.js');

const IPHONE_17 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPHONE_16 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// A stub window: user agent, standalone display mode, the Mac app's handler; records what it is asked to open.
function stubWindow({ ua = MAC_CHROME, platform = 'MacIntel', touch = 0, standalone = false, iosStandalone = false, app = false } = {}) {
  const calls = [];
  const win = {
    navigator: { userAgent: ua, platform, maxTouchPoints: touch, ...(iosStandalone ? { standalone: true } : {}) },
    matchMedia: query => ({ matches: standalone && query === '(display-mode: standalone)' }),
    open: (...args) => { calls.push(['open', ...args]); return null; },
    location: { set href(value) { calls.push(['location', value]); } },
    ...(app ? { webkit: { messageHandlers: { tagentOpen: { postMessage: value => calls.push(['app', value]) } } } } : {}),
  };
  return { win, calls };
}

const URL_A = 'https://preview.example.dev/pr/42?tab=files#top';

test('valid links are http(s) with a host, without spaces, at most 4096 characters', () => {
  assert.equal(OpenLink.valid(URL_A), true);
  assert.equal(OpenLink.valid('http://example.com'), true);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end', 'https://exa mple.com/', 'https://', '', null, 42, `https://e.com/${'a'.repeat(4100)}`]) {
    assert.equal(OpenLink.valid(bad), false, String(bad).slice(0, 30));
  }
});

test('the program name comes from the terminal kind', () => {
  assert.equal(OpenLink.programName('claude'), 'Claude');
  assert.equal(OpenLink.programName('codex'), 'Codex');
  assert.equal(OpenLink.programName(null), '');
  assert.equal(OpenLink.programName('shell'), '');
});

test('the Mac app: its handler opens the link at once in the default browser', () => {
  const { win, calls } = stubWindow({ app: true });
  const env = OpenLink.environment(win);
  assert.equal(env.app, true);
  assert.equal(OpenLink.open(URL_A, env, win), true);
  assert.deepEqual(calls, [['app', URL_A]]);
});

test('a desktop browser (with or without the extension) and a normal phone tab open a new tab with window.open', () => {
  for (const options of [{}, { ua: ANDROID, platform: 'Linux armv8l', touch: 5 }, { ua: IPHONE_17, platform: 'iPhone', touch: 5 }]) {
    const { win, calls } = stubWindow(options);
    const env = OpenLink.environment(win);
    assert.equal(env.app, false);
    assert.equal(env.standalone, false);
    OpenLink.open(URL_A, env, win);
    assert.deepEqual(calls, [['open', URL_A, '_blank', 'noopener,noreferrer']]);
  }
});

test('a Home Screen app on iOS 17+ opens Safari with x-safari-https; iOS 16 keeps window.open (the scheme does not work there)', () => {
  const ios = stubWindow({ ua: IPHONE_17, platform: 'iPhone', touch: 5, iosStandalone: true });
  const env = OpenLink.environment(ios.win);
  assert.deepEqual({ standalone: env.standalone, platform: env.platform, iosMajor: env.iosMajor }, { standalone: true, platform: 'ios', iosMajor: 17 });
  OpenLink.open(URL_A, env, ios.win);
  assert.deepEqual(ios.calls, [['location', `x-safari-${URL_A}`]]);
  const http = stubWindow({ ua: IPHONE_17, platform: 'iPhone', touch: 5, iosStandalone: true });
  OpenLink.open('http://example.com/a', OpenLink.environment(http.win), http.win);
  assert.deepEqual(http.calls, [['location', 'x-safari-http://example.com/a']]);
  const old = stubWindow({ ua: IPHONE_16, platform: 'iPhone', touch: 5, iosStandalone: true });
  OpenLink.open(URL_A, OpenLink.environment(old.win), old.win);
  assert.deepEqual(old.calls, [['open', URL_A, '_blank', 'noopener,noreferrer']]);
  const ipad = stubWindow({ ua: IPAD_DESKTOP, platform: 'MacIntel', touch: 5, standalone: true });
  const ipadEnv = OpenLink.environment(ipad.win);
  assert.deepEqual([ipadEnv.platform, ipadEnv.iosMajor], ['ios', 18], 'an iPad that reports a Mac with touch');
  OpenLink.open(URL_A, ipadEnv, ipad.win);
  assert.deepEqual(ipad.calls, [['location', `x-safari-${URL_A}`]]);
});

test('an installed app on Android opens an intent without a package (the default browser), the link as its fallback', () => {
  const { win, calls } = stubWindow({ ua: ANDROID, platform: 'Linux armv8l', touch: 5, standalone: true });
  const env = OpenLink.environment(win);
  assert.deepEqual([env.standalone, env.platform], [true, 'android']);
  OpenLink.open(URL_A, env, win);
  assert.deepEqual(calls, [['open', `intent://preview.example.dev/pr/42?tab=files#top#Intent;scheme=https;S.browser_fallback_url=${encodeURIComponent(URL_A)};end`, '_blank', 'noopener,noreferrer']]);
  assert.equal(OpenLink.intentUrl('http://example.com'), `intent://example.com/#Intent;scheme=http;S.browser_fallback_url=${encodeURIComponent('http://example.com')};end`);
});

test('a link that is not http(s) is never opened', () => {
  const { win, calls } = stubWindow({ app: true });
  assert.equal(OpenLink.open('javascript:alert(1)', OpenLink.environment(win), win), false);
  assert.equal(OpenLink.open('file:///etc/passwd', OpenLink.environment(win), win), false);
  assert.deepEqual(calls, []);
});
