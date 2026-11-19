// Opening web links where the person is (docs/design/open-links.md). Used by h5.js for a link a program in the terminal opened (the open /
// xdg-open / $BROWSER shims on the engine, routes/open-link.js, the `open-link` control message) and for a tap on a link in the terminal
// (the OSC 8 linkHandler). Pure decisions plus the one call that opens; no state.
// - The Mac app (T-Agent.app, its `tagentOpen` script message handler): the app opens http(s) in the default browser at once, no gesture
//   needed (its web view blocks window.open without one).
// - Everywhere else a program's link waits for a click on the bar (a browser blocks opening a window without a user gesture), and the click
//   opens it: on a Home Screen app of an iPhone or iPad (standalone display mode) through `x-safari-https://` (iOS 17 and later, and 15;
//   it opens Safari instead of the in-app browser view); on an installed app on Android through an `intent://` URL without a package (Android
//   picks the default browser; the link itself is the fallback); else window.open in a new tab.
const OpenLink = (() => {
  const MAX_URL = 4096;

  function valid(url) {
    if (typeof url !== 'string' || !url || url.length > MAX_URL || !/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i.test(url)) return false;
    try { const parsed = new URL(url); return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname); } catch { return false; }
  }
  const programName = agent => (agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : '');

  // iOS (an iPad's standalone app reports a Mac with touch points) and its major version, or Android.
  function platformOf(nav) {
    const ua = String((nav && nav.userAgent) || '');
    if (/\b(iPhone|iPad|iPod)\b/.test(ua) || (nav && nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)) {
      const match = ua.match(/\b(?:iPhone|iPad|iPod)\b.*? OS (\d+)_/) || ua.match(/\bVersion\/(\d+)/);
      return { platform: 'ios', iosMajor: match ? Number(match[1]) : 0 };
    }
    return { platform: /\bAndroid\b/i.test(ua) ? 'android' : 'other', iosMajor: 0 };
  }
  // What the page runs in: { app, standalone, platform, iosMajor }.
  function environment(win = window) {
    const nav = win.navigator || {};
    const handlers = win.webkit && win.webkit.messageHandlers;
    let standalone = nav.standalone === true;
    try { standalone = standalone || Boolean(win.matchMedia && (win.matchMedia('(display-mode: standalone)').matches || win.matchMedia('(display-mode: fullscreen)').matches)); } catch { /* old browser */ }
    return { app: Boolean(handlers && handlers.tagentOpen && typeof handlers.tagentOpen.postMessage === 'function'), standalone, ...platformOf(nav) };
  }
  // The Android intent for a web link: no package, so the system's default browser takes it; the link is the fallback.
  function intentUrl(url) {
    const parsed = new URL(url);
    return `intent://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}#Intent;scheme=${parsed.protocol.slice(0, -1)};S.browser_fallback_url=${encodeURIComponent(url)};end`;
  }
  // How a click opens the link: { how: 'app' | 'location' | 'window', href }.
  function target(url, env) {
    if (env.app) return { how: 'app', href: url };
    if (env.standalone && env.platform === 'ios' && (env.iosMajor >= 17 || env.iosMajor === 15)) return { how: 'location', href: `x-safari-${url}` };
    if (env.standalone && env.platform === 'android') return { how: 'window', href: intentUrl(url) };
    return { how: 'window', href: url };
  }
  // Opens the link (call it inside the click, except in the Mac app). Answers false for a link that is not http(s).
  function open(url, env = environment(), win = window) {
    if (!valid(url)) return false;
    const go = target(url, env);
    if (go.how === 'app') win.webkit.messageHandlers.tagentOpen.postMessage(go.href);
    else if (go.how === 'location') win.location.href = go.href;
    else win.open(go.href, '_blank', 'noopener,noreferrer');
    return true;
  }
  return { valid, programName, platformOf, environment, intentUrl, target, open, MAX_URL };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = OpenLink;
