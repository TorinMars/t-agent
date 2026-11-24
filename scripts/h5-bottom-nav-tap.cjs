// For the headless browser tests: taps a destination of the phone's bottom navigation (BottomNav.jsx). On the session page with a terminal the bar is
// hidden behind its pull handle (#h5-bnav-handle; "Pull handle on the session page" in docs/design/page-navigation.md), so the handle is tapped first.
// `how` is the Playwright action ('tap' or 'click'). Elsewhere (a destination page, no terminal) the bar is shown and the item is tapped at once.
async function showBottomNav(page) {
  const nav = page.locator('#h5-bnav');
  if (await nav.isVisible()) return;
  const handle = page.locator('#h5-bnav-handle');
  await handle.waitFor({ state: 'visible', timeout: 8000 });
  await handle.tap();
  await nav.waitFor({ state: 'visible' });
}
async function bnavTap(page, selector, how = 'tap') {
  const target = page.locator(selector).first();
  if (!(await target.isVisible())) await showBottomNav(page);
  await target[how]();
}
module.exports = { bnavTap, showBottomNav };
