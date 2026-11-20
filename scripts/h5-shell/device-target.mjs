// Which device the per-device parts of the settings sheet read and write ("Settings of a linked device" in docs/design/linked-device-settings.md): this device, or a linked
// device whose tab is chosen at the top of the sheet (DeviceTarget.jsx, settings-tabs.mjs). Data: GET /api/device-settings/devices
//   { devices: [{ id, name, online, supported, company_computer, environment }] }   (`id` is the remote_servers row; `supported` true, false for an
//   older version, null when unknown; `company_computer` the device's "Company computer" flag, null when unknown or too old; `environment` whether
//   its tools list can be read for Settings → Devices → Environment, null when unknown)
// A call of a part goes to its own /api path for this device, and to /api/device-settings/<id><path without /api> for a linked one, which the
// server forwards to that device's allowlisted /v1/device-settings routes (routes/device-settings.js). Pure functions, no React; `t` translates.

// The answer of the route; null, an older server (404) or anything malformed is no device.
export function normalizeDevices(data) {
  const list = data && Array.isArray(data.devices) ? data.devices : [];
  return list
    .filter(device => device && Number.isSafeInteger(device.id) && device.id > 0 && typeof device.name === 'string' && device.name)
    .map(device => ({
      id: device.id, name: device.name, online: device.online !== false, supported: device.supported === true ? true : device.supported === false ? false : null,
      company_computer: typeof device.company_computer === 'boolean' ? device.company_computer : null,
      environment: typeof device.environment === 'boolean' ? device.environment : null,
    }));
}

// Whether a device's tab can be chosen: one that has the feature (online or not; a call to an offline one says so).
export const selectable = device => Boolean(device && device.supported === true);

// The URL of one call of a part. `device` null: the page's own URL. A linked device: its path without the leading /api (GET /auth/me stays /auth/me).
export function devicePath(device, url) {
  if (!device) return url;
  const path = String(url).replace(/^\/api(?=\/)/, '');
  return `/api/device-settings/${device.id}${path}`;
}

// The scope label of a per-device part while a linked device's tab is chosen ("K01 only"), and its title. `name` empty: this device.
export const deviceScopeText = name => (name ? `${name} only` : 'This device only');
export const deviceScopeTitle = name => (name ? `Only ${name} uses this. Changes here are saved on ${name}.` : 'Only this device uses this');
// The note of a part that cannot be changed from another device.
export const ownPageText = name => `Open ${name}’s own page to change this`;

// The "Company computer" switch of a device row in Settings → Devices ("Device tier" in docs/design/linked-device-settings.md; the meaning in
// "Company computer" of docs/design/learn-english.md). Why a linked device's switch cannot be used: 'offline' (not online, or not known),
// 'update' (too old: no `settings:device`, or its /v1/info has no `device:tier`), '' when it can.
export function tierBlock(device) {
  if (!device || !device.online || device.supported === null) return 'offline';
  if (device.supported === false || device.company_computer === null) return 'update';
  return '';
}

// The machine that keeps the person's own data for a marked one, by the rule of the server as far as this page can see it ('' when it cannot be
// told). `row`: 'local' or a linked device's id; `local`: { name, company } of this machine (`company` null when unknown); `devices`: the linked
// devices of normalizeDevices, oldest link first. For this machine: the first normal linked device that is online, else the first normal one. For a
// linked device: this machine, when it is normal and no other linked device is known to be normal (that device could be the home too).
export function tierHome(row, { local = {}, devices = [] } = {}) {
  const normal = (devices || []).filter(device => device.company_computer === false && String(device.id) !== String(row));
  if (row === 'local') return ((normal.find(device => device.online) || normal[0] || {}).name) || '';
  return local.company === false && !normal.length ? local.name || '' : '';
}

// The line under the switch (English; the page translates it). `name`: the device of the row; `home`: tierHome's answer.
export function tierCaption({ on, home = '', block = '', name = '' }) {
  if (block === 'offline') return `${name} is offline. This can be changed once it is back online.`;
  if (block === 'update') return `Update ${name} first`;
  if (!on) return 'Keeps your personal data, such as learning progress.';
  return home ? `Personal data stays on ${home}. Kept here only while no other machine can be reached.`
    : 'Personal data stays on your other machines. Kept here only while none of them can be reached.';
}
