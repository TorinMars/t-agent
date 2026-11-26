import { useLayoutEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { alpha } from '@mui/material/styles';
import { t } from './common.jsx';
import { MONTHS, WEEK, dayEvents, lunarOfDate, monthGrid, monthTitle, occasionText } from './calendar-model.mjs';
import { DAY_MINUTES, allDayEvents, nowColumn, nowMinutes, scrollHour, timeRange, timedLayout } from './calendar-views.mjs';
import { HUE, dayWords, durationWords } from './CalendarParts.jsx';
import { lunarText } from './Attention.jsx';
import { TOUCH } from './theme.mjs';

// The views of the T-Attention calendar besides the computer month ("Views" in docs/design/page-attention-calendar.md): the phone month (large
// cells), the week and day time grid, the phone day's week strip and the year (phone: 3 x 4 months a tap opens; computer: 4 x 3 months whose days
// are selected). Pure drawing: the state (view, selected day) is AttentionCalendar.jsx's, the layout calendar-views.mjs's.

const FOCUS = theme => ({ '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.light}`, outlineOffset: -2 } });
// The letter of a weekday: S M T W T F S in English, in Chinese the last character of the translated day name (as the existing month grid).
const letterOf = day => { const name = t(day.long); return name !== day.long && name ? name.slice(-1) : day.letter; };
// The accessible name of a day: its date, then what is on it ("nothing" when empty).
export const dayName = (date, events) => `${dayWords(date)}: ${events.length ? events.map(event => event.item.title).join(', ') : t('nothing')}`;
const eventTitle = event => { const occasion = occasionText(event.kind, event.years); return `${event.item.title}${occasion ? ` · ${t(occasion)}` : ''}`; };
const tintOf = (theme, kind, strength = 0.28) => (kind === 'todo'
  ? { border: `1px solid ${theme.palette.text.secondary}`, color: theme.palette.text.primary, bgcolor: 'transparent' }
  : { bgcolor: alpha(HUE(theme, kind).main, strength), color: HUE(theme, kind).light });

// A swipe left or right with one finger moves the view by its unit (touch only; a vertical move scrolls as before, nothing is prevented).
export function useSwipe(onSwipe) {
  const start = useRef(null);
  if (!onSwipe) return {};
  return {
    onTouchStart: event => { const touch = event.touches[0]; start.current = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY, at: Date.now() } : null; },
    onTouchEnd: event => {
      const from = start.current;
      start.current = null;
      const touch = event.changedTouches[0];
      if (!from || !touch) return;
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && Date.now() - from.at < 800) onSwipe(dx < 0 ? 1 : -1);
    },
    onTouchCancel: () => { start.current = null; },
  };
}

// ── The phone month: large cells that fill the screen ──
// Each day a button: the number (today filled, the selected day ringed), the lunar day under it, up to two chips (the second "+N more" when there
// are more than two); a tap opens the day. Roving focus and the keys of the computer month (`onKey`).
function SmallChip({ event, more }) {
  return (
    <Box
      component="span" className={more ? 'h5-cal-more' : 'h5-cal-chip'} data-kind={more ? undefined : event.kind} data-key={more ? undefined : event.key} aria-hidden="true"
      sx={theme => ({
        display: 'block', height: 16, lineHeight: '16px', boxSizing: 'border-box', borderRadius: 0.5, px: '3px', fontSize: 10, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        ...(more ? { color: 'text.secondary' } : { ...tintOf(theme, event.kind), ...(event.kind === 'todo' ? { lineHeight: '14px' } : {}) }),
      })}
    >{more || eventTitle(event)}</Box>
  );
}
export function PhoneMonth({ grid, events, selected, todayDate, onDay, onKey, swipe }) {
  const weeks = [];
  for (let i = 0; i < grid.cells.length; i += 7) weeks.push(grid.cells.slice(i, i + 7));
  return (
    <Box id="h5-cal-grid" role="grid" aria-labelledby="h5-cal-title" data-view="month" onKeyDown={onKey} {...swipe} sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box role="row" sx={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', pb: 0.5, borderBottom: 1, borderColor: 'divider' }}>
        {WEEK.map(day => (
          <Box key={day.long} role="columnheader" aria-label={t(day.long)} sx={{ textAlign: 'center', typography: 'caption', color: 'text.secondary' }}>
            <span aria-hidden="true" translate="no">{letterOf(day)}</span>
          </Box>
        ))}
      </Box>
      <Box className="h5-cal-weeks" sx={{ flex: '1 1 auto', minHeight: 0, display: 'grid', gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map(week => (
          <Box key={week[0].date} role="row" sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', minHeight: 0, borderBottom: 1, borderColor: 'divider' }}>
            {week.map(cell => {
              const list = dayEvents(events, cell.date);
              const isSelected = cell.date === selected;
              const isToday = cell.date === todayDate;
              const shown = list.length > 2 ? [list[0]] : list;
              return (
                <Box key={cell.date} role="gridcell" aria-selected={isSelected} sx={{ minWidth: 0, minHeight: 0, display: 'flex' }}>
                  <ButtonBase
                    className="h5-cal-cell" data-date={cell.date} data-in-month={cell.inMonth ? 'true' : undefined} data-today={isToday ? 'true' : undefined} data-selected={isSelected ? 'true' : undefined}
                    data-count={list.length} tabIndex={isSelected ? 0 : -1} aria-label={dayName(cell.date, list)} aria-current={isToday ? 'date' : undefined} onClick={() => onDay(cell.date)}
                    sx={theme => ({
                      flex: '1 1 auto', minWidth: 0, minHeight: 44, display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', gap: '2px', p: '4px 2px 2px', overflow: 'hidden',
                      color: cell.inMonth ? 'text.primary' : 'text.disabled', ...FOCUS(theme),
                    })}
                  >
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <Box
                        component="span" className="h5-cal-num"
                        sx={theme => ({ width: 26, height: 26, boxSizing: 'border-box', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', typography: 'body2', ...(isToday ? { bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 700 } : isSelected ? { border: `2px solid ${theme.palette.primary.main}` } : {}) })}
                      >{cell.day}</Box>
                      <Box component="span" className="h5-cal-lunar" aria-hidden="true" sx={{ height: 12, fontSize: 10, lineHeight: '12px', color: 'text.secondary', whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '100%' }}>
                        {cell.inMonth ? lunarText(lunarOfDate(cell.date), { prefix: null, short: true }) : ''}
                      </Box>
                    </Box>
                    {shown.map(event => <SmallChip key={event.key} event={event} />)}
                    {list.length > 2 ? <SmallChip more={t(`+${list.length - 1} more`)} /> : null}
                  </ButtonBase>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ── The phone day: the week strip ──
// The seven days of the week of the selected day (a tap selects one, the view stays the day), today filled, the selected day ringed.
export function WeekStrip({ days, selected, todayDate, onSelect }) {
  return (
    <Box id="h5-cal-strip" role="group" aria-label={t('Days of the week')} sx={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', borderBottom: 1, borderColor: 'divider' }}>
      {days.map((date, index) => {
        const isToday = date === todayDate;
        const isSelected = date === selected;
        return (
          <ButtonBase
            key={date} className="h5-cal-strip-day" data-date={date} aria-label={dayWords(date)} aria-current={isToday ? 'date' : undefined} aria-pressed={isSelected} onClick={() => onSelect(date)}
            sx={theme => ({ minHeight: 52, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', py: 0.5, borderRadius: 1, ...FOCUS(theme) })}
          >
            <Box component="span" aria-hidden="true" translate="no" sx={{ typography: 'caption', fontSize: 11, color: 'text.secondary' }}>{letterOf(WEEK[index])}</Box>
            <Box
              component="span" aria-hidden="true"
              sx={theme => ({ width: 30, height: 30, boxSizing: 'border-box', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', typography: 'body2', ...(isToday ? { bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 700 } : isSelected ? { border: `2px solid ${theme.palette.primary.main}` } : {}) })}
            >{Number(date.slice(8))}</Box>
          </ButtonBase>
        );
      })}
    </Box>
  );
}

// ── The week and day time grid ──
// `days`: the dates of the columns (7 or 1). The heads (the week view, and the computer day: the weekday, the number a tap opens as a day, the lunar
// day on a computer), the all-day row (to-dos, birthdays, anniversaries, all-day schedules) and the 24 hours: each timed event a block from its
// start for its duration (1 hour without one, at least 30 minutes drawn), overlapping events side by side, the red "now" line in today's column.
// The hours scroll to about now on today, else to 8:00, when the view or its days change.
const HOUR_LABELS = Array.from({ length: 24 }, (unused, hour) => `${String(hour).padStart(2, '0')}:00`);
export function TimeGrid({ view, days, events, todayDate, now, wide, selected, heads = true, onOpen, onDay, swipe }) {
  const hour = wide ? 48 : view === 'week' ? 40 : 48;
  const gutter = wide ? 56 : 44;
  const compact = !wide && view === 'week';
  const scrollRef = useRef(null);
  const minutes = nowMinutes(now);
  const today = nowColumn(days, todayDate);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = scrollHour(today >= 0 ? todayDate : days[0], todayDate, minutes) * hour;
  }, [view, days[0], hour]); // eslint-disable-line react-hooks/exhaustive-deps
  const allDay = days.map(date => allDayEvents(dayEvents(events, date)));
  const columns = `${gutter}px repeat(${days.length}, minmax(0, 1fr))`;
  return (
    <Box id="h5-cal-time" data-view={view} data-hour={hour} {...swipe} sx={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {heads ? (
        <Box id="h5-cal-heads" sx={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: columns, borderBottom: 1, borderColor: 'divider' }}>
          <span />
          {days.map(date => {
            const isToday = date === todayDate;
            const isSelected = date === selected && days.length > 1;
            const p = Number(date.slice(8));
            return (
              <ButtonBase
                key={date} className="h5-cal-head" data-date={date} aria-label={dayWords(date)} aria-current={isToday ? 'date' : undefined} onClick={() => onDay(date)}
                sx={theme => ({ minWidth: 0, minHeight: 44, display: 'flex', flexDirection: wide ? 'row' : 'column', alignItems: 'center', justifyContent: wide ? 'flex-start' : 'center', gap: wide ? 1 : '2px', px: wide ? 1 : 0, py: 0.5, ...FOCUS(theme) })}
              >
                <Box component="span" aria-hidden="true" translate="no" sx={{ typography: 'caption', color: 'text.secondary' }}>{wide ? t(WEEK[new Date(`${date}T12:00:00Z`).getUTCDay()].short) : letterOf(WEEK[new Date(`${date}T12:00:00Z`).getUTCDay()])}</Box>
                <Box
                  component="span" aria-hidden="true"
                  sx={theme => ({ width: 28, height: 28, flex: '0 0 auto', boxSizing: 'border-box', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', typography: 'body2', ...(isToday ? { bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 700 } : isSelected ? { border: `2px solid ${theme.palette.primary.main}` } : {}) })}
                >{p}</Box>
                {wide ? <Box component="span" className="h5-cal-lunar" aria-hidden="true" sx={{ typography: 'caption', color: 'text.secondary', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lunarText(lunarOfDate(date), { prefix: null, short: true })}</Box> : null}
              </ButtonBase>
            );
          })}
        </Box>
      ) : null}
      <Box id="h5-cal-allday" sx={{ flex: '0 0 auto', display: 'grid', gridTemplateColumns: columns, minHeight: 28, maxHeight: 112, overflowY: 'auto', py: 0.5, boxSizing: 'border-box', borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ alignSelf: 'center', textAlign: 'center', fontSize: 10, color: 'text.secondary' }}>{t('all-day')}</Box>
        {days.map((date, index) => (
          <Box key={date} className="h5-cal-allday-col" data-date={date} sx={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px', px: '2px' }}>
            {allDay[index].map(event => (
              <ButtonBase
                key={event.key} className="h5-cal-allday-event" data-key={event.key} data-kind={event.kind} aria-label={eventTitle(event)} onClick={() => onOpen(event.key)}
                sx={theme => ({ display: 'block', minHeight: compact ? 18 : 22, boxSizing: 'border-box', borderRadius: 0.5, px: compact ? '3px' : 0.75, fontSize: compact ? 10 : 12, lineHeight: compact ? '18px' : '22px', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...tintOf(theme, event.kind), ...FOCUS(theme) })}
              ><span aria-hidden="true">{eventTitle(event)}</span></ButtonBase>
            ))}
          </Box>
        ))}
      </Box>
      <Box id="h5-cal-hours" ref={scrollRef} sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <Box sx={{ position: 'relative', height: 24 * hour + 16 }}>
          {HOUR_LABELS.map((label, index) => (
            <Box key={label} aria-hidden="true" sx={{ position: 'absolute', left: 0, right: 0, top: 8 + index * hour, height: 0 }}>
              <Box sx={{ position: 'absolute', left: 0, width: gutter - 6, top: -7, textAlign: 'right', fontSize: 11, lineHeight: '14px', color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{index ? label : ''}</Box>
              <Box sx={{ position: 'absolute', left: gutter, right: 0, top: 0, borderTop: 1, borderColor: 'divider' }} />
            </Box>
          ))}
          <Box sx={{ position: 'absolute', left: gutter, right: 0, top: 8, height: 24 * hour, display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((date, index) => (
              <Box key={date} className="h5-cal-col" data-date={date} role="list" aria-label={dayWords(date)} sx={{ position: 'relative', minWidth: 0, borderLeft: 1, borderColor: 'divider' }}>
                {timedLayout(dayEvents(events, date)).map(block => {
                  const range = timeRange(block.event) || block.event.time;
                  const tall = (block.end - block.start) / 60 * hour >= 34;
                  return (
                    <ButtonBase
                      key={block.event.key} role="listitem" className="h5-cal-block" data-key={block.event.key} data-kind={block.event.kind} data-start={block.start} data-end={block.end} data-col={block.col} data-cols={block.cols}
                      aria-label={`${eventTitle(block.event)}, ${range}${block.event.duration ? ` (${durationWords(block.event.duration)})` : ''}`} onClick={() => onOpen(block.event.key)}
                      sx={theme => ({
                        position: 'absolute', top: block.start / 60 * hour, height: Math.max(12, (block.end - block.start) / 60 * hour - 2),
                        left: `calc(${(block.col / block.cols) * 100}% + 2px)`, width: `calc(${100 / block.cols}% - 4px)`,
                        display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', boxSizing: 'border-box', borderRadius: 0.5, px: compact ? '2px' : 0.5, py: '2px',
                        overflow: 'hidden', textAlign: 'left', fontSize: compact ? 10 : wide ? 12 : 13, lineHeight: 1.2, ...tintOf(theme, block.event.kind), ...FOCUS(theme),
                      })}
                    >
                      <Box component="span" aria-hidden="true" className="h5-cal-block-title" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: compact ? 'normal' : 'nowrap', overflowWrap: 'normal', wordBreak: 'normal' }}>{eventTitle(block.event)}</Box>
                      {tall && !compact ? <Box component="span" aria-hidden="true" className="h5-cal-block-time" sx={{ fontSize: 11, opacity: 0.85, whiteSpace: 'nowrap' }}>{range}</Box> : null}
                    </ButtonBase>
                  );
                })}
                {index === today ? (
                  <Box id="h5-cal-now" aria-hidden="true" data-minutes={minutes} sx={{ position: 'absolute', left: 0, right: 0, top: (minutes / DAY_MINUTES) * 24 * hour, height: 0, borderTop: 2, borderColor: 'error.main', zIndex: 1, pointerEvents: 'none' }}>
                    <Box sx={{ position: 'absolute', left: -5, top: -5, width: 8, height: 8, borderRadius: '50%', bgcolor: 'error.main' }} />
                  </Box>
                ) : null}
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// ── The year ──
// `marks` (yearMarks): the days with something on them (a dot in the primary colour) and with a birthday or an anniversary (a pink dot).
const dotOf = (theme, mark) => (mark === 'special' ? theme.palette.calendar.birthday : mark === 'busy' ? theme.palette.primary.main : 'transparent');
function MiniDays({ grid, marks, todayDate, selected, wide, onSelect, onDay }) {
  const { cells } = grid;
  const size = wide ? 22 : 14;
  return (
    <Box role={wide ? 'rowgroup' : undefined} sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', rowGap: wide ? 0 : '1px' }}>
      {cells.map(cell => {
        if (!cell.inMonth) return <Box key={cell.date} aria-hidden="true" sx={{ height: wide ? 26 : 16 }} />;
        const isToday = cell.date === todayDate;
        const isSelected = wide && cell.date === selected;
        const mark = marks.get(cell.date);
        const number = (
          <Box
            component="span" aria-hidden="true" className="h5-cal-yday-num"
            sx={theme => ({ minWidth: size, height: size, boxSizing: 'border-box', borderRadius: size / 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: wide ? 12 : 10, lineHeight: 1, ...(isToday ? { bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 700 } : isSelected ? { border: `2px solid ${theme.palette.primary.main}` } : {}) })}
          >{cell.day}</Box>
        );
        const dot = <Box component="span" aria-hidden="true" className="h5-cal-ydot" data-mark={mark || undefined} sx={theme => ({ position: 'absolute', bottom: wide ? 0 : -1, left: '50%', ml: '-2px', width: 4, height: 4, borderRadius: '50%', bgcolor: dotOf(theme, mark) })} />;
        if (!wide) return <Box key={cell.date} className="h5-cal-yday" data-date={cell.date} data-today={isToday ? 'true' : undefined} sx={{ position: 'relative', height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{number}{dot}</Box>;
        return (
          <Box key={cell.date} role="gridcell" aria-selected={isSelected} sx={{ display: 'flex', justifyContent: 'center' }}>
            <ButtonBase
              className="h5-cal-yday" data-date={cell.date} data-today={isToday ? 'true' : undefined} data-selected={isSelected ? 'true' : undefined} data-mark={mark || undefined}
              tabIndex={isSelected ? 0 : -1} aria-label={`${dayWords(cell.date)}${mark ? '' : `: ${t('nothing')}`}`} aria-current={isToday ? 'date' : undefined}
              onClick={() => onSelect(cell.date)} onDoubleClick={() => onDay(cell.date)}
              sx={theme => ({ position: 'relative', width: 30, height: 26, borderRadius: 1, ...FOCUS(theme), '&:hover': { bgcolor: 'action.hover' } })}
            >{number}{dot}</ButtonBase>
          </Box>
        );
      })}
    </Box>
  );
}
export function YearView({ year, marks, todayDate, selected, wide, onSelect, onDay, onMonth, onKey }) {
  const months = MONTHS.map(month => month.n);
  const count = month => [...marks.keys()].filter(date => Number(date.slice(5, 7)) === month && date.startsWith(`${year}-`)).length;
  const current = todayDate.startsWith(`${year}-`) ? Number(todayDate.slice(5, 7)) : null;
  const selectedMonth = Number(selected.slice(5, 7));
  return (
    <Box
      id="h5-cal-year" data-year={year} onKeyDown={onKey}
      sx={{ flex: '1 1 auto', minHeight: 0, display: 'grid', gridTemplateColumns: `repeat(${wide ? 4 : 3}, minmax(0, 1fr))`, gridTemplateRows: wide ? 'none' : 'repeat(4, minmax(0, 1fr))', columnGap: wide ? 3 : 1.5, rowGap: wide ? 1.5 : 0, px: wide ? 0 : 1.5, pt: 0.5, overflowY: wide ? 'auto' : 'hidden' }}
    >
      {months.map(month => {
        const { cells } = monthGrid(year, month);
        const title = t(MONTHS[month - 1].long);
        const name = title !== MONTHS[month - 1].long ? title : MONTHS[month - 1].short;
        const label = `${t(monthTitle(year, month))}: ${t(`${count(month)} days with something`)}`;
        if (!wide) {
          return (
            <ButtonBase
              key={month} className="h5-cal-ymonth" data-month={`${year}-${String(month).padStart(2, '0')}`} tabIndex={month === selectedMonth ? 0 : -1} aria-label={label} onClick={() => onMonth(month)}
              sx={theme => ({ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start', gap: '2px', py: 0.25, overflow: 'hidden', borderRadius: 1, ...FOCUS(theme) })}
            >
              <Box component="span" aria-hidden="true" sx={{ typography: 'body2', fontWeight: 500, textAlign: 'left', color: month === current ? 'primary.light' : 'text.primary' }}>{name}</Box>
              <MiniDays grid={{ cells }} marks={marks} todayDate={todayDate} selected={selected} />
            </ButtonBase>
          );
        }
        return (
          <Box key={month} className="h5-cal-ymonth" data-month={`${year}-${String(month).padStart(2, '0')}`} sx={{ minWidth: 0 }}>
            <ButtonBase
              className="h5-cal-ymonth-title" onClick={() => onMonth(month)} aria-label={label}
              sx={theme => ({ typography: 'subtitle1', fontWeight: 500, px: 0.5, minHeight: 28, borderRadius: 1, color: month === current ? 'primary.light' : 'text.primary', ...FOCUS(theme) })}
            >{name}</ButtonBase>
            <Box role="grid" aria-label={t(monthTitle(year, month))}>
              <Box role="row" sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
                {WEEK.map(day => <Box key={day.long} role="columnheader" aria-label={t(day.long)} sx={{ textAlign: 'center', fontSize: 11, color: 'text.secondary' }}><span aria-hidden="true" translate="no">{letterOf(day)}</span></Box>)}
              </Box>
              <MiniDays grid={{ cells }} marks={marks} todayDate={todayDate} selected={selected} wide onSelect={onSelect} onDay={onDay} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
// The legend of the year: "A day with something on it", "Birthday or anniversary".
export function YearLegend() {
  return (
    <Box id="h5-cal-year-legend" sx={{ flex: '0 0 auto', display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5, px: 2, py: 1, typography: 'caption', color: 'text.secondary', [TOUCH]: { pr: 10 } }}>
      {[['busy', 'A day with something on it'], ['special', 'Birthday or anniversary']].map(([mark, label]) => (
        <Box component="span" key={mark} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          <Box component="span" aria-hidden="true" sx={theme => ({ width: 6, height: 6, borderRadius: '50%', bgcolor: dotOf(theme, mark) })} />{t(label)}
        </Box>
      ))}
    </Box>
  );
}
