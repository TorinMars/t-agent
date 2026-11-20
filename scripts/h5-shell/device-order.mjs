// The one order of devices on every page, whichever engine serves it ("Devices in one order" in docs/design/entry-symmetry.md): by name, numbers in
// names by value ("M2" before "m10"), any case; then by the engine's instance id, so two devices with the same name keep one order too; the page's own
// source key ('local', 'remote:7') only last, for a device whose instance id is not known (an older engine). "This machine" has no place of its own.
// Used by h5.js (`H5UI.orderDevices`: the task list's devices, and through them "Create on", the mind maps and T-Attention), Settings → Devices
// (Engines.jsx), the device tabs of Settings (settings-tabs.mjs), "Visible to" and the Environment table (environment-compare.mjs). Pure.

// A fixed locale, not the browser's: a phone in Chinese and a computer in English must still agree.
const byName = (a, b) => String(a || '').trim().localeCompare(String(b || '').trim(), 'en', { numeric: true, sensitivity: 'base' });
const byText = (a, b) => (String(a || '') < String(b || '') ? -1 : String(a || '') > String(b || '') ? 1 : 0);

// `a`, `b`: { name, instanceId, key }.
export function compareDevices(a, b) {
  return byName(a.name, b.name) || byText(a.instanceId, b.instanceId) || byText(a.key, b.key);
}

// `list` in the one order (a new array). `describe(item)` gives { name, instanceId, key } of an item; by default the item itself.
export function orderDevices(list, describe = item => item) {
  const rows = (Array.isArray(list) ? list : []).map((item, index) => ({ item, index, shown: describe(item) || {} }));
  rows.sort((a, b) => compareDevices(a.shown, b.shown) || a.index - b.index);
  return rows.map(row => row.item);
}
