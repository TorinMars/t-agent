// Reading the page store (store.mjs) from a component: each part subscribes to the slice it draws, so a change elsewhere does not draw it again.
import { useRef, useSyncExternalStore } from 'react';
import { shallowEqual } from './store.mjs';

// `selector(state)` picks what the component draws; it is drawn again only when `equal(before, now)` is false (Object.is by default, `shallowEqual`
// for a selector that builds an object). The last answer is kept, so an unchanged slice returns the very same value (what useSyncExternalStore needs).
export function useStore(ui, selector, equal = Object.is) {
  const memo = useRef(null);
  const snapshot = () => {
    const state = ui.get();
    const last = memo.current;
    if (last && last.state === state && last.selector === selector) return last.value;
    const value = selector(state);
    if (last && equal(last.value, value)) { memo.current = { state, selector, value: last.value }; return last.value; }
    memo.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(ui.subscribe, snapshot);
}

// The named top-level keys of the state as one object (the shape the components read as `state.x`), drawn again only when one of them changed.
// `keys` is a constant array of the module.
export function useStoreKeys(ui, keys) {
  return useStore(ui, state => {
    const slice = {};
    for (const key of keys) slice[key] = state[key];
    return slice;
  }, shallowEqual);
}

// A render counter for the browser tests (scripts/test-h5-render-count-browser.cjs): only when the page was given `window.__h5RenderCounts` before it
// loaded; otherwise it does nothing.
const counts = typeof window !== 'undefined' && window.__h5RenderCounts && typeof window.__h5RenderCounts === 'object' ? window.__h5RenderCounts : null;
export const countRender = counts ? name => { counts[name] = (counts[name] || 0) + 1; } : () => {};
