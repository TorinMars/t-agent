import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';

// The terminal's own on-screen keyboard (touch mode). The "Terminal keyboard" button of row 2 shows and hides it (`state.osk`, set by h5.js); the system
// keyboard is never opened for the terminal (its xterm textarea keeps inputmode="none"). It sits at the bottom of `#h5-bottom`, under row 2, where the
// system keyboard would be, and takes real room in the layout, so the terminal box gets shorter and refits (fewer rows) while it is shown.
// Every key goes through `ui.actions.key` (the same path as the function keys of row 1), so a latched Ctrl / Alt / Shift of row 1 applies to it (Ctrl+C, Ctrl+R).
// The keys are plain buttons that never take the focus: pointerdown is cancelled (no focus, no compatibility mouse events, no text selection), the box has
// `touch-action: none` (no double-tap zoom, no scroll), and the key is sent on pointerdown. Backspace repeats while it is held.
// Layout: a 20-column grid per row (one letter = 2 columns), so the second letter row is indented by half a key, like a phone keyboard.
const LETTERS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const SYMBOLS = {
  num: ['1234567890', '-/:;()$&@"', ".,?!'_~"],
  sym: ['[]{}#%^*+=', '\\|~<>`_-/@', ".,?!'\";"],
};
const LAYER_KEY = {
  abc: { layer: 'num', label: '123', aria: 'Numbers and symbols' },
  num: { layer: 'abc', label: 'ABC', aria: 'Letters' },
  sym: { layer: 'abc', label: 'ABC', aria: 'Letters' },
};
const SHIFT_SLOT = {
  num: { layer: 'sym', label: '#+=', aria: 'More symbols' },
  sym: { layer: 'num', label: '123', aria: 'Numbers and symbols' },
};
const DOUBLE_TAP_MS = 350; // a second Shift tap within this time turns on caps lock
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;

// `start`: the grid column of the first key (2 indents the row by half a key); without it the keys follow the ones before them.
const chars = (text, start) => Array.from(text).map((ch, index) => ({ ch, col: index === 0 ? start : undefined }));
function rowsFor(layer) {
  const backspace = { send: 'Backspace', icon: 'keyBackspace', aria: 'Backspace', span: 3, fn: true, repeat: true };
  const bottom = [{ ...LAYER_KEY[layer], span: 5, fn: true }, { send: 'Space', label: t('Space'), span: 10 }, { send: 'Enter', icon: 'keyEnter', aria: 'Enter', span: 5, fn: true }];
  if (layer === 'abc') {
    return [chars(LETTERS[0]), chars(LETTERS[1], 2), [{ shift: true, span: 3, fn: true }, ...chars(LETTERS[2]), backspace], bottom];
  }
  const [one, two, three] = SYMBOLS[layer];
  return [chars(one), chars(two), [{ ...SHIFT_SLOT[layer], span: 3, fn: true }, ...chars(three), backspace], bottom];
}

const KEY = {
  height: 44, minWidth: 0, p: 0, m: 0, border: 0, borderRadius: '6px', font: 'inherit', fontSize: 20, lineHeight: 1, color: 'text.primary',
  bgcolor: 'rgba(255, 255, 255, .16)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 1px 0 rgba(0, 0, 0, .5)',
  WebkitTapHighlightColor: 'transparent', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none',
  '&[data-fn]': { bgcolor: 'rgba(255, 255, 255, .08)', fontSize: 15, fontWeight: 500 },
  '&[aria-pressed="true"]': { bgcolor: 'rgba(41, 182, 246, .18)', color: 'primary.light', boxShadow: 'inset 0 0 0 1px currentColor' },
  // Press feedback: set on pointerdown, cleared on release; the attribute is set on the DOM node, so a press does not re-render.
  '&[data-down]': { bgcolor: 'rgba(255, 255, 255, .34)' },
};

