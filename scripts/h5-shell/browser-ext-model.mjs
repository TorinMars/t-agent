// The small pure parts of Settings → Tasks and files → Browser extension (BrowserExtSettings.jsx), tested in test/browser-ext-model.test.js.

// "ABCD EFGH" for reading and typing; the copied text has no space.
export const pairCodeText = code => (typeof code === 'string' && code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : String(code || ''));

// "2026-11-12 10:04" from an ISO time, or '' when there is none.
export const shortTime = value => (typeof value === 'string' && value.length >= 16 ? value.slice(0, 16).replace('T', ' ') : '');

// The line under a paired browser's name: the extension version, the browser, and when it was last seen (or that it is connected now).
// `t` translates the fixed words.
export function browserDetail(browser, { t = text => text } = {}) {
  if (!browser) return '';
  const parts = [];
  if (browser.version) parts.push(`${t('Extension')} ${browser.version}`);
  const kind = browser.browser && browser.browser.name;
  if (kind) parts.push(kind);
  if (browser.online) parts.push(t('Connected now'));
  else if (shortTime(browser.last_seen_at)) parts.push(`${t('Last seen')} ${shortTime(browser.last_seen_at)}`);
  else parts.push(t('Never connected'));
  return parts.join(' · ');
}

// The browser that was not in `before` (a list of browser ids): the one the code just paired, or null.
export function newlyPaired(before, browsers) {
  const known = new Set(before || []);
  return (Array.isArray(browsers) ? browsers : []).find(browser => browser && !known.has(browser.browser_id)) || null;
}

// The answer of GET /api/browser-ext in the shape the page uses.
export function normalizeStatus(data) {
  const browsers = data && Array.isArray(data.browsers) ? data.browsers.filter(browser => browser && typeof browser.browser_id === 'string') : [];
  return {
    browsers,
    connected: Boolean(data && data.connected),
    extensionDir: data && typeof data.extension_dir === 'string' ? data.extension_dir : '',
    extensionPresent: Boolean(data && data.extension_present),
    serverUrl: data && typeof data.server_url === 'string' && data.server_url ? data.server_url : '',
  };
}
