// The session switcher ("Session switcher" in docs/design/session-switcher.md): the switch button (`#h5-cycle`, Terminal.jsx) opens the recently
// shown sessions. On a phone-sized area a stack like the iPhone app switcher: the current session is the top card, peeking in from the right; the
// previous one is centred; older ones lie behind it to the left, each a little smaller and darker. Above each card: what the session is (Claude /
// Codex / OpenCode / shell), its device tag, its name and its state dot; inside: its last lines; at the bottom: the task, the state and "Current". A swipe or a
// drag, a sideways scroll or the arrow keys move the stack; it settles with one card centred. On a wider area ("The wide row") a row of cards that do
// not overlap, most recent first from the left (the current one, then the selected previous one, then older ones), each with a header that names its
// task; the row scrolls sideways and keeps the selected card in view. A session that needs the person has an orange edge. A tap on a card, Enter or
// another press of the switch button switches to it (the card grows into the page) and closes; a tap on the empty space, Escape, the back button
// (back.mjs: a layer) or a downward swipe close without switching.
// Remove from Recent (only the list changes, h5.js `removeRecent`, with Undo in a snackbar): on a touch screen a card swiped up past REMOVE_PX (or
// flicked up) flies off and goes, a shorter upward drag springs back; with a pointer a card shows a close button (x) while hovered or focused; Delete
// or Backspace removes the selected card. The current session stays (it is in use).
// It covers the terminal area on a computer (between the header and the bottom row) and the header, the terminal and the key row on a touch screen,
// so the tool row with the pressed switch button stays. The single view's only: a pane never opens it (h5.js).
// The list is h5.js's (`state.recent`, recent-sessions.mjs); the preview lines are what h5.js handed over when it opened (`state.switcher.previews`).
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, getOverlayAlpha, lighten } from '@mui/material/styles';
import { Pill, deviceText, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { DeviceTag, SessionKindIcon } from './TaskDrawer.jsx';
import { columnStatus, stateWord } from './columns.mjs';
import { cardPlace, recentKey, recentTaskRef, rowPick, rowScrollFor, settleIndex, startIndex, switcherCards, switcherRow } from './recent-sessions.mjs';
import { useStoreKeys } from './use-store.mjs';

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const kindOf = agent => (agent === 'notebook' ? 'Shell notebook' : AGENT_NAMES[agent] ? `${AGENT_NAMES[agent]} session` : 'Terminal');
// The words and colours of a state, as the task list rows show them (TaskDrawer.jsx).
const STATE_WORDS = { running: 'Running', waiting: 'Needs you', idle: 'Idle' };
const STATE_DOT = { running: 'success.main', waiting: 'warning.main', idle: 'text.disabled' };
const STATE_TEXT = { running: 'success.light', waiting: 'warning.light', idle: 'text.secondary' };
const OPEN_KEYS = ['recent', 'shownTarget', 'taskList', 'terminalActivity', 'attention', 'input'];
const GROW_MS = 200;
const SETTLE_MS = 140; // a sideways scroll settles this long after its last step
const TITLE_SPACE = 56; // the title row
const LABEL_SPACE = 34; // the line above a card
const ICON = 24;
const HEAD = 52; // the header of a card in the wide row
const REMOVE_PX = 120; // a card swiped up this far is removed from the list; a quick flick up (FLICK_V px/ms, at least 40px) too
const FLICK_V = 0.6;
const CLOSE = 32; // the close button of a card (pointer input)
// The close button shows while its card (the element just before it) or the button itself is hovered or has the keyboard focus.
const CLOSE_SX = {
  position: 'absolute', zIndex: 60, width: CLOSE, height: CLOSE, p: 0.5, opacity: 0, transition: 'opacity 120ms ease-out',
  bgcolor: 'background.paper', color: 'text.secondary', boxShadow: 2, '&:hover': { bgcolor: 'background.paper', color: 'text.primary' },
  '.h5-switcher-card:hover + &, .h5-switcher-card:focus-visible + &, &:hover, &:focus-visible': { opacity: 1 },
};
// The MD2 dark theme's elevation overlay: the header of a wide card is the surface at 8dp, a step lighter than the card's own page.
const overlay = (theme, dp) => { const tint = alpha(theme.palette.common.white, Number(getOverlayAlpha(dp))); return `linear-gradient(${tint}, ${tint})`; };
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

// Drawn by App.jsx from the lazy chunk (lazy-screens.jsx) with the `switcher` key only: closed, it draws nothing and reads nothing else.
export function Switcher({ state, ui }) {
  if (!state.switcher) return null;
  return <OpenSwitcher key={state.switcher.seq} ui={ui} switcher={state.switcher} />;
}

// The place of the switcher: the terminal area (computer) or everything above the tool row (touch), measured from the page itself, kept current.
function useArea(touch) {
  const [area, setArea] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const app = document.getElementById('h5-app');
      if (!app) return;
      const box = app.getBoundingClientRect();
      const terminal = document.getElementById('h5-terminal');
      const top = touch || !terminal ? box.top : terminal.getBoundingClientRect().top;
      const edge = document.getElementById(touch ? 'h5-actions' : 'h5-bottom');
      const bottom = edge ? edge.getBoundingClientRect().top : box.bottom;
      const next = { left: Math.round(box.left), top: Math.round(top), width: Math.round(box.width), height: Math.max(0, Math.round(bottom - top)) };
      setArea(before => (before && before.left === next.left && before.top === next.top && before.width === next.width && before.height === next.height ? before : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const id of ['h5-app', 'h5-bottom', 'h5-header']) { const el = document.getElementById(id); if (el && observer) observer.observe(el); }
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); };
  }, [touch]);
  return area;
}

