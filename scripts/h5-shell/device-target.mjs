// Which device the per-device parts of the settings sheet read and write ("Settings of a linked device" in DESIGN.md): this device, or a linked
// device chosen in "Settings for" at the top of the sheet (DeviceTarget.jsx). Data: GET /api/device-settings/devices
//   { devices: [{ id, name, online, supported }] }   (`id` is the remote_servers row; `supported` true, false for an older version, null when unknown)
// A call of a part goes to its own /api path for this device, and to /api/device-settings/<id><path without /api> for a linked one, which the
// server forwards to that device's allowlisted /v1/device-settings routes (routes/device-settings.js). Pure functions, no React; `t` translates.

const plain = text => text;
export const STORAGE_KEY = 't-agent.settings-device';

// The answer of the route; null, an older server (404) or anything malformed is no device.
export function normalizeDevices(data) {
  const list = data && Array.isArray(data.devices) ? data.devices : [];
  return list
    .filter(device => device && Number.isSafeInteger(device.id) && device.id > 0 && typeof device.name === 'string' && device.name)
    .map(device => ({ id: device.id, name: device.name, online: device.online !== false, supported: device.supported === true ? true : device.supported === false ? false : null }));
}

// Whether a device can be chosen: one that has the feature (online or not; a call to an offline one says so).
export const selectable = device => Boolean(device && device.supported === true);

// The selector is shown when at least one linked device has the feature.
export const selectorShown = devices => Array.isArray(devices) && devices.some(selectable);

// The device to use: the remembered id when that device is still linked and has the feature, else this device (null).
export function pickDevice(stored, devices) {
  const id = Number(stored);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const device = (devices || []).find(item => item.id === id);
  return selectable(device) ? device : null;
}

// The URL of one call of a part. `device` null: the page's own URL. A linked device: its path without the leading /api (GET /auth/me stays /auth/me).
export function devicePath(device, url) {
  if (!device) return url;
  const path = String(url).replace(/^\/api(?=\/)/, '');
  return `/api/device-settings/${device.id}${path}`;
}

// The text of one option of the selector.
export function optionText(device, { t = plain } = {}) {
  if (!device) return t('This device');
  if (device.supported === false) return `${device.name} (${t(`Update ${device.name} first`)})`;
  if (device.supported === null) return `${device.name} (${t('Offline')})`;
  return device.online ? device.name : `${device.name} (${t('Offline')})`;
}

// The scope label of a per-device part while a linked device is chosen ("K01 only"), and its title. `name` empty: this device.
export const deviceScopeText = name => (name ? `${name} only` : 'This device only');
export const deviceScopeTitle = name => (name ? `Only ${name} uses this. Changes here are saved on ${name}.` : 'Only this device uses this');
// The note of a part that cannot be changed from another device.
export const ownPageText = name => `Open ${name}’s own page to change this`;

// localStorage, which may be missing or refuse (a private window): every access is guarded.
export function readStored(storage) {
  try { return storage ? storage.getItem(STORAGE_KEY) : null; } catch { return null; }
}
export function writeStored(storage, id) {
  try {
    if (!storage) return;
    if (id) storage.setItem(STORAGE_KEY, String(id)); else storage.removeItem(STORAGE_KEY);
  } catch { /* the choice is not remembered */ }
}
