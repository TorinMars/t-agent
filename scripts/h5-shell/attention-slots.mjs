// SLOT for other parts of T-Attention in the Settings group "T-Attention" (AttentionSettings.jsx), for example the plugins (PluginSettings.jsx).
// A part registers its component once, from its own module:
//
//   import { registerAttentionSettings } from './attention-slots.mjs';
//   registerAttentionSettings({ id: 'plugins', order: 30, Component: PluginSlot });
//
// and its module is imported for that side effect in entry.jsx (the marked line "T-Attention settings slots"). The component gets { ui, opened } (the
// page store: `ui.notify`, `ui.actions`; `opened` counts the openings of the group, 0 before the first one: the group's content stays mounted while it
// is closed, so a component reads nothing while `opened` is 0) and draws its own content inside the group (headings, fields, buttons; reuse Form.jsx). When nothing is
// registered the group draws nothing extra. A second registration with the same id replaces the first.
const slots = new Map();

export function registerAttentionSettings({ id, order = 100, Component }) {
  if (!id || typeof Component !== 'function') throw new TypeError('registerAttentionSettings needs an id and a Component');
  slots.set(id, { id, order, Component });
}

export const attentionSettingsSlots = () => [...slots.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));

// Opens one plugin's page ({ kind, name }, see plugins-model.mjs) from outside the plugin list, for example the first-run guide. False while the list is not
// drawn yet (Settings was never opened). The list registers the opener and removes it with the function it gets back.
let pageOpener = null;
export function setAttentionPluginPageOpener(opener) {
  pageOpener = opener;
  return () => { if (pageOpener === opener) pageOpener = null; };
}
export const openAttentionPluginPage = page => Boolean(pageOpener && pageOpener(page));
