// The one way the headless browser scripts (scripts/test-*-browser.cjs) move around the Settings page (scripts/h5-shell/Settings.jsx, "Settings page"
// in docs/design/page-files-and-settings.md). Not a test itself: the name stays outside the `test-*-browser.cjs` pattern of npm test.
// On a computer (`#h5-settings[data-layout="wide"]`) a group is chosen in the group list at the left; on a phone the list is the first page and a
// group opens its own full-screen page (`#h5-settings-page`), left with its back arrow. Every helper works on a Page or a Frame.
const { settled } = require('./browser-test-wait.cjs');

const wideLayout = target => target.evaluate(() => Boolean(document.querySelector('#h5-settings[data-layout="wide"]')));
const groupShown = (target, id) => target.evaluate(group => {
  const node = document.getElementById(`h5-set-${group}`);
  if (!node || node.hidden) return false;
  const page = document.getElementById('h5-settings-page');
  return !page || !page.contains(node) || !page.classList.contains('MuiModal-hidden');
}, id);
const pageOf = target => (typeof target.page === 'function' ? target.page() : target);

// Shows group `id` ('tasks-files', 'voice-translate', 'devices', 'attention', 'account') and waits until it is drawn and nothing moves any more.
async function openGroup(target, id) {
  await target.locator('#h5-settings').waitFor({ state: 'visible' });
  await target.locator(`#h5-settings-group-${id}`).waitFor({ state: 'visible' }).catch(() => {}); // the phone's list is under an open page
  if (await groupShown(target, id)) return;
  if (!(await wideLayout(target))) await backToList(target);
  await target.locator(`#h5-settings-group-${id}`).click();
  await target.waitForFunction(group => {
    const node = document.getElementById(`h5-set-${group}`);
    if (!node || node.hidden) return false;
    const page = document.getElementById('h5-settings-page');
    return !page || !page.contains(node) || !page.classList.contains('MuiModal-hidden');
  }, id);
  await settled(pageOf(target));
}

// On a phone: back from a group's page to the group list (nothing to do when the list is shown, or on a computer).
async function backToList(target) {
  if (await wideLayout(target)) return;
  const open = await target.evaluate(() => { const page = document.getElementById('h5-settings-page'); return Boolean(page && !page.classList.contains('MuiModal-hidden')); });
  if (!open) return;
  await target.locator('#h5-settings-back').click();
  await target.waitForFunction(() => { const page = document.getElementById('h5-settings-page'); return !page || page.classList.contains('MuiModal-hidden'); });
  await settled(pageOf(target));
}

// The groups in the group list, in order (their ids), and their titles: a group with nothing in the chosen device tab is not listed.
const listedGroups = target => target.locator('#h5-settings-groups .h5-settings-group-item').evaluateAll(nodes => nodes.map(node => node.dataset.group));
const listedTitles = target => target.locator('#h5-settings-groups .h5-settings-group-item .MuiListItemText-primary').allTextContents();

// Runs one action of a device row's "more" menu (Engines.jsx): `engine` is 'local' or a remote engine's id, `action` the class of the menu item
// ('h5-engine-rename', 'h5-engine-check', 'h5-engine-update', 'h5-engine-edit', 'h5-engine-remove').
async function engineAction(target, engine, action) {
  await target.locator(`.h5-engine-row[data-engine="${engine}"] .h5-engine-more`).click();
  const item = target.locator(`#h5-engine-menu-${engine} .${action}`);
  await item.waitFor({ state: 'visible' });
  await settled(pageOf(target));
  await item.click();
  await target.locator(`#h5-engine-menu-${engine} .${action}`).waitFor({ state: 'detached' }).catch(() => {});
}
// The actions a device row's menu offers (the classes of its items), closing the menu again.
async function engineActions(target, engine) {
  await target.locator(`.h5-engine-row[data-engine="${engine}"] .h5-engine-more`).click();
  await target.locator(`#h5-engine-menu-${engine} [role="menuitem"]`).first().waitFor({ state: 'visible' });
  const names = await target.locator(`#h5-engine-menu-${engine} [role="menuitem"]`).evaluateAll(nodes => nodes.map(node => [...node.classList].find(name => name.startsWith('h5-engine-'))));
  await pageOf(target).keyboard.press('Escape');
  await target.locator(`#h5-engine-menu-${engine} [role="menuitem"]`).first().waitFor({ state: 'detached' }).catch(() => {});
  return names;
}

module.exports = { openGroup, backToList, groupShown, listedGroups, listedTitles, engineAction, engineActions, wideLayout };
