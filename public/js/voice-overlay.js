// The hold-to-talk screen of the phone page: a dimmed page, a bubble with a live level meter, and three zones. Letting go over the
// bottom arc sends, over the left pill cancels and over the right pill only converts the speech to text. voice-input.js drives it.
const VoiceOverlay = (() => {
  const BARS = 28;
  const SLOP = 28; // the pills react a little outside their edges, so a thumb does not have to be exact
  const tr = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
  const LABELS = { send: 'Release to send', cancel: 'Release to cancel', text: 'Release to convert to text' };

  function create() {
    let root, bubble, bars, cancelPill, textPill, hint;
    let levels = new Array(BARS).fill(0);
    let current = 'send';
    function build() {
      root = document.createElement('div');
      root.className = 'vo-overlay';
      root.hidden = true;
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      bubble = document.createElement('div');
      bubble.className = 'vo-bubble';
      const meter = document.createElement('div');
      meter.className = 'vo-meter';
      bars = Array.from({ length: BARS }, () => { const bar = document.createElement('i'); meter.append(bar); return bar; });
      bubble.append(meter);
      const pills = document.createElement('div');
      pills.className = 'vo-pills';
      cancelPill = document.createElement('div');
      cancelPill.className = 'vo-pill vo-cancel';
      cancelPill.textContent = tr('Cancel');
      textPill = document.createElement('div');
      textPill.className = 'vo-pill vo-text';
      textPill.textContent = tr('Convert to Text');
      pills.append(cancelPill, textPill);
      const arc = document.createElement('div');
      arc.className = 'vo-arc';
      hint = document.createElement('span');
      arc.append(hint);
      root.append(bubble, pills, arc);
      document.body.append(root);
    }
    function paint() {
      bars.forEach((bar, index) => { bar.style.height = `${Math.max(4, Math.round(levels[index] * 34))}px`; });
    }
    return {
      show() {
        if (!root) build();
        levels = new Array(BARS).fill(0);
        paint();
        root.hidden = false;
        this.zone('send');
      },
      hide() { if (root) root.hidden = true; },
      // `rms` is the loudness of one audio block, 0 to 1; speech is mostly well below 0.3, so it is scaled up.
      level(rms) {
        if (!root || root.hidden) return;
        levels.shift();
        levels.push(Math.min(1, Math.sqrt(rms) * 1.6));
        paint();
      },
      zone(next) {
        if (!root) return;
        current = next;
        root.dataset.zone = next;
        cancelPill.classList.toggle('active', next === 'cancel');
        textPill.classList.toggle('active', next === 'text');
        hint.textContent = tr(LABELS[next]);
      },
      zoneAt(x, y) {
        if (!root || root.hidden) return 'send';
        const inside = (el, margin) => {
          const box = el.getBoundingClientRect();
          return x >= box.left - margin && x <= box.right + margin && y >= box.top - margin && y <= box.bottom + margin;
        };
        if (inside(cancelPill, SLOP)) return 'cancel';
        if (inside(textPill, SLOP)) return 'text';
        return 'send';
      },
      get current() { return current; },
    };
  }
  return { create };
})();
if (typeof window !== 'undefined') window.VoiceOverlay = VoiceOverlay;
if (typeof module !== 'undefined' && module.exports) module.exports = VoiceOverlay;
