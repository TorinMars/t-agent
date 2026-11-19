// The shell's door to browser storage: the registry public/js/local-keys.js (`window.TALocalKeys`, loaded first by the page), where every key is
// declared with its reason. Without it (a harness that loads the shell alone, a unit test) nothing is kept.
const registry = () => globalThis.TALocalKeys || null;
export const localGet = (key, area = 'local') => { const keys = registry(); return keys ? keys.get(key, area) : null; };
export const localSet = (key, value, area = 'local') => { const keys = registry(); return keys ? keys.set(key, value, area) : false; };
export const localForget = prefix => { const keys = registry(); return keys ? keys.forget(prefix) : 0; };
export const localStorageOf = (area = 'local') => { const keys = registry(); return keys ? keys.storage(area) : null; };
