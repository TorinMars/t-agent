// Waits for the headless browser scripts (scripts/test-*-browser.cjs). Not a test itself: the name stays outside the `test-*-browser.cjs` pattern of npm test.
// Wait for what the page does, never for a fixed time: a fixed sleep is longer than needed on an idle machine and too short on a loaded one (npm test
// runs four scripts at a time), which made taps land on a sheet that was still sliding in.

// No finite animation or transition is running: a sheet has finished sliding in, a dialog fading in, a menu growing. Call it after waiting for what the
// action shows (the sheet's first row, the dialog's first button): its transition has started by then. Endless animations (a spinner, a pulsing dot)
// are ignored, and so is the ripple of a pressed MUI button (550 ms, longer than the sheet or dialog itself, and it never moves anything).
async function settled(page, { timeout = 10000 } = {}) {
  await page.waitForFunction(() => !document.getAnimations().some(animation => {
    if (animation.playState !== 'running' || !animation.effect || animation.effect.getComputedTiming().iterations === Infinity) return false;
    const target = animation.effect.target;
    return !(target && target.closest && target.closest('.MuiTouchRipple-root'));
  }), null, { timeout });
}

module.exports = { settled };
