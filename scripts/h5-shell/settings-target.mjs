// Which folding group of the settings sheet (Settings.jsx) to open, and which part of it to show, for `ui.actions.openSettings(id)` (h5.js).
// The groups: tasks-files, voice-translate, devices, attention, account. A part ("section", `#h5-sec-<id>`) has an id that is unique in the whole
// sheet, so a section id alone is enough. The groups before the sheet was tidied up (engines, service-links, rule-sync, remote, workdir, oss,
// translate, voice, access) are kept as aliases of the group and section that took their place.
export const SETTINGS_GROUPS = ['tasks-files', 'voice-translate', 'devices', 'attention', 'account'];

const SECTIONS = {
  workdir: 'tasks-files', oss: 'tasks-files',
  voice: 'voice-translate', translate: 'voice-translate',
  link: 'devices', 'peer-fs': 'devices', 'rule-sync': 'devices', advanced: 'devices', connect: 'devices', remote: 'devices',
  access: 'account', authenticator: 'account',
};
// Old group ids that are not a section id of their own.
const ALIASES = { engines: ['devices', ''], 'service-links': ['devices', 'link'] };

// The parts of the Devices group that sit inside its folded "Advanced" part: opening one of them opens "Advanced" too.
export const ADVANCED_SECTIONS = new Set(['advanced', 'connect', 'remote']);

// { group, section } for an id, or null for an unknown one (the sheet then opens with every group folded). `section` is '' for the top of the group.
export function settingsTarget(id) {
  if (typeof id !== 'string' || !id) return null;
  if (SETTINGS_GROUPS.includes(id)) return { group: id, section: '' };
  if (Object.hasOwn(ALIASES, id)) return { group: ALIASES[id][0], section: ALIASES[id][1] };
  if (Object.hasOwn(SECTIONS, id)) return { group: SECTIONS[id], section: id };
  return null;
}
