// The tabs at the top of the settings sheet ("Settings of a linked device" in DESIGN.md): Shared, then this device, then each linked device. A tab
// shows only the parts whose changes belong to it: Shared holds the parts copied to every linked device (and Telegram, one setting with one sender),
// a device tab holds the "This device only" parts of that device (a linked device's are read and saved through /api/device-settings, DeviceTarget.jsx).
// Pure functions, no React: which part is in which tab, which group has anything in a tab, the tab a part opened from code needs, the tab entries and
// the remembered choice. `t` translates.
import { selectable } from './device-target.mjs';

const plain = text => text;
export const SHARED_TAB = 'shared';
export const LOCAL_TAB = 'local';
export const TAB_KEY = 't-agent.settings-tab';
const OLD_KEY = 't-agent.settings-device'; // the device chosen in "Settings for" before the tabs (a row id)

// Every part of the sheet: its group and its scope ('shared', 'telegram' or 'device'). The ids are the setting ids of GET /api/settings-sync where
// there is one, and the part ids of settings-target.mjs (every one of those is here, so opening a part from code knows its tab).
export const PARTS = {
  workdir: ['tasks-files', 'device'],
  oss: ['tasks-files', 'shared'], // with the tcli switch (oss-agent-access)
  'agent-skills': ['tasks-files', 'device'],
  'browser-ext': ['tasks-files', 'device'],
  'browser-sites': ['tasks-files', 'shared'],
  voice: ['voice-translate', 'shared'], // its "Enable voice input" checkbox is this browser's, labelled so, and stays with the part
  translate: ['voice-translate', 'shared'],
  'settings-sync': ['devices', 'shared'], // the status line of the shared settings, with "Sync now"
  'task-list-devices': ['devices', 'shared'], // "Show in task list"
  'engine-name': ['devices', 'device'], // the device list, where each row renames its own device
  link: ['devices', 'device'],
  'peer-fs': ['devices', 'device'],
  'rule-sync': ['devices', 'device'],
  advanced: ['devices', 'device'],
  connect: ['devices', 'device'],
  remote: ['devices', 'device'],
  'attention-guide': ['attention', 'device'],
  reminders: ['attention', 'device'],
  listeners: ['attention', 'device'],
  'plugin-market': ['attention', 'device'], // plugins are installed on this machine
  'notifier-plugins': ['attention', 'shared'],
  telegram: ['attention', 'telegram'],
  'notify-rules': ['attention', 'shared'],
  'widget-enabled': ['attention', 'device'],
  'widget-language': ['attention', 'shared'],
  'attention-summary': ['attention', 'shared'],
  'attention-skill': ['attention', 'device'], // the line that points to Agent skills
  'cli-tokens': ['attention', 'device'],
  access: ['account', 'device'],
  authenticator: ['account', 'device'],
};

// The scope of the parts a tab holds: 'shared' for Shared, 'device' for this device and every linked device, null when there are no tabs.
export function tabScope(tab) {
  if (tab === null || tab === undefined || tab === '') return null;
  return tab === SHARED_TAB ? 'shared' : 'device';
}
const holds = (scope, partScope) => (scope === 'shared' ? partScope === 'shared' || partScope === 'telegram' : partScope === scope);

// Whether a part is drawn in a tab of that scope. Without tabs (null) every part is drawn, as before the tabs. An unknown part is drawn everywhere.
export function partShown(id, scope) {
  if (!scope || !Object.hasOwn(PARTS, id)) return true;
  return holds(scope, PARTS[id][1]);
}
// Whether a group has any part in a tab of that scope (a group with nothing there is hidden).
export function groupShown(group, scope) {
  if (!scope) return true;
  return Object.values(PARTS).some(([of, partScope]) => of === group && holds(scope, partScope));
}

// The tab a target of `ui.actions.openSettings(id)` ({ group, section }, settings-target.mjs) needs, from the current tab. A part: the tab that holds
// it (a per-device part opens on this device's tab, whichever device was shown). A whole group: the current tab when it has parts of that group, else
// Shared when the group has shared parts, else this device. No tabs: null.
export function tabForTarget(target, current) {
  if (current === null || current === undefined) return null;
  if (!target) return current;
  if (target.section && Object.hasOwn(PARTS, target.section)) return holds('shared', PARTS[target.section][1]) ? SHARED_TAB : LOCAL_TAB;
  if (groupShown(target.group, tabScope(current))) return current;
  return groupShown(target.group, 'shared') ? SHARED_TAB : LOCAL_TAB;
}

