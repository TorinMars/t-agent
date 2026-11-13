import { useSyncExternalStore } from 'react';
import Box from '@mui/material/Box';
import { api, t } from './common.jsx';
import { Hint } from './Form.jsx';
import { devicePath, normalizeDevices, ownPageText } from './device-target.mjs';
import { deviceOfTab, partShown, readTab, resolveTab, tabScope, tabsShown, writeTab } from './settings-tabs.mjs';

// The tab chosen at the top of the settings sheet (SettingsTabs.jsx: Shared, this device, each linked device), and the one place that decides where the
// per-device parts read and write ("Settings of a linked device" in DESIGN.md). A per-device part takes `useDeviceTarget()`:
//   { device, remote, name, key, api }   device: null (this device) or { id, name, online, supported }; `api(method, url, body)` is `api` of
//                                        common.jsx with the URL of the chosen device (device-target.mjs devicePath); `key` changes with the choice.
// A part keyed by `key` is drawn again from scratch when the choice changes, and reads that device's values (its group is open, so `opened` > 0).
// Parts that cannot be changed from another device draw `<LocalOnly>` around their controls: in a linked device's tab they show
// "Open K01's own page to change this" instead. The list of devices is read when the sheet opens (GET /api/device-settings/devices; an older server
// answers 404: no linked device). The tabs are drawn once both the device list and the settings sync (`noteLinked`, from ScopeLabel.jsx) have
// answered, while the device list has a linked device or the settings sync shares with one. The settings sync decides only whether there is a Shared
// tab (`shared`): with the sync turned off, or no linked device in it, the tabs are this device and each linked device, and this device's tab draws
// every part. Without tabs `tab` is null, every part is drawn and the target is this device, so the sheet is as before. The choice is this viewer's
// own (localStorage, guarded); it starts on the first tab (Shared, or this device without it) and goes back there when the remembered device is no
// longer linked or cannot be chosen, or the remembered Shared tab is not there now (it stays remembered).
const DEVICES_URL = '/api/device-settings/devices';
const storage = () => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

const cachedApis = new Map();
function targetOf(device) {
  if (!device) return { device: null, remote: false, name: '', key: 'local', api };
  const key = `remote:${device.id}`;
  if (!cachedApis.has(key)) cachedApis.set(key, (method, url, body) => api(method, devicePath(device, url), body));
  return { device, remote: true, name: device.name, key, api: cachedApis.get(key) };
}

// `loaded`: the device list was read; `linked`: true / false once the settings sync was read (null before), true while it shares with a linked device;
// `shared`: there is a Shared tab; `tab`: null while there are no tabs; `scope`: the scope of the parts the tab holds (settings-tabs.mjs tabScope).
let snapshot = { loaded: false, linked: null, shared: false, devices: [], tab: null, scope: null, target: targetOf(null) };
let chosen = null; // the tab chosen on this page; null: not chosen yet, the remembered one is used
const listeners = new Set();
const emit = next => { snapshot = next; for (const listener of listeners) listener(); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

// The next state for these devices. Keeps the same target object while the chosen device and its state are the same, so that parts keyed by it are
// not drawn again for nothing.
function settle(devices, linked, loaded) {
  let tab = null;
  const { shown, shared } = tabsShown({ loaded, linked, devices });
  if (shown) {
    const wanted = chosen !== null ? chosen : readTab(storage());
    const resolved = resolveTab(wanted, devices, { shared });
    if (resolved.forget) { writeTab(storage(), null); chosen = null; } // the device went away: back to the first tab
    tab = resolved.tab;
  }
  const device = deviceOfTab(tab, devices);
  const current = snapshot.target.device;
  const same = current && device && current.id === device.id && current.name === device.name && current.online === device.online;
  return { loaded, linked, shared, devices, tab, scope: tabScope(tab, { shared }), target: same || (!current && !device) ? snapshot.target : targetOf(device) };
}

let reading = null;
export function refreshDeviceTargets() {
  if (reading) return reading;
  reading = (async () => {
    let devices = snapshot.devices;
    try { devices = normalizeDevices(await api('GET', DEVICES_URL)); }
    catch (error) { if (error.status === 404) devices = []; }
    emit(settle(devices, snapshot.linked, true));
  })().finally(() => { reading = null; });
  return reading;
}

// From the settings sync (ScopeLabel.jsx): whether it shares with a linked device, so there is a Shared tab.
export function noteLinked(linked) {
  if (snapshot.linked === linked) return;
  emit(settle(snapshot.devices, linked, snapshot.loaded));
}

// A tab chosen by the person (or by `ui.actions.openSettings(id)` for the part it opens): 'shared', 'local' or a device's id.
export function chooseTab(tab) {
  if (snapshot.tab === null) return;
  chosen = String(tab);
  writeTab(storage(), chosen);
  emit(settle(snapshot.devices, snapshot.linked, snapshot.loaded));
}

export const useDeviceTargets = () => useSyncExternalStore(subscribe, () => snapshot);
export const useDeviceTarget = () => useSyncExternalStore(subscribe, () => snapshot.target);
// The chosen tab ('shared', 'local', a device id, or null without tabs), the scope of the parts it holds ('shared', 'device' or null: every part)
// and whether there is a Shared tab.
const tabOf = () => snapshot.tab;
const scopeOfTab = () => snapshot.scope;
const sharedOf = () => snapshot.shared;
export function useSettingsTab() {
  const tab = useSyncExternalStore(subscribe, tabOf);
  const scope = useSyncExternalStore(subscribe, scopeOfTab);
  const shared = useSyncExternalStore(subscribe, sharedOf);
  return { tab, scope, shared };
}

// A part of the sheet (an id of settings-tabs.mjs PARTS), drawn only in the tabs that hold it, and always without tabs.
export function InTab({ part, children }) {
  const { scope } = useSettingsTab();
  return partShown(part, scope) ? children : null;
}

// The note of a part that cannot be changed from another device.
export function OwnPageNote({ id }) {
  const { name } = useDeviceTarget();
  return <Hint id={id}><Box component="span" className="h5-own-page-note">{t(ownPageText(name))}</Box></Hint>;
}
// The controls of this device, or the note while a linked device's tab is chosen.
export function LocalOnly({ id, children }) {
  const { remote } = useDeviceTarget();
  return remote ? <OwnPageNote id={id} /> : children;
}