// The sizes of the stack for an area: phone-sized cards under 600px (the mockup's 250 x 500, 56px apart), computer-sized ones above (300 x 380, 70px).
function geometry(area) {
  const narrow = area.width < 600;
  const cardW = narrow ? Math.min(250, Math.round(area.width * 0.64)) : 300;
  const step = narrow ? 56 : 70;
  const offset = cardW - (narrow ? 18 : 20);
  const foot = narrow ? 72 : 64;
  const avail = area.height - TITLE_SPACE - LABEL_SPACE - foot;
  const cardH = Math.max(120, Math.min(narrow ? 500 : 380, avail));
  const top = TITLE_SPACE + LABEL_SPACE + Math.max(0, Math.round((avail - cardH) * (narrow ? 0.5 : 0.3)));
  const centreX = Math.round((area.width - cardW) / 2 - (narrow ? 0 : 40));
  return { narrow, cardW, cardH, step, offset, top, centreX, far: area.width };
}
const isWide = area => area.width >= 600; // the other side of `narrow` in geometry()

// A hint with the switch button's icon in place of "⇋" (the translated text keeps the mark where its language puts it).
function withSwitchIcon(text) {
  const parts = t(text).split('⇋');
  return parts.flatMap((part, index) => (index ? [
    <Box key={`i${index}`} component="span" aria-hidden="true" sx={{ display: 'inline-flex', verticalAlign: 'middle', mx: 0.25, color: 'primary.main' }}><Icon name="cycleSessions" size={16} /></Box>,
    part,
  ] : [part]));
}