// The tab to show: the remembered one when it still means something, else Shared. A device that is no longer linked is forgotten (`forget`); one that
// is linked but cannot be chosen now (an older version, or offline and not known) falls back to Shared for now and is kept.
export function resolveTab(stored, devices) {
  if (stored === LOCAL_TAB) return { tab: LOCAL_TAB, forget: false };
  const id = Number(stored);
  if (stored === null || stored === undefined || stored === SHARED_TAB || !/^\d+$/.test(String(stored)) || !Number.isSafeInteger(id) || id <= 0) return { tab: SHARED_TAB, forget: false };
  const device = (devices || []).find(item => item.id === id);
  if (!device) return { tab: SHARED_TAB, forget: true };
  return selectable(device) ? { tab: String(id), forget: false } : { tab: SHARED_TAB, forget: false };
}

// The device a tab stands for, or null for Shared and this device.
export function deviceOfTab(tab, devices) {
  if (tab === null || tab === SHARED_TAB || tab === LOCAL_TAB) return null;
  const device = (devices || []).find(item => String(item.id) === String(tab));
  return selectable(device) ? device : null;
}

// The entries of the tab row: { value, label, note, disabled, title, local }. `localName` is this device's engine name ('' on an older server: the
// tab then says just "This device"). A linked device that cannot be chosen is shown disabled with the reason under its name.
export function tabEntries(devices, { localName = '', t = plain } = {}) {
  const entries = [
    { value: SHARED_TAB, label: t('Shared'), note: '', disabled: false, title: t('Changes here are copied to every linked device'), local: false },
    { value: LOCAL_TAB, label: localName || t('This device'), note: localName ? t('This device') : '', disabled: false, title: t('Only this device uses these settings'), local: true },
  ];
  for (const device of devices || []) {
    const offline = device.supported === null || !device.online;
    const note = device.supported === false ? t(`Update ${device.name} first`) : offline ? t('Offline') : '';
    const title = device.supported === false ? t(`${device.name} is too old to be changed from here. Update ${device.name} first.`)
      : offline ? t(`${device.name} is offline. Its settings can be read and saved again once it is back online.`)
        : t(`These settings are read and saved on ${device.name}`);
    entries.push({ value: String(device.id), label: device.name, note, disabled: !selectable(device), title, local: false });
  }
  return entries;
}

// The line under the tab row: what a change in the chosen tab affects.
export function tabHint(tab, devices, { t = plain } = {}) {
  if (tab === null) return '';
  if (tab === SHARED_TAB) return t('Changes here are copied to every linked device');
  if (tab === LOCAL_TAB) return t('Only this device uses these settings');
  const device = deviceOfTab(tab, devices);
  if (!device) return '';
  return device.online ? t(`These settings are read and saved on ${device.name}`) : t(`${device.name} is offline. Its settings can be read and saved again once it is back online.`);
}

// Whether a scope label says nothing the tab does not say already: its scope is the tab's, and for a per-device label it names the tab's device (a
// label that stays "This device only" whichever device is shown, `follow` false, still says something in a linked device's tab).
export function labelRedundant({ scope, tabScope: current, follow = true, remote = false }) {
  if (!current || scope !== current) return false;
  return scope !== 'device' || follow || !remote;
}

// The remembered tab of this viewer (localStorage, which may be missing or refuse: every access is guarded). The device chosen in "Settings for"
// before the tabs is read once as that device's tab.
export function readTab(storage) {
  try {
    if (!storage) return null;
    const value = storage.getItem(TAB_KEY);
    if (value !== null) return value;
    const old = storage.getItem(OLD_KEY);
    return old === null ? null : old;
  } catch { return null; }
}
export function writeTab(storage, tab) {
  try {
    if (!storage) return;
    if (tab) storage.setItem(TAB_KEY, String(tab)); else storage.removeItem(TAB_KEY);
    storage.removeItem(OLD_KEY);
  } catch { /* the choice is not remembered */ }
}
