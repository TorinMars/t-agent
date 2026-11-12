import { useSyncExternalStore } from 'react';
import Box from '@mui/material/Box';
import TextField from './TextField.jsx';
import { api, t } from './common.jsx';
import { Hint } from './Form.jsx';
import { devicePath, normalizeDevices, optionText, ownPageText, pickDevice, readStored, selectable, selectorShown, writeStored } from './device-target.mjs';

// "Settings for" at the top of the settings sheet, and the one place that decides where the per-device parts read and write ("Settings of a linked
// device" in DESIGN.md). A per-device part takes `useDeviceTarget()`:
//   { device, remote, name, key, api }   device: null (this device) or { id, name, online, supported }; `api(method, url, body)` is `api` of
//                                        common.jsx with the URL of the chosen device (device-target.mjs devicePath); `key` changes with the choice.
// A part keyed by `key` is drawn again from scratch when the choice changes, and reads that device's values (its group is open, so `opened` > 0).
// Parts that cannot be changed from another device draw `<LocalOnly>` around their controls: with a linked device chosen they show
// "Open K01's own page to change this" instead. The list of devices is read when the sheet opens (GET /api/device-settings/devices; an older server
// answers 404 and nothing is drawn). The choice is this viewer's own (localStorage, guarded), and goes back to this device when the chosen device is
// no longer linked or no longer has the feature.
const DEVICES_URL = '/api/device-settings/devices';
const storage = () => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

const cachedApis = new Map();
function targetOf(device) {
  if (!device) return { device: null, remote: false, name: '', key: 'local', api };
  const key = `remote:${device.id}`;
  if (!cachedApis.has(key)) cachedApis.set(key, (method, url, body) => api(method, devicePath(device, url), body));
  return { device, remote: true, name: device.name, key, api: cachedApis.get(key) };
}

let snapshot = { loaded: false, devices: [], target: targetOf(null) };
const listeners = new Set();
const emit = next => { snapshot = next; for (const listener of listeners) listener(); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

// Keeps the same target object while the chosen device and its state are the same, so that parts keyed by it are not drawn again for nothing.
function withDevice(devices, device) {
  const current = snapshot.target.device;
  const same = current && device && current.id === device.id && current.name === device.name && current.online === device.online;
  return { loaded: true, devices, target: same || (!current && !device) ? snapshot.target : targetOf(device) };
}

let reading = null;
export function refreshDeviceTargets() {
  if (reading) return reading;
  reading = (async () => {
    let devices = snapshot.devices;
    try { devices = normalizeDevices(await api('GET', DEVICES_URL)); }
    catch (error) { if (error.status === 404) devices = []; }
    const wanted = snapshot.target.device ? snapshot.target.device.id : readStored(storage());
    const device = pickDevice(wanted, devices);
    if (!device && wanted) writeStored(storage(), null); // the device went away: back to this device
    emit(withDevice(devices, device));
  })().finally(() => { reading = null; });
  return reading;
}

export function chooseDevice(id) {
  const device = pickDevice(id, snapshot.devices);
  writeStored(storage(), device ? device.id : null);
  emit(withDevice(snapshot.devices, device));
}

export const useDeviceTargets = () => useSyncExternalStore(subscribe, () => snapshot);
export const useDeviceTarget = () => useSyncExternalStore(subscribe, () => snapshot.target);

// The note of a part that cannot be changed from another device.
export function OwnPageNote({ id }) {
  const { name } = useDeviceTarget();
  return <Hint id={id}><Box component="span" className="h5-own-page-note">{t(ownPageText(name))}</Box></Hint>;
}
// The controls of this device, or the note while a linked device is chosen.
export function LocalOnly({ id, children }) {
  const { remote } = useDeviceTarget();
  return remote ? <OwnPageNote id={id} /> : children;
}

// The row at the top of the sheet. Drawn only when a linked device has the feature; an older one is listed but cannot be chosen.
export function DeviceSelector() {
  const { devices, target } = useDeviceTargets();
  if (!selectorShown(devices)) return null;
  const value = target.device ? String(target.device.id) : '';
  return (
    <Box id="h5-settings-device" sx={{ display: 'flex', flexDirection: 'column', gap: 1, px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
      <TextField
        id="h5-settings-device-select" select label={t('Settings for')} size="small" fullWidth value={value}
        onChange={event => chooseDevice(event.target.value)} slotProps={{ select: { native: true }, htmlInput: { translate: 'no' } }}
      >
        <option value="">{optionText(null, { t })}</option>
        {devices.map(device => <option key={device.id} value={String(device.id)} disabled={!selectable(device)}>{optionText(device, { t })}</option>)}
      </TextField>
      {target.remote ? (
        <Hint id="h5-settings-device-hint">{t(`Parts marked “${target.name} only” are read and saved on ${target.name}. Shared parts are the same on every device.`)}</Hint>
      ) : null}
    </Box>
  );
}
