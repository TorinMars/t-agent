// The session switcher ("Session switcher" in docs/design/session-switcher.md): the switch button (`#h5-cycle`, Terminal.jsx) opens a stack of the
// recently shown sessions, like the iPhone app switcher. The current session is the top card, peeking in from the right; the previous one is centred;
// older ones lie behind it to the left, each a little smaller and darker. Above each card: what the session is (Claude / Codex / shell), its device
// tag, its name and its state dot; inside: its last lines; at the bottom: the task, the state and "Current". A session that needs the person has an
// orange edge. A swipe or a drag, a sideways scroll or the arrow keys move the stack; it settles with one card centred. A tap on a card, Enter or
// another press of the switch button switches to it (the card grows into the page) and closes; a tap on the empty space, Escape, the back button
// (back.mjs: a layer) or a downward swipe close without switching.
// It covers the terminal area on a computer (between the header and the bottom row) and the header, the terminal and the key row on a touch screen,
// so the tool row with the pressed switch button stays. The single view's only: a pane never opens it (h5.js).
// The list is h5.js's (`state.recent`, recent-sessions.mjs); the preview lines are what h5.js handed over when it opened (`state.switcher.previews`).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, lighten } from '@mui/material/styles';
import { Pill, deviceText, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { DeviceTag, SessionKindIcon } from './TaskDrawer.jsx';
import { columnStatus } from './columns.mjs';
import { cardPlace, recentKey, recentTaskRef, settleIndex, startIndex, switcherCards } from './recent-sessions.mjs';
import { useStoreKeys } from './use-store.mjs';

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' };
const kindOf = agent => (AGENT_NAMES[agent] ? `${AGENT_NAMES[agent]} session` : 'Terminal');
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
  const cards = useMemo(() => switcherCards(state.recent, state.shownTarget), []); // eslint-disable-line react-hooks/exhaustive-deps
  const tasks = useMemo(() => new Map(((state.taskList && state.taskList.tasks) || []).map(row => [`${row.source}|${row.id}`, row])), [state.taskList]);
  const [pos, setPos] = useState(() => startIndex(cards));
  const [dragging, setDragging] = useState(false);
  const [pull, setPull] = useState(0); // a downward swipe in progress (touch), in px
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

  const statusOf = card => columnStatus({ target: card }, { activity: state.terminalActivity, items: state.attention && state.attention.items }).state;

  const close = () => ui.actions.closeSwitcher();
  const choose = index => {
    const card = cards[index];
    if (!card || leavingRef.current !== null) { if (!card) close(); return; }
    leavingRef.current = index;
    setLeaving(index);
    const done = () => {
      document.getElementById('h5-cycle')?.focus({ preventScroll: true }); // the focus leaves the stack before it goes (the terminal may take it next)
      if (!card.current) ui.actions.openRow(recentTaskRef(card), { kind: 'terminal', id: card.terminalId });
      close();
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
  }, [centred, area]);
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
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(centred + 1); } // the older cards lie to the left
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(centred - 1); }
    else if (event.key === 'Home') { event.preventDefault(); go(0); }
    else if (event.key === 'End') { event.preventDefault(); go(count - 1); }
    else if (event.key === 'Enter' && !event.target.closest('.h5-switcher-card')) { event.preventDefault(); choose(centred); } // a card's own Enter is its click
  };
  const onPointerDown = event => {
    if (leavingRef.current !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    dragged.current = false;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pos: posRef.current, axis: null, touch: event.pointerType !== 'mouse', lastX: event.clientX, lastT: event.timeStamp, v: 0 };
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
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is gone */ }
      setDragging(true);
    }
    if (s.axis === 'x') {
      const dt = Math.max(1, event.timeStamp - s.lastT);
      s.v = (event.clientX - s.lastX) / dt;
      s.lastX = event.clientX;
      s.lastT = event.timeStamp;
      const raw = s.pos + dx / g.step;
      // Past either end it follows the finger at a third of the speed.
      setPos(raw < 0 ? raw / 3 : raw > count - 1 ? count - 1 + (raw - count + 1) / 3 : raw);
      setMoved(true);
    } else if (s.touch) {
      setPull(Math.max(0, dy));
    }
  };
  const onPointerUp = event => {
    const s = gesture.current;
    if (!s || s.id !== event.pointerId) return;
    gesture.current = null;
    if (!s.axis) return;
    setDragging(false);
    if (s.axis === 'x') {
      const flick = Math.abs(s.v) > 0.5 ? Math.sign(s.v) * 0.5 : 0; // a quick flick goes on to the next card
      setPos(settleIndex(posRef.current + flick, count));
    } else {
      const down = event.type === 'pointerup' && event.clientY - s.y > 80 && s.touch;
      setPull(0);
      if (down) close();
    }
  };
  const onBackdropClick = event => {
    if (dragged.current) { dragged.current = false; return; }
    if (!event.target.closest('.h5-switcher-card') && leavingRef.current === null) close();
  };

  const motion = reduced || dragging ? 'none'
    : 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1), left 200ms cubic-bezier(0.4, 0, 0.2, 1), top 200ms cubic-bezier(0.4, 0, 0.2, 1), width 200ms cubic-bezier(0.4, 0, 0.2, 1), height 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms linear';
  const lineHeight = 1.6;
  const previewRows = Math.max(1, Math.floor((g.cardH - 24 - 40) / (12 * lineHeight)));
  const empty = count < 2;

  const content = (
    <Box
      ref={rootRef} id="h5-switcher" className="h5-switcher" role="dialog" aria-modal="true" aria-label={t('Recent sessions')} tabIndex={-1}
      data-layout={touch ? 'touch' : 'pointer'} onKeyDown={onKeyDown} onClick={onBackdropClick}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      sx={theme => ({
        position: 'fixed', left: area.left, top: area.top, width: area.width, height: area.height, zIndex: 1100, overflow: 'hidden', outline: 'none',
        color: 'text.primary', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
        background: `radial-gradient(90% 80% at 50% 45%, ${lighten(theme.palette.background.default, 0.12)} 0%, ${theme.palette.background.default} 75%)`,
        animation: reduced ? 'none' : 'h5-switcher-in 150ms cubic-bezier(0, 0, 0.2, 1)',
        '@keyframes h5-switcher-in': { from: { opacity: 0 }, to: { opacity: 1 } },
      })}
    >
      <Typography variant={g.narrow ? 'subtitle1' : 'h6'} component="h2" sx={{ position: 'absolute', left: g.narrow ? 16 : 24, right: 16, top: g.narrow ? 16 : 20, fontWeight: 500, pointerEvents: 'none' }}>
        {t('Recent sessions')}
      </Typography>
      <Box className="h5-switcher-stack" sx={{ position: 'absolute', inset: 0, transform: pull ? `translateY(${pull / 2}px)` : 'none', opacity: pull ? Math.max(0.4, 1 - pull / 300) : 1 }}>
        {cards.map((card, index) => {
          const rel = index - pos;
          const place = cardPlace(rel, { step: g.step, offset: g.offset, far: g.far });
          const status = statusOf(card);
          const row = tasks.get(recentTaskRef(card));
          const taskTitle = (row && row.title) || '';
          const device = row ? row.device : null;
          const name = card.title || t(kindOf(card.agent));
          const preview = (switcher.previews || {})[recentKey(card)];
          const lines = preview && Array.isArray(preview.lines) ? preview.lines.slice(-previewRows) : [];
          const behind = rel > 0.5;
          const isCentred = index === centred;
          const grow = leaving === index;
          const label = [device ? deviceText(device) : '', name, taskTitle, t(STATE_WORDS[status]), card.current ? t('Current') : ''].filter(Boolean).join(', ');
          const edge = isCentred ? 'primary.main' : status === 'waiting' ? 'warning.main' : null;
          return (
            <ButtonBase
              key={recentKey(card)} ref={el => { cardRefs.current[index] = el; }} className="h5-switcher-card" disableRipple
              data-key={recentKey(card)} data-index={index} data-status={status} data-centred={isCentred ? 'true' : undefined} data-current={card.current ? 'true' : undefined}
              aria-label={label} aria-current={card.current ? 'true' : undefined} tabIndex={isCentred ? 0 : -1}
              onClick={event => { event.stopPropagation(); if (dragged.current) { dragged.current = false; return; } choose(index); }}
              sx={{
                position: 'absolute', display: 'block', textAlign: 'left', p: 0,
                left: grow ? 0 : g.centreX, top: grow ? 0 : g.top, width: grow ? area.width : g.cardW, height: grow ? area.height : g.cardH,
                transform: grow ? 'none' : `translateX(${place.x}px) scale(${place.scale})`, transformOrigin: 'center center',
                zIndex: grow ? 100 : 50 - index, transition: motion,
                opacity: leaving !== null && !grow ? 0 : rel > 4.5 || rel < -1.5 ? 0 : 1,
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
                <Box
                  className="h5-switcher-foot"
                  sx={theme => ({ position: 'absolute', left: 0, right: 0, bottom: 0, height: 40, display: 'flex', alignItems: 'center', gap: 1, px: 1.5, background: `linear-gradient(transparent, ${alpha(theme.palette.common.black, 0.85)})` })}
                >
                  <Typography component="span" variant="caption" className="h5-switcher-task" sx={{ flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'text.secondary' }}>{taskTitle}</Typography>
                  <Typography component="span" variant="caption" className="h5-switcher-state" sx={{ flex: '0 0 auto', color: STATE_TEXT[status] }}>{t(STATE_WORDS[status])}</Typography>
                  {card.current ? <Pill className="h5-switcher-current" label={t('Current')} filled sx={{ flex: '0 0 auto', height: 18, px: 0.75, typography: 'caption', lineHeight: 1 }} /> : null}
                </Box>
                {/* Each step behind the centred card is a little darker. */}
                <Box aria-hidden="true" sx={theme => ({ position: 'absolute', inset: 0, pointerEvents: 'none', bgcolor: alpha(theme.palette.common.black, grow ? 0 : place.dim), transition: motion === 'none' ? 'none' : 'background-color 200ms linear' })} />
              </Box>
            </ButtonBase>
          );
        })}
      </Box>
      {count ? null : (
        <Typography variant="body2" color="text.secondary" sx={{ position: 'absolute', left: 16, right: 16, top: '45%', textAlign: 'center' }}>{t('No other recent sessions')}</Typography>
      )}
      {/* The position dots (oldest on the left, as the stack lies) and the hint. */}
      {count > 1 ? (
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
            <Keys keys={['Esc']} />
            <span>{t('close')}</span>
          </>
        )}
      </Box>
    </Box>
  );
  return createPortal(content, document.body);
}

function Keys({ keys }) {
  return keys.map(key => (
    <Box key={key} component="kbd" sx={{ typography: 'caption', fontFamily: MONO, px: 0.75, borderRadius: 1, bgcolor: 'action.selected', color: 'text.primary' }}>{key}</Box>
  ));
}
