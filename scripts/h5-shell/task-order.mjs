// The shared order of the one task list (`GET` / `PUT /api/task-order`, see "Task order" in DESIGN.md), and the device tag in front of a task name.
// Pure functions: h5.js reaches them as `H5UI.taskOrder` (entry.jsx), TaskDrawer.jsx imports them, test/h5-task-order.test.js checks them.
//
// A task key is `<instance id>:<task id>`. `order` is the list of keys the server keeps for the person; it can hold keys this page does not show
// (a hidden or offline device, a task not visible here), and those are kept where they are when the page saves a new order.

// The keys in `order` with no duplicates (the first place wins), so every rule below sees one place per key.
function unique(order) {
  const seen = new Set();
  return (Array.isArray(order) ? order : []).filter(key => typeof key === 'string' && !seen.has(key) && seen.add(key));
}

// The rows of the list in the shared order. `rows` are in today's order (this machine first, then each service, each in its own order), each with its
// `key` (null while its device has no instance id: an older Engine). Without an order (an older server, or none read yet) that order stays as it is.
// With one: the rows whose key is not in it come first (new or restored tasks), in today's order; then the rows in the order's order; then the rows
// without a key, which cannot be placed.
export function arrangeTasks(rows, order) {
  if (!Array.isArray(order)) return rows.slice();
  const at = new Map(unique(order).map((key, index) => [key, index]));
  const fresh = rows.filter(row => row.key && !at.has(row.key));
  const placed = rows.filter(row => row.key && at.has(row.key)).sort((a, b) => at.get(a.key) - at.get(b.key));
  const unplaced = rows.filter(row => !row.key);
  return [...fresh, ...placed, ...unplaced];
}

// `display` (the keys shown, in list order) with `key` taken out and put before (or, with `after`, after) `target`. null when nothing changes or a key is
// not shown.
export function moveKey(display, key, target, after = false) {
  if (!display.includes(key) || !display.includes(target)) return null;
  if (key === target) return null;
  const next = display.filter(item => item !== key);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, key);
  return next.every((item, index) => item === display[index]) ? null : next;
}

// Where a step of the task menu puts `key` ('top', 'up', 'down', 'bottom'), as the arguments of `moveKey`: { target, after }; null when it cannot go there.
export function stepTarget(display, key, step) {
  const index = display.indexOf(key);
  if (index < 0) return null;
  const last = display.length - 1;
  if (step === 'top') return index > 0 ? { target: display[0], after: false } : null;
  if (step === 'up') return index > 0 ? { target: display[index - 1], after: false } : null;
  if (step === 'down') return index < last ? { target: display[index + 1], after: true } : null;
  if (step === 'bottom') return index < last ? { target: display[last], after: true } : null;
  return null;
}

// The whole order to save after the shown keys went from `display` to `next` (the same keys, another order). The shown keys that were not in `order`
// (new tasks, shown first) are put at its start; then every place that held a shown key takes the next one of `next`, and every other key (a device that
// is hidden or offline, a task this page does not show) stays exactly in its place.
export function mergeOrder(order, display, next) {
  const kept = unique(order);
  const known = new Set(kept);
  const slots = [...display.filter(key => !known.has(key)), ...kept];
  const shown = new Set(display);
  let at = 0;
  return slots.map(key => (shown.has(key) ? next[at++] : key));
}

// Two orders are the same list of keys.
export const sameOrder = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((key, index) => key === b[index]);

// The device tag. Its colour comes from the device's instance id, so the same device has the same colour on every client: FNV-1a of the id picks one of
// a small fixed set. The colours are the 200 shades of the MUI palette, light enough on the dark theme's paper (#121212) under their own 16% tint for
// at least 4.5:1, WCAG AA (6:1 and more; test/h5-task-order.test.js checks it). A device without an id (an older Engine) gets the neutral tag.
export const TAG_COLORS = ['#90caf9', '#a5d6a7', '#ffcc80', '#ce93d8', '#80cbc4', '#f48fb1', '#fff59d', '#9fa8da'];
export const TAG_NEUTRAL = '#e0e0e0';
export const TAG_TINT = 0.16;
export function tagColorIndex(instanceId) {
  if (typeof instanceId !== 'string' || !instanceId) return -1;
  let hash = 0x811c9dc5;
  for (let index = 0; index < instanceId.length; index += 1) {
    hash ^= instanceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % TAG_COLORS.length;
}
export function tagColor(instanceId) {
  const index = tagColorIndex(instanceId);
  const color = index < 0 ? TAG_NEUTRAL : TAG_COLORS[index];
  const [r, g, b] = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16));
  return { index, color, background: `rgba(${r}, ${g}, ${b}, ${index < 0 ? 0.08 : TAG_TINT})` };
}

// The name on a tag: at most `max` characters (code points, so a Chinese name or an emoji is not cut in half), else `max - 1` and an ellipsis.
export function shortName(name, max = 8) {
  const chars = Array.from(String(name || '').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