export function TerminalKeyboard({ ui }) {
  const [layer, setLayer] = useState('abc');
  const [shift, setShiftState] = useState('off'); // 'off' | 'once' (the next letter only) | 'lock' (caps lock)
  const shiftRef = useRef('off');
  const lastShift = useRef(-Infinity);
  const repeat = useRef(0);
  const setShift = value => { shiftRef.current = value; setShiftState(value); };
  const stopRepeat = () => { clearTimeout(repeat.current); repeat.current = 0; };
  useEffect(() => stopRepeat, []);

  const press = item => {
    if (item.shift) {
      const now = performance.now();
      const current = shiftRef.current;
      if (current === 'lock') setShift('off');
      else if (current === 'once' && now - lastShift.current < DOUBLE_TAP_MS) setShift('lock');
      else setShift(current === 'once' ? 'off' : 'once');
      lastShift.current = now;
      return;
    }
    if (item.layer) { setLayer(item.layer); return; }
    if (item.send) { ui.actions.key({ key: item.send }); return; }
    const upper = layer === 'abc' && shiftRef.current !== 'off';
    ui.actions.key({ key: upper ? item.ch.toUpperCase() : item.ch });
    if (shiftRef.current === 'once') setShift('off');
  };
  const down = (event, item) => {
    if (event.button > 0) return;
    event.preventDefault(); // no focus moves, so neither keyboard opens or closes
    event.currentTarget.setAttribute('data-down', '');
    stopRepeat();
    press(item);
    if (!item.repeat) return;
    const again = () => { press(item); repeat.current = setTimeout(again, REPEAT_EVERY_MS); };
    repeat.current = setTimeout(again, REPEAT_DELAY_MS);
  };
  const up = event => { event.currentTarget.removeAttribute('data-down'); stopRepeat(); };
  // A click without a pointer before it (a screen reader, a switch device; `detail` is 0) presses the key too.
  const click = (event, item) => { if (event.detail === 0) press(item); };

  const upper = layer === 'abc' && shift !== 'off';
  return (
    <Box
      className="h5-osk" id="h5-osk" role="group" aria-label={t('Terminal on-screen keyboard')} data-layer={layer} data-shift={shift}
      onMouseDown={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}
      sx={{ display: 'flex', flexDirection: 'column', gap: '6px', px: 0.5, pt: 1, maxWidth: 720, mx: 'auto', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
    >
      {rowsFor(layer).map((row, rowIndex) => (
        <Box key={`${layer}-${rowIndex}`} className="h5-osk-row" sx={{ display: 'grid', gridTemplateColumns: 'repeat(20, minmax(0, 1fr))', columnGap: '4px' }}>
          {row.map((item, index) => {
            const shiftOn = item.shift && shift !== 'off';
            const name = item.shift ? t(shift === 'lock' ? 'Caps lock' : 'Shift') : item.aria ? t(item.aria) : undefined;
            const face = item.shift ? <Icon name={shift === 'lock' ? 'keyCapsLock' : 'keyShift'} size={24} />
              : item.icon ? <Icon name={item.icon} size={22} />
                : item.ch ? (upper ? item.ch.toUpperCase() : item.ch) : item.label;
            const data = item.ch ? { 'data-char': item.ch } : item.send ? { 'data-key': item.send } : item.layer ? { 'data-layer': item.layer } : { 'data-shift': '' };
            return (
              <Box
                component="button" type="button" tabIndex={-1} key={item.ch || item.send || item.layer || 'shift'} {...data}
                data-fn={item.fn ? '' : undefined} aria-label={name} title={item.icon || item.shift ? name : undefined}
                aria-pressed={item.shift ? shiftOn : undefined}
                onPointerDown={event => down(event, item)} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onPointerLeave={up}
                onClick={event => click(event, item)}
                sx={{ ...KEY, gridColumn: `${item.col || 'auto'} / span ${item.span || 2}`, ...(item.ch ? { fontFamily: 'ui-monospace, Menlo, monospace' } : null) }}
              >{face}</Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
