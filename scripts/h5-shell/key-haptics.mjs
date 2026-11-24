// Vibration on key taps ("Vibration on key taps" in docs/design/key-haptics.md): how strongly the page's own keys vibrate on this device
// (the keyboards of Osk.jsx and the key row of Terminal.jsx, played by key-feedback.mjs `tick`), chosen in Settings → Keyboard (KeyboardSettings.jsx).
// Pure parts and the stored choice, no React: the strengths and their durations, the stored value and its default, and what this device can play.
// Kept in this browser (`h5-key-haptics`, public/js/local-keys.js): vibration is a property of the device in the hand, so each device keeps its own
// choice (allowed per-device state in "One experience on every device and engine" of AGENTS.md).
import { localGet, localSet } from './local-keys.mjs';

export const HAPTICS_KEY = 'h5-key-haptics';
// The choices of a device that can vary the vibration (Android: navigator.vibrate), in their order; `ms` is the length of one vibration.
export const STRENGTHS = [
  { id: 'off', label: 'Off', note: 'No vibration', ms: 0 },
  { id: 'light', label: 'Light', note: 'A short tap (as today)', ms: 8 },
  { id: 'medium', label: 'Medium', note: 'A firmer tap', ms: 15 },
  { id: 'strong', label: 'Strong', note: 'A clear buzz', ms: 28 },
];
// Light is the 8 ms tick the keys played before there was a choice.
export const DEFAULT_STRENGTH = 'light';

// A stored or given value as one of the strengths: anything else (nothing stored, an old or broken value) is the default.
export const normalizeStrength = value => (STRENGTHS.some(item => item.id === value) ? value : DEFAULT_STRENGTH);
// The vibration of a strength in milliseconds; 0 for Off.
export const durationOf = strength => STRENGTHS.find(item => item.id === normalizeStrength(strength)).ms;
// Whether a strength plays anything (the iOS switch is on for every strength but Off).
export const hapticsOn = strength => durationOf(strength) > 0;

// The choice of this device, read at each key press (so a change in Settings applies at once). `storage`: a Storage-like object for a test.
export function readStrength(storage = null) {
  try { return normalizeStrength(storage ? storage.getItem(HAPTICS_KEY) : localGet(HAPTICS_KEY)); } catch { return DEFAULT_STRENGTH; }
}
// Keeps a choice; false when the browser refused to keep it (private mode, blocked storage: the default comes back with the next page).
export function writeStrength(strength, storage = null) {
  const value = normalizeStrength(strength);
  try {
    if (storage) { storage.setItem(HAPTICS_KEY, value); return true; }
    return localSet(HAPTICS_KEY, value);
  } catch { return false; }
}

// What this device can play: 'vibrate' (the Vibration API on a touch screen: Android, so the strength can vary), 'switch' (no Vibration API, but
// WebKit's switch control on a touch screen: iPhone and iPad from iOS 17.4, which play one system tap when it toggles, so only on or off), or
// 'none' (a computer: desktop Chrome has navigator.vibrate but nothing to vibrate, and Safari on a Mac has the switch but no haptic). `env`: the
// global object (a test passes its own { navigator, document }).
export function hapticKind(env = globalThis) {
  try {
    const nav = env && env.navigator;
    if (!nav || !(Number(nav.maxTouchPoints) > 0)) return 'none';
    if (typeof nav.vibrate === 'function') return 'vibrate';
    const doc = env.document;
    if (doc && typeof doc.createElement === 'function' && 'switch' in doc.createElement('input')) return 'switch';
    return 'none';
  } catch { return 'none'; }
}