function OpenSwitcher({ ui, switcher }) {
  const state = useStoreKeys(ui, OPEN_KEYS);
  const touch = state.input !== 'pointer';
  const area = useArea(touch);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  // The cards are fixed while it is open (the shown session does not change meanwhile: that closes it, h5.js).
  const opened = useMemo(() => switcherCards(state.recent, state.shownTarget), []); // eslint-disable-line react-hooks/exhaustive-deps
  // A card removed from the list (here, by Undo's opposite on another device, ...) goes; Undo brings it back in its place.
  const cards = useMemo(() => {
    const listed = new Set((state.recent || []).map(recentKey));
    const kept = opened.filter(card => listed.has(recentKey(card)));
    return kept.length === opened.length ? opened : kept;
  }, [opened, state.recent]);
  const tasks = useMemo(() => new Map(((state.taskList && state.taskList.tasks) || []).map(row => [`${row.source}|${row.id}`, row])), [state.taskList]);
  const [pos, setPos] = useState(() => startIndex(cards));
  const [dragging, setDragging] = useState(false);
  const [pull, setPull] = useState(0); // a downward swipe in progress (touch), in px
  const [lift, setLift] = useState(null); // an upward swipe of a card in progress (touch): { key, dy } (dy < 0)
  const [removing, setRemoving] = useState(null); // the key of the card flying off before it leaves the list
  const [moved, setMoved] = useState(false);
  const [leaving, setLeaving] = useState(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const leavingRef = useRef(null);
  const gesture = useRef(null);
  const dragged = useRef(false); // the last pointer gesture moved the stack: its click is not a tap
  const rootRef = useRef(null);
  const cardRefs = useRef([]);
  const wheel = useRef({ timer: 0 });
  const count = cards.length;
  const centred = settleIndex(pos, count);
  // Fewer cards (one removed): the stack stays inside them.
  useEffect(() => { if (pos > Math.max(0, count - 1)) setPos(Math.max(0, count - 1)); }, [count, pos]);
  // The wide row (an area of 600px and more): its sizes, its scroller and the scroll position a growing card starts from.
  const wide = !!area && isWide(area);
  const row = useMemo(() => (area && isWide(area) ? switcherRow(area, count) : null), [area, count]);
  const scrollerRef = useRef(null);
  const handScroll = useRef(false); // the selection follows a scroll by hand: that does not scroll the row again
  const scrolledOnce = useRef(false);
  const scrollTimer = useRef(0);
  const leaveScroll = useRef(0);

  const statusOf = card => columnStatus({ target: card }, { activity: state.terminalActivity, items: state.attention && state.attention.items }).state;
  // The kind of the question a card's session waits at ('select' | 'accept'), else null: its word says "Needs selection" / "Needs acceptance".
  const waitOf = card => columnStatus({ target: card }, { activity: state.terminalActivity, items: state.attention && state.attention.items }).kind;

  const close = () => ui.actions.closeSwitcher();
  const choose = index => {
    const card = cards[index];
    if (!card || leavingRef.current !== null) { if (!card) close(); return; }
    leavingRef.current = index;
    leaveScroll.current = scrollerRef.current ? scrollerRef.current.scrollLeft : 0;
    setLeaving(index);
    const done = () => {
      document.getElementById('h5-cycle')?.focus({ preventScroll: true }); // the focus leaves the stack before it goes (the terminal may take it next)
      if (!card.current) ui.actions.openRow(recentTaskRef(card), { kind: 'terminal', id: card.terminalId });
      close();
    };
    if (reduced) done(); else setTimeout(done, GROW_MS);
  };
  // Remove from Recent: the card flies up and off (at once with reduced motion), then leaves the list; a card before the centred one moves the
  // stack by one so the centred card stays. The current session cannot go: it springs back.
  const remove = index => {
    const card = cards[index];
    if (!card || card.current || leavingRef.current !== null || removing) return;
    const key = recentKey(card);
    setRemoving(key);
    const done = () => {
      setRemoving(null);
      setLift(null);
      if (!ui.actions.removeRecent([key])) return;
      if (index < posRef.current) setPos(value => Math.max(0, value - 1));
      rootRef.current?.focus({ preventScroll: true }); // the focus effect moves it on to the new centred card
    };
    if (reduced) done(); else setTimeout(done, GROW_MS);
  };
  // Another press of the switch button while open: the centred card.
  const pressSeen = useRef(switcher.press);
  useEffect(() => {
    if (switcher.press === pressSeen.current) return;
    pressSeen.current = switcher.press;
    choose(settleIndex(posRef.current, count));
  });

  // The focus: into the stack when it opens and onto the centred card as it moves; back to the switch button when it closes (unless something else,
  // the terminal after a switch, has taken it already).
  useEffect(() => {
    const root = rootRef.current;
    const card = cardRefs.current[centred];
    if (!root || leavingRef.current !== null) return;
    const active = document.activeElement;
    if (!active || active === document.body || root.contains(active)) (card || root).focus({ preventScroll: true });
  }, [centred, area, count]);
  // The wide row keeps the selected card in view (at once when it opens, smoothly after a key), unless the selection followed a scroll by hand.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!row || !scroller || leavingRef.current !== null) return;
    if (handScroll.current) { handScroll.current = false; return; }
    const left = rowScrollFor(row, centred, scroller.scrollLeft, scroller.clientWidth);
    if (Math.abs(left - scroller.scrollLeft) >= 1) scroller.scrollTo({ left, behavior: reduced || !scrolledOnce.current ? 'auto' : 'smooth' });
    scrolledOnce.current = true;
  }, [centred, row, reduced]);
  useEffect(() => () => clearTimeout(scrollTimer.current), []);
  useLayoutEffect(() => () => {
    const active = document.activeElement;
    const root = rootRef.current;
    if (!active || active === document.body || (root && root.contains(active))) document.getElementById('h5-cycle')?.focus({ preventScroll: true });
  }, []);

  // A sideways scroll (trackpad, a tilting wheel, Shift + wheel) moves the stack: fingers to the right show older cards, as a swipe does.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !area) return undefined;
    const { step } = geometry(area);
    const onWheel = event => {
      if (isWide(area)) {
        // The row scrolls itself sideways (trackpad, a tilting wheel); an upright wheel scrolls it too.
        const scroller = scrollerRef.current;
        if (!scroller || leavingRef.current !== null || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        scroller.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1);
        return;
      }
      const dx = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? step : 1);
      if (!dx || Math.abs(event.deltaX) < Math.abs(event.deltaY) || leavingRef.current !== null) return;
      event.preventDefault();
      setMoved(true);
      setDragging(true);
      setPos(value => Math.max(-0.3, Math.min(count - 0.7, value - dx / step)));
      clearTimeout(wheel.current.timer);
      wheel.current.timer = setTimeout(() => { setDragging(false); setPos(value => settleIndex(value, count)); }, SETTLE_MS);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => { root.removeEventListener('wheel', onWheel); clearTimeout(wheel.current.timer); };
  }, [area, count]);

  if (!area) return null;
  const g = geometry(area);
  const go = index => { setMoved(true); setPos(settleIndex(index, count)); };

  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { event.preventDefault(); return; } // one stop: the centred card (a modal keeps the focus)
    if (leavingRef.current !== null) return;
    // The older cards lie to the left in the stack, to the right in the wide row.
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(wide ? centred - 1 : centred + 1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(wide ? centred + 1 : centred - 1); }
    else if (event.key === 'Home') { event.preventDefault(); go(0); }
    else if (event.key === 'End') { event.preventDefault(); go(count - 1); }
    else if (event.key === 'Enter' && !event.target.closest('.h5-switcher-card')) { event.preventDefault(); choose(centred); } // a card's own Enter is its click
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(centred); }
  };
  const onPointerDown = event => {
    if (leavingRef.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    dragged.current = false;
    if (event.target.closest('.h5-switcher-close')) return; // its own click
    const on = event.target.closest('.h5-switcher-card');
    const card = on ? cards[Number(on.dataset.index)] : null;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pos: posRef.current, axis: null, touch: event.pointerType !== 'mouse', lastX: event.clientX, lastT: event.timeStamp, v: 0, lastY: event.clientY, vy: 0, scroll: scrollerRef.current ? scrollerRef.current.scrollLeft : 0, card: card && !removing ? { index: Number(on.dataset.index), key: recentKey(card), current: card.current } : null };
  };
  const onPointerMove = event => {
    const s = gesture.current;
    if (!s || s.id !== event.pointerId) return;
    const dx = event.clientX - s.x;
    const dy = event.clientY - s.y;
    if (!s.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      s.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      dragged.current = true;
      // A finger moving the wide row sideways is the browser's own scroll (it cancels this pointer): nothing to capture.
      if (!(wide && s.axis === 'x' && s.touch)) { try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is gone */ } }
      setDragging(true);
    }
    if (s.axis === 'x' && wide) {
      if (!s.touch && scrollerRef.current) scrollerRef.current.scrollLeft = s.scroll - dx; // a mouse drag scrolls the row
    } else if (s.axis === 'x') {
      const dt = Math.max(1, event.timeStamp - s.lastT);
      s.v = (event.clientX - s.lastX) / dt;
      s.lastX = event.clientX;
      s.lastT = event.timeStamp;
      const raw = s.pos + dx / g.step;
      // Past either end it follows the finger at a third of the speed.
      setPos(raw < 0 ? raw / 3 : raw > count - 1 ? count - 1 + (raw - count + 1) / 3 : raw);
      setMoved(true);
    } else if (s.touch) {
      const dt = Math.max(1, event.timeStamp - s.lastT);
      s.vy = (event.clientY - s.lastY) / dt;
      s.lastY = event.clientY;
      s.lastT = event.timeStamp;
      // Up on a card lifts it (the current one only a little: it cannot go); down anywhere pulls the stack to close.
      if (s.card && dy < 0) { setPull(0); setLift({ key: s.card.key, dy: s.card.current ? dy / 4 : dy }); } else { setLift(null); setPull(Math.max(0, dy)); }
    }
  };
  const onPointerUp = event => {
    const s = gesture.current;
    if (!s || s.id !== event.pointerId) return;
    gesture.current = null;
    if (!s.axis) return;
    setDragging(false);
    if (s.axis === 'x' && wide) return; // the row stays where it was scrolled
    if (s.axis === 'x') {
      const flick = Math.abs(s.v) > 0.5 ? Math.sign(s.v) * 0.5 : 0; // a quick flick goes on to the next card
      setPos(settleIndex(posRef.current + flick, count));
    } else {
      const dy = event.clientY - s.y;
      const down = event.type === 'pointerup' && dy > 80 && s.touch;
      const up = event.type === 'pointerup' && s.touch && s.card && !s.card.current && (-dy > REMOVE_PX || (-dy > 40 && s.vy < -FLICK_V));
      setPull(0);
      if (up) remove(s.card.index); else setLift(null); // a short drag springs back
      if (down) close();
    }
  };
  // A scroll of the wide row by hand (wheel, trackpad, drag, finger): once it rests, a selected card that went out of view gives the selection to the
  // card most in view, so the switch button's next press goes to a card that can be seen.
  const onRowScroll = () => {
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const scroller = scrollerRef.current;
      if (!scroller || !row || leavingRef.current !== null) return;
      const selected = settleIndex(posRef.current, count);
      const next = rowPick(row, selected, scroller.scrollLeft, scroller.clientWidth);
      if (next !== selected) { handScroll.current = true; setPos(next); }
    }, SETTLE_MS);
  };
  const onBackdropClick = event => {
    if (dragged.current) { dragged.current = false; return; }
    if (!event.target.closest('.h5-switcher-card') && leavingRef.current === null) close();
  };

  // The upward offset of a card: following the finger, or flying off (above the area) while it is removed.
  const upOf = (key, height) => (removing === key ? { y: -height, gone: true, lifting: false } : lift && lift.key === key ? { y: lift.dy, gone: false, lifting: true } : { y: 0, gone: false, lifting: false });
  const motion = reduced || dragging ? 'none'
    : 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1), left 200ms cubic-bezier(0.4, 0, 0.2, 1), top 200ms cubic-bezier(0.4, 0, 0.2, 1), width 200ms cubic-bezier(0.4, 0, 0.2, 1), height 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms linear';
  const lineHeight = 1.6;
  const previewRows = Math.max(1, Math.floor(((row ? row.cardH - HEAD : g.cardH - 40) - 24) / (12 * lineHeight)));
  const empty = count < 2;

  const content = (
    <Box
      ref={rootRef} id="h5-switcher" className="h5-switcher" role="dialog" aria-modal="true" aria-label={t('Recent sessions')} tabIndex={-1}
      data-layout={touch ? 'touch' : 'pointer'} onKeyDown={onKeyDown} onClick={onBackdropClick}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      sx={theme => ({
        position: 'fixed', left: area.left, top: area.top, width: area.width, height: area.height, zIndex: 1100, overflow: 'hidden', outline: 'none',
        color: 'text.primary', touchAction: wide ? 'pan-x' : 'none', userSelect: 'none', WebkitUserSelect: 'none',
        background: `radial-gradient(90% 80% at 50% 45%, ${lighten(theme.palette.background.default, 0.12)} 0%, ${theme.palette.background.default} 75%)`,
        animation: reduced ? 'none' : 'h5-switcher-in 150ms cubic-bezier(0, 0, 0.2, 1)',
        '@keyframes h5-switcher-in': { from: { opacity: 0 }, to: { opacity: 1 } },
      })}
    >
      <Typography variant={g.narrow ? 'subtitle1' : 'h6'} component="h2" sx={{ position: 'absolute', left: g.narrow ? 16 : 24, right: 16, top: g.narrow ? 16 : 20, fontWeight: 500, pointerEvents: 'none' }}>
        {t('Recent sessions')}
      </Typography>
      {touch && count > 1 ? (
        <Typography className="h5-switcher-remove-hint" variant="caption" color="text.secondary" sx={{ position: 'absolute', right: g.narrow ? 16 : 24, top: g.narrow ? 20 : 26, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          {t('Swipe a card up to remove it')}
        </Typography>
      ) : null}
      <Box className="h5-switcher-stack" sx={{ position: 'absolute', inset: 0, transform: pull ? `translateY(${pull / 2}px)` : 'none', opacity: pull ? Math.max(0.4, 1 - pull / 300) : 1 }}>
        {row ? (
          // The wide row: a sideways scroller over the whole area (its empty space still closes the switcher), the cards at their places in it.
          <Box
            ref={scrollerRef} className="h5-switcher-row" onScroll={onRowScroll}
            sx={{ position: 'absolute', inset: 0, overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'none', overscrollBehaviorX: 'contain', touchAction: 'pan-x' }}
          >
            <Box sx={{ position: 'relative', width: row.contentW, height: '100%' }}>
              {cards.map((card, index) => (
                <Fragment key={recentKey(card)}>
                  <WideCard
                    card={card} index={index} row={row} area={area} status={statusOf(card)} kind={waitOf(card)} taskRow={tasks.get(recentTaskRef(card))}
                    preview={(switcher.previews || {})[recentKey(card)]} previewRows={previewRows} selected={index === centred} leaving={leaving}
                    growLeft={leaveScroll.current} motion={motion} reduced={reduced} cardRef={el => { cardRefs.current[index] = el; }} closable={!touch && !card.current}
                    up={upOf(recentKey(card), row.top + row.cardH)}
                    onChoose={() => { if (dragged.current) { dragged.current = false; return; } choose(index); }}
                  />
                  {!touch && !card.current && leaving === null && removing !== recentKey(card) ? (
                    <CloseButton onRemove={() => remove(index)} sx={{ left: row.xs[index] + row.cardW - CLOSE - 10, top: row.top + (HEAD - CLOSE) / 2, transition: `${motion === 'none' ? '' : 'left 200ms cubic-bezier(0.4, 0, 0.2, 1), '}opacity 120ms ease-out` }} />
                  ) : null}
                </Fragment>
              ))}
            </Box>
          </Box>
        ) : cards.map((card, index) => {
          const rel = index - pos;
          const place = cardPlace(rel, { step: g.step, offset: g.offset, far: g.far });
          const status = statusOf(card);
          const word = t(stateWord(STATE_WORDS, status, waitOf(card)));
          const row = tasks.get(recentTaskRef(card));
          const taskTitle = (row && row.title) || '';
          const device = row ? row.device : null;
          const name = card.title || t(kindOf(card.agent));
          const preview = (switcher.previews || {})[recentKey(card)];
          const lines = preview && Array.isArray(preview.lines) ? preview.lines.slice(-previewRows) : [];
          const behind = rel > 0.5;
          const isCentred = index === centred;
          const grow = leaving === index;
          const label = [device ? deviceText(device) : '', name, taskTitle, word, card.current ? t('Current') : ''].filter(Boolean).join(', ');
          const edge = isCentred ? 'primary.main' : status === 'waiting' ? 'warning.main' : null;
          const up = upOf(recentKey(card), g.top + g.cardH);
          return (
            <Fragment key={recentKey(card)}>
            <ButtonBase
              key={recentKey(card)} ref={el => { cardRefs.current[index] = el; }} className="h5-switcher-card" disableRipple
              data-key={recentKey(card)} data-index={index} data-status={status} data-centred={isCentred ? 'true' : undefined} data-current={card.current ? 'true' : undefined}
              aria-label={label} aria-current={card.current ? 'true' : undefined} tabIndex={isCentred ? 0 : -1}
              onClick={event => { event.stopPropagation(); if (dragged.current) { dragged.current = false; return; } choose(index); }}
              sx={{
                position: 'absolute', display: 'block', textAlign: 'left', p: 0,
                left: grow ? 0 : g.centreX, top: grow ? 0 : g.top, width: grow ? area.width : g.cardW, height: grow ? area.height : g.cardH,
                transform: grow ? 'none' : `translate(${place.x}px, ${up.y}px) scale(${place.scale})`, transformOrigin: 'center center',
                zIndex: grow ? 100 : 50 - index, transition: up.lifting ? 'none' : motion,
                opacity: (leaving !== null && !grow) || up.gone ? 0 : rel > 4.5 || rel < -1.5 ? 0 : 1,
                // The focus is always on the centred card, whose primary edge shows it: no second ring.
                outline: 'none',
              }}
            >
              {/* Above the card: what it is, its device, its name and its state dot; a card behind the centred one shows only its icon. */}
              {grow ? null : (
                <Box
                  className="h5-switcher-label" aria-hidden="true"
                  sx={{ position: 'absolute', left: 0, right: behind ? 'auto' : 0, top: -LABEL_SPACE, height: 28, display: 'flex', alignItems: 'center', gap: 1, overflow: 'hidden', pointerEvents: 'none' }}
                >
                  <SessionKindIcon agent={card.agent} title={t(kindOf(card.agent))} size={ICON} />
                  {behind ? null : (
                    <>
                      {device ? <DeviceTag device={device} /> : null}
                      <Typography component="span" variant="subtitle2" className="h5-switcher-name" sx={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</Typography>
                      <Box component="span" className="h5-switcher-dot" sx={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', bgcolor: STATE_DOT[status] }} />
                    </>
                  )}
                </Box>
              )}
              <Box
                className="h5-switcher-body"
                sx={theme => ({
                  position: 'relative', width: '100%', height: '100%', overflow: 'hidden', borderRadius: grow ? 0 : 2, bgcolor: 'background.default',
                  boxShadow: `${edge ? `0 0 0 2px ${theme.palette[edge.split('.')[0]].main}` : `0 0 0 1px ${theme.palette.divider}`}, ${theme.shadows[8]}`,
                  transition: reduced ? 'none' : 'border-radius 200ms cubic-bezier(0.4, 0, 0.2, 1)',
                })}
              >
                {lines.length ? (
                  <Box className="h5-switcher-lines" translate="no" sx={{ p: 1.5, typography: 'caption', fontFamily: MONO, lineHeight, color: 'text.primary', overflow: 'hidden' }}>
                    {lines.map((line, at) => <Box key={at} sx={{ whiteSpace: 'pre', overflow: 'hidden', minHeight: `${lineHeight}em` }}>{line}</Box>)}
                  </Box>
                ) : (
                  <Box className="h5-switcher-placeholder" sx={{ position: 'absolute', inset: 0, bottom: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, color: 'text.disabled' }}>
                    <SessionKindIcon agent={card.agent} size={40} />
                    <Typography variant="caption" color="text.secondary">{t('No preview yet')}</Typography>
                  </Box>
                )}
                {/* The card on top covers the right edge of this one (cardW - offset px): the state word stays clear of it. The current card has none on top. */}
                <Box
                  className="h5-switcher-foot"
                  sx={theme => ({ position: 'absolute', left: 0, right: 0, bottom: 0, height: 40, display: 'flex', alignItems: 'center', gap: 1, pl: 1.5, pr: card.current ? 1.5 : `${g.cardW - g.offset + 12}px`, background: `linear-gradient(transparent, ${alpha(theme.palette.common.black, 0.85)})` })}
                >
                  <Typography component="span" variant="caption" className="h5-switcher-task" sx={{ flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'text.secondary' }}>{taskTitle}</Typography>
                  <Typography component="span" variant="caption" className="h5-switcher-state" sx={{ flex: '0 0 auto', color: STATE_TEXT[status] }}>{word}</Typography>
                  {card.current ? <Pill className="h5-switcher-current" label={t('Current')} filled sx={{ flex: '0 0 auto', height: 18, px: 0.75, typography: 'caption', lineHeight: 1 }} /> : null}
                </Box>
                {/* Each step behind the centred card is a little darker. */}
                <Box aria-hidden="true" sx={theme => ({ position: 'absolute', inset: 0, pointerEvents: 'none', bgcolor: alpha(theme.palette.common.black, grow ? 0 : place.dim), transition: motion === 'none' ? 'none' : 'background-color 200ms linear' })} />
              </Box>
            </ButtonBase>
            {/* With a pointer, the centred card's close button, at its top right while the stack rests. */}
            {!touch && isCentred && !card.current && !dragging && leaving === null && !removing && pos === centred ? (
              <CloseButton onRemove={() => remove(index)} sx={{ left: g.centreX + g.cardW - CLOSE - 6, top: g.top + 6 }} />
            ) : null}
            </Fragment>
          );
        })}
      </Box>
      {count ? null : (
        <Typography variant="body2" color="text.secondary" sx={{ position: 'absolute', left: 16, right: 16, top: '45%', textAlign: 'center' }}>{t('No other recent sessions')}</Typography>
      )}
      {/* The position dots (oldest on the left, as the stack lies) and the hint. */}
      {count > 1 && !row ? (
        <Box className="h5-switcher-dots" aria-hidden="true" sx={{ position: 'absolute', left: 0, right: 0, bottom: g.narrow ? 34 : 48, display: 'flex', justifyContent: 'center', gap: 0.75, pointerEvents: 'none' }}>
          {cards.map((card, index) => count - 1 - index).map(index => (
            <Box key={index} data-index={index} sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: index === centred ? 'primary.main' : 'action.disabled' }} />
          ))}
        </Box>
      ) : null}
      <Box
        className="h5-switcher-hint"
        sx={{ position: 'absolute', left: g.narrow ? 16 : 24, right: g.narrow ? 16 : 24, bottom: g.narrow ? 10 : 16, display: 'flex', alignItems: 'center', justifyContent: g.narrow ? 'center' : 'flex-start', gap: 1, typography: g.narrow ? 'caption' : 'body2', color: 'text.secondary', pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden' }}
      >
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {empty && count ? t('No other recent sessions') : count ? withSwitchIcon(g.narrow ? (moved ? 'Swipe to move · tap a card or press ⇋ to switch' : 'Press ⇋ again to switch to it') : 'Press ⇋ again or click a card to switch') : null}
        </Box>
        {g.narrow || touch ? null : (
          <>
            <Box component="span" sx={{ flex: 1 }} />
            <Keys keys={['←', '→']} />
            <span>{t('move (or scroll sideways)')}</span>
            <Keys keys={['Enter']} />
            <span>{t('switch')}</span>
            <Keys keys={['Del']} />
            <span>{t('remove')}</span>
            <Keys keys={['Esc']} />
            <span>{t('close')}</span>
          </>
        )}
      </Box>
    </Box>
  );
  return createPortal(content, document.body);
}

// A card of the wide row: a header that names the task (the agent's tile, the task as the title, then the device tag, the session, the state dot and
// word), "Current" on the current card, then the preview lines or the quiet placeholder. The selected card has the primary edge (it holds the focus),
// one that needs the person the orange one.
function WideCard({ card, index, row, area, status, kind, taskRow, preview, previewRows, selected, leaving, growLeft, motion, reduced, cardRef, closable, up, onChoose }) {
  const device = taskRow ? taskRow.device : null;
  const taskTitle = (taskRow && taskRow.title) || '';
  const name = card.title || t(kindOf(card.agent));
  const heading = taskTitle || name;
  const lines = preview && Array.isArray(preview.lines) ? preview.lines.slice(-previewRows) : [];
  const grow = leaving === index;
  const word = t(stateWord(STATE_WORDS, status, kind));
  const label = [device ? deviceText(device) : '', name, taskTitle, word, card.current ? t('Current') : ''].filter(Boolean).join(', ');
  const edge = selected ? 'primary' : status === 'waiting' ? 'warning' : null;
  const lineHeight = 1.6;
  return (
    <ButtonBase
      ref={cardRef} className="h5-switcher-card" disableRipple
      data-key={recentKey(card)} data-index={index} data-status={status} data-centred={selected ? 'true' : undefined} data-current={card.current ? 'true' : undefined}
      aria-label={label} aria-current={card.current ? 'true' : undefined} tabIndex={selected ? 0 : -1}
      onClick={event => { event.stopPropagation(); onChoose(); }}
      sx={{
        position: 'absolute', display: 'block', textAlign: 'left', p: 0,
        left: grow ? growLeft : row.xs[index], top: grow ? 0 : row.top, width: grow ? area.width : row.cardW, height: grow ? area.height : row.cardH,
        zIndex: grow ? 100 : 1, transition: up.lifting ? 'none' : motion, opacity: (leaving !== null && !grow) || up.gone ? 0 : 1,
        transform: up.y ? `translateY(${up.y}px)` : 'none',
        outline: 'none', // the selected card's primary edge shows the focus: no second ring
      }}
    >
      <Box
        className="h5-switcher-body"
        sx={theme => ({
          position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: grow ? 0 : 2, bgcolor: 'background.default',
          boxShadow: `${edge ? `0 0 0 2px ${theme.palette[edge].main}` : `0 0 0 1px ${theme.palette.divider}`}, ${theme.shadows[8]}`,
          transition: reduced ? 'none' : 'border-radius 200ms cubic-bezier(0.4, 0, 0.2, 1)',
        })}
      >
        <Box
          className="h5-switcher-head"
          sx={theme => ({ flex: `0 0 ${HEAD}px`, display: 'flex', alignItems: 'center', gap: 1.25, pl: 1.5, pr: closable ? `${CLOSE + 16}px` : 1.5, bgcolor: 'background.paper', backgroundImage: overlay(theme, 8), borderBottom: 1, borderColor: 'divider' })}
        >
          <SessionKindIcon agent={card.agent} title={t(kindOf(card.agent))} size={28} />
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Typography component="div" variant="subtitle1" className="h5-switcher-task" title={heading} sx={{ fontWeight: 500, lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{heading}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, height: 20, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
              {device ? <DeviceTag device={device} /> : null}
              <Typography component="span" variant="caption" className="h5-switcher-name" sx={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: 'text.secondary' }}>{name}</Typography>
              <Box component="span" className="h5-switcher-dot" sx={{ flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', bgcolor: STATE_DOT[status] }} />
              <Typography component="span" variant="caption" className="h5-switcher-state" sx={{ flex: '0 0 auto', color: STATE_TEXT[status] }}>{word}</Typography>
            </Box>
          </Box>
        </Box>
        <Box sx={{ position: 'relative', flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
          {card.current ? <Pill className="h5-switcher-current" label={t('Current')} filled sx={{ position: 'absolute', top: 8, right: 8, zIndex: 1, height: 20, px: 1, typography: 'caption', lineHeight: 1 }} /> : null}
          {lines.length ? (
            <Box className="h5-switcher-lines" translate="no" sx={{ p: 1.5, typography: 'caption', fontFamily: MONO, lineHeight, color: 'text.primary', overflow: 'hidden' }}>
              {lines.map((line, at) => <Box key={at} sx={{ whiteSpace: 'pre', overflow: 'hidden', minHeight: `${lineHeight}em` }}>{line}</Box>)}
            </Box>
          ) : (
            <Box className="h5-switcher-placeholder" sx={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, color: 'text.disabled' }}>
              <SessionKindIcon agent={card.agent} size={40} />
              <Typography variant="caption" color="text.secondary">{t('No preview yet')}</Typography>
            </Box>
          )}
        </Box>
      </Box>
    </ButtonBase>
  );
}

// The close button of a card (pointer input): "Remove from Recent". A sibling just after its card (a button cannot hold another button); not a Tab
// stop (the switcher has one, the selected card, whose Delete key does the same).
function CloseButton({ onRemove, sx }) {
  return (
    <IconButton
      className="h5-switcher-close" size="small" tabIndex={-1} aria-label={t('Remove from Recent')} title={t('Remove from Recent')}
      onClick={event => { event.stopPropagation(); onRemove(); }} sx={{ ...CLOSE_SX, ...sx }}
    ><Icon name="close" size={16} /></IconButton>
  );
}

function Keys({ keys }) {
  return keys.map(key => (
    <Box key={key} component="kbd" sx={{ typography: 'caption', fontFamily: MONO, px: 0.75, borderRadius: 1, bgcolor: 'action.selected', color: 'text.primary' }}>{key}</Box>
  ));
}
