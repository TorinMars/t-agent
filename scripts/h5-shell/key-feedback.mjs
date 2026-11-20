// The feel of the page's own keyboard (Osk.jsx `Keyboard`: the terminal's and the Learn page's): a short haptic tick on every key press and, while a
// character key is held, a bubble above it with the character drawn larger, like a phone keyboard. A small chunk of its own, loaded the first time a
// key is pressed (Osk.jsx `feel`), so the first screen only carries the call. See "The page's own keyboard" in docs/design/learn-english-page.md.
// - Haptic (`tick`): navigator.vibrate(8) where it exists (Android); iOS Safari has no Vibration API, so on iOS 17.4+ a visually hidden
//   <input type="checkbox" switch> is toggled through its <label> (the switch plays the system haptic). Feature-detected, never throws, keeps the
//   focus where it was and never scrolls. Osk.jsx calls it on pointerdown only, so a held Backspace ticks once, not on each repeat.
// - Bubble: one element for the whole page, fixed in the viewport and appended to <body>, so no keyboard box or scrolling page can clip it and the
//   layout never moves; `aria-hidden`, no pointer events. Only keys with a character (`data-char`): never Shift, Backspace, Space, Enter, 123, Hide.

let iosSwitch = null;
function hapticSwitch() {
  if (iosSwitch !== null) return iosSwitch;
  iosSwitch = false;
  try {
    const input = document.createElement('input');
    if (!('switch' in input)) return iosSwitch; // only WebKit with the switch control (iOS 17.4+)
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    input.id = 'h5-key-haptic';
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    label.append(input);
    document.body.append(label);
    iosSwitch = label;
  } catch { iosSwitch = false; }
  return iosSwitch;
}

export function tick() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') { navigator.vibrate(8); return 'vibrate'; }
    const label = hapticSwitch();
    if (!label) return null;
    const had = document.activeElement;
    label.click();
    if (had && document.activeElement !== had && typeof had.focus === 'function') had.focus({ preventScroll: true });
    return 'switch';
  } catch { return null; }
}

let bubble = null;
const rgba = text => (String(text).match(/[\d.]+/g) || []).map(Number);
// The bubble's colour: the key's colour one step lighter, made opaque over the page background (the key itself is a see-through overlay).
function bubbleColour(key) {
  const [r = 255, g = 255, b = 255, a = 1] = rgba(getComputedStyle(key).backgroundColor);
  const [br = 18, bg = 18, bb = 18] = rgba(getComputedStyle(document.body).backgroundColor);
  const dark = br + bg + bb < 384;
  const alpha = Math.min(1, dark ? a + 0.1 : Math.max(0, a - 0.04));
  const mix = (top, under) => Math.round(top * alpha + under * (1 - alpha));
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`;
}

export function showBubble(key) {
  if (!key || !key.dataset || !key.dataset.char) return null;
  if (!bubble || !bubble.isConnected) {
    bubble = document.createElement('div');
    bubble.className = 'h5-key-bubble';
    bubble.setAttribute('aria-hidden', 'true');
    document.body.append(bubble);
  }
  const rect = key.getBoundingClientRect();
  const box = (key.closest('[role="group"]') || key).getBoundingClientRect();
  const style = getComputedStyle(key);
  const height = Math.round(rect.height * 1.3);
  bubble.textContent = key.textContent;
  bubble.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'z-index:2000', 'pointer-events:none', 'box-sizing:border-box', 'display:flex', 'align-items:center',
    'justify-content:center', `min-width:${Math.round(rect.width * 1.3)}px`, `height:${height}px`, 'padding:0 8px', 'border-radius:8px',
    'box-shadow:0 2px 4px -1px rgba(0,0,0,.2),0 4px 5px 0 rgba(0,0,0,.14),0 1px 10px 0 rgba(0,0,0,.12)',
    `background:${bubbleColour(key)}`, `color:${style.color}`, `font-family:${style.fontFamily}`, `font-size:${Math.round(parseFloat(style.fontSize || '20') * 1.5)}px`,
    'line-height:1', 'white-space:pre',
  ].join(';');
  const width = bubble.offsetWidth;
  // Centred over the key, kept inside the keyboard's width at the edges, its bottom just above the key's top.
  const left = Math.max(box.left, Math.min(rect.left + rect.width / 2 - width / 2, box.right - width));
  const top = Math.max(0, rect.top - height - 4);
  bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  return bubble;
}
export function hideBubble() { if (bubble) bubble.style.display = 'none'; }

// Osk.jsx: `down` true on pointerdown (tick and bubble), false on pointerup / pointercancel / leave.
export function feel(key, down) {
  try {
    if (!down) { hideBubble(); return; }
    tick();
    showBubble(key);
  } catch { /* the keyboard works without its feel */ }
}
