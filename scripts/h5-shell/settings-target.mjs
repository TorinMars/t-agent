// Which group of the Settings page (Settings.jsx) to show, and which part of it to bring into view, for `ui.actions.openSettings(id)` (h5.js).
// The groups: tasks-files, voice-translate, keyboard, devices, attention, account, usage-data. A part ("section", `#h5-sec-<id>`) has an id that is unique in the whole
// page, so a section id alone is enough. The groups before the page was tidied up (engines, service-links, rule-sync, remote, workdir, oss,
// translate, voice, access) are kept as aliases of the group and section that took their place, and so is `attention-skill` (the agent skill card
// that moved from T-Attention into "Agent skills" of Tasks and files).
// `GROUPS` is the group list of the page, in its order: the title, the one line under the title of the group's page (`description`) and the second
// line of its row in the list on a phone (`summary`). English; the page translates them.
export const GROUPS = [
  { id: 'tasks-files', title: 'Tasks and files', description: 'Where new tasks are kept, image and file upload, agent skills and the browser extension.', summary: 'Working directory, uploads, agent skills, browser' },
  { id: 'voice-translate', title: 'Voice and translation', description: 'Voice input and the service that translates what you type.', summary: 'Voice input, translation service' },
  { id: 'keyboard', title: 'Keyboard', description: 'How the page’s own keys feel on this device.', summary: 'Vibration on key taps' },
  { id: 'devices', title: 'Devices', description: 'Linked devices, how they connect, and what they share.', summary: 'Device list, linking, file access, rules sync' },
  { id: 'attention', title: 'T-Attention', description: 'Reminders, plugins and notifiers, the desktop window and CLI tokens.', summary: 'Reminders, plugins, desktop window, tokens' },
  { id: 'account', title: 'Account and access', description: 'Who can reach this service and how they sign in.', summary: 'Access mode, authenticator' },
  { id: 'usage-data', title: 'Usage data', description: 'Buttons used, where your time goes and what to remember. Kept on your own machines.', summary: 'Buttons, time, memories' },
];
export const SETTINGS_GROUPS = GROUPS.map(group => group.id);
export const groupInfo = id => GROUPS.find(group => group.id === id) || null;

const SECTIONS = {
  workdir: 'tasks-files', oss: 'tasks-files', 'agent-skills': 'tasks-files', 'browser-ext': 'tasks-files',
  voice: 'voice-translate', translate: 'voice-translate',
  'key-haptics': 'keyboard',
  link: 'devices', 'peer-fs': 'devices', 'sign-in': 'devices', 'rule-sync': 'devices', advanced: 'devices', connect: 'devices', remote: 'devices',
  access: 'account', authenticator: 'account',
  'usage-record': 'usage-data', 'usage-top': 'usage-data', 'usage-unused': 'usage-data', 'usage-store': 'usage-data',
  'usage-time': 'usage-data', 'usage-time-record': 'usage-data', 'usage-memories': 'usage-data', 'usage-digest': 'usage-data',
};
// Old group ids that are not a section id of their own.
const ALIASES = { engines: ['devices', ''], 'service-links': ['devices', 'link'], 'attention-skill': ['tasks-files', 'agent-skills'] };

// The parts of the Devices group that sit inside its folded "Advanced" part: opening one of them opens "Advanced" too.
export const ADVANCED_SECTIONS = new Set(['advanced', 'connect', 'remote']);

// { group, section } for an id, or null for an unknown one (the page then opens as it would without one: the first group on a computer, the group
// list on a phone). `section` is '' for the top of the group.
export function settingsTarget(id) {
  if (typeof id !== 'string' || !id) return null;
  if (SETTINGS_GROUPS.includes(id)) return { group: id, section: '' };
  if (Object.hasOwn(ALIASES, id)) return { group: ALIASES[id][0], section: ALIASES[id][1] };
  if (Object.hasOwn(SECTIONS, id)) return { group: SECTIONS[id], section: id };
  return null;
}
