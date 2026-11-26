import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import ListItemButton from '@mui/material/ListItemButton';
import NativeSelect from '@mui/material/NativeSelect';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { DialogError, deviceParts, deviceText, errorText, named, t, useShared } from './common.jsx';
import { writeShared } from './shared-store.mjs';
import { DeviceTag } from './TaskDrawer.jsx';
import { shortName } from './task-order.mjs';
import { Field } from './Form.jsx';
import { Icon } from './Icons.jsx';
import { keyOf, engineOf, ruleTokens, scheduleOf, today } from './attention-model.mjs';
import { durationOn, scheduleForm, scheduleFromForm, yearlyOn, yearlyWords } from './attention-schedule.mjs';
import {
  WEEK, addDays, calendarEvents, comingUp, dayEvents, dayTitle, lunarOfDate, monthGrid, nextYearly, noDateItems, occasionText,
  occasionTitle, partsOfDate, yearlySchedule,
} from './calendar-model.mjs';
import { CAL_VIEWS, CAL_VIEW_KEY, allDayEvents, calViewOf, shiftView, timeOf, endOf, viewRange, viewTitle, weekOf, yearMarks } from './calendar-views.mjs';
import { ADD_ON_KEY, ScheduleFields, Words, YearlyFields, lunarText } from './Attention.jsx';
import { HUE, KindDot, dayWords, durationWords, wordOr } from './CalendarParts.jsx';
import { PhoneMonth, TimeGrid, WeekStrip, YearLegend, YearView, dayName, useSwipe } from './CalendarViews.jsx';
import { TOUCH } from './theme.mjs';

// The calendar view of T-Attention ("Calendar view" in docs/design/page-attention-calendar.md): the month (Sunday first), each day's events from
// every engine's items (calendar-model.mjs), the selected day's agenda and "N to do without a date"; a phone draws dots in 48px day buttons and a
// floating + button, a computer (the sheet then takes the whole window right of the rail) chips in each cell, the lunar day in its corner and a
// 320px day panel with "Coming up". A tap on an event opens the item's edit view (the list's, Attention.jsx). New event: One-off and Repeats reuse
// the When and Then fields; Birthday and Anniversary make a yearly rule, solar or lunar, on an engine that takes it (`attention:yearly`).

const LEGEND = [['once', 'Once'], ['repeat', 'Repeats'], ['birthday', 'Birthday'], ['anniversary', 'Anniversary'], ['todo', 'To do']];
// The second line of an agenda row: the rule (Once, Every 3 days 18:00, Every year Nov 15), "turns 62" or "8th anniversary" and the lunar date of a
// lunar rule, or "To do" for a due date.
function eventLine(event) {
  const occasion = occasionText(event.kind, event.years);
  if (event.kind === 'birthday' || event.kind === 'anniversary') {
    return [t(event.kind === 'birthday' ? 'Birthday' : 'Anniversary'), occasion ? t(occasion) : null, event.lunar ? lunarText(event.lunar) : null].filter(Boolean).join(' · ');
  }
  if (event.kind === 'todo') return t('To do');
  return null;
}

// One event of the agenda: the time (or "All day"), the kind's dot, the title and its line; a to do has the round "Mark as done" button at the end.
function AgendaRow({ event, ui, tag, onOpen }) {
  const { item } = event;
  const line = eventLine(event);
  const schedule = scheduleOf(item);
  const done = async () => {
    try { await ui.actions.attentionUpdate(keyOf(item), { status: 'done' }); }
    catch (error) { ui.notify(`${t('Could not update the task')}: ${error.message}`, 'error'); }
  };
  return (
    <Box className="h5-cal-event" data-key={keyOf(item)} data-kind={event.kind} data-date={event.date} role="listitem" sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
      <ListItemButton className="h5-cal-event-open" onClick={() => onOpen(keyOf(item))} sx={{ flex: '1 1 auto', minWidth: 0, minHeight: 56, gap: 1.5, px: 1, py: 0.75 }}>
        <Box component="span" className="h5-cal-event-time" sx={{ flex: '0 0 auto', width: 48, typography: 'body2', color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
          {event.time || t('All day')}
          {event.time && event.duration ? <Box component="span" className="h5-cal-event-end" sx={{ display: 'block', typography: 'caption' }}>{timeOf(endOf(event))}</Box> : null}
        </Box>
        <KindDot kind={event.kind} size={8} />
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            {tag ? <Box component="span" sx={{ flex: '0 0 auto', display: 'inline-flex' }}><DeviceTag device={tag} /></Box> : null}
            <Box className="h5-cal-event-title" sx={{ minWidth: 0, typography: 'body1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</Box>
          </Box>
          <Box className="h5-cal-event-line" sx={{ typography: 'body2', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {line || (schedule ? <Words tokens={schedule.rule && schedule.rule.freq === 'yearly' ? yearlyWords(schedule) : ruleTokens(schedule)} /> : null)}
            {!line && event.duration ? ` · ${durationWords(event.duration)}` : !line && event.allDay && schedule ? ` · ${t('all day')}` : ''}
          </Box>
        </Box>
      </ListItemButton>
      {event.kind === 'todo' ? (
        <IconButton className="h5-cal-event-done" {...named(t('Mark as done'))} onClick={() => void done()} sx={{ flex: '0 0 auto', mr: 0.5, color: 'text.secondary' }}><Icon name="attentionOpen" size={22} /></IconButton>
      ) : null}
    </Box>
  );
}

// The selected day: its title, its lunar date, its events (or "Nothing on this day"), then the "N to do without a date" row.
function DayAgenda({ date, events, ui, tagOf, onOpen, undated, onUndated, wide, upcoming, onDay, allDayOnly = false }) {
  const lunar = lunarOfDate(date);
  return (
    <Box id="h5-cal-day" component="section" aria-labelledby="h5-cal-day-title" data-all-day={allDayOnly ? 'true' : undefined} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1, justifyContent: 'space-between', px: wide ? 0 : 1 }}>
        <Typography id="h5-cal-day-title" variant={wide ? 'h6' : 'subtitle1'} component="h3" sx={{ fontWeight: 500 }}>
          {onDay ? (
            <ButtonBase id="h5-cal-day-open" onClick={() => onDay(date)} title={t('Open the day')} sx={theme => ({ font: 'inherit', borderRadius: 1, px: 0.5, mx: -0.5, '&:hover': { color: 'primary.light' }, '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.light}` } })}>{dayWords(date)}</ButtonBase>
          ) : dayWords(date)}
        </Typography>
        {lunar ? <Typography id="h5-cal-day-lunar" variant="caption" color="text.secondary">{lunarText(lunar)}</Typography> : null}
      </Box>
      {allDayOnly ? <Typography variant="overline" component="h4" color="text.secondary" sx={{ display: 'block', lineHeight: 2, mt: 1 }}>{t('All day')}</Typography> : null}
      <Box id="h5-cal-agenda" role="list" aria-labelledby="h5-cal-day-title">
        {events.map(event => <AgendaRow key={`${event.key}:${event.date}`} event={event} ui={ui} tag={tagOf(engineOf(event.item))} onOpen={onOpen} />)}
      </Box>
      {events.length ? null : <Typography id="h5-cal-day-empty" variant="body2" color="text.secondary" sx={{ px: wide ? 0 : 1, py: 1.5 }}>{t(allDayOnly ? 'None' : 'Nothing on this day')}</Typography>}
      {upcoming ? (
        <Box id="h5-cal-coming" component="section" aria-labelledby="h5-cal-coming-title" sx={{ mt: 2 }}>
          <Typography id="h5-cal-coming-title" variant="overline" component="h3" color="text.secondary" sx={{ display: 'block', lineHeight: 2 }}>{t('Coming up')}</Typography>
          {upcoming.length ? upcoming.map(event => (
            <ListItemButton key={`${event.key}:${event.date}`} className="h5-cal-coming-row" data-key={event.key} data-date={event.date} onClick={() => onOpen(event.key)} sx={{ minHeight: 40, px: 0, gap: 1 }}>
              <KindDot kind={event.kind} />
              <Box sx={{ flex: '1 1 auto', minWidth: 0, typography: 'body2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{`${dayWords(event.date, true)} · `}<span>{event.item.title}</span></Box>
              <Box component="span" sx={{ flex: '0 0 auto', typography: 'caption', color: theme => (event.lunar ? HUE(theme, event.kind).light : theme.palette.text.secondary) }}>{event.lunar ? t('Lunar') : event.time || t(event.kind === 'todo' ? 'To do' : 'All day')}</Box>
            </ListItemButton>
          )) : <Typography variant="body2" color="text.secondary">{t('Nothing in the next 45 days')}</Typography>}
        </Box>
      ) : null}
      {undated.length ? (
        <ButtonBase id="h5-cal-undated" onClick={onUndated} sx={{ mt: 0.5, minHeight: 44, px: wide ? 0 : 1, justifyContent: 'space-between', typography: 'body2', color: 'primary.light', borderRadius: 1 }}>
          <span>{t(`${undated.length} to do without a date`)}</span>
          <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex' }}><Icon name="treeChevron" size={14} /></Box>
        </ButtonBase>
      ) : null}
    </Box>
  );
}

// The computer month grid: role grid, a row per week, each day a gridcell holding its button (roving focus: the selected day is the one Tab stop; the
// arrow keys move a day or a week, Home / End to the week's ends, Page Up / Page Down a month). A cell: the number, the lunar day in the corner and up
// to two chips and "+N more"; a click selects the day (the panel shows it), a double click opens it in the Day view. (The phone month is PhoneMonth
// of CalendarViews.jsx.)
function MonthGrid({ grid, events, selected, todayDate, onSelect, onKey, onDay }) {
  const weeks = [];
  for (let i = 0; i < grid.cells.length; i += 7) weeks.push(grid.cells.slice(i, i + 7));
  return (
    <Box id="h5-cal-grid" role="grid" aria-labelledby="h5-cal-title" data-view="month" onKeyDown={onKey} sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box role="row" sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', pb: 0.5 }}>
        {WEEK.map(day => (
          <Box key={day.long} role="columnheader" aria-label={t(day.long)} sx={{ textAlign: 'left', pl: 1, typography: 'caption', color: 'text.secondary' }}>
            <span aria-hidden="true">{t(day.short)}</span>
          </Box>
        ))}
      </Box>
      <Box className="h5-cal-weeks" sx={{ flex: '1 1 auto', minHeight: 0, display: 'grid', gridTemplateRows: `repeat(${weeks.length}, minmax(88px, 1fr))`, borderTop: 1, borderLeft: 1, borderColor: 'divider' }}>
        {weeks.map(week => (
          <Box key={week[0].date} role="row" sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', minHeight: 0 }}>
            {week.map(cell => {
              const list = dayEvents(events, cell.date);
              const isSelected = cell.date === selected;
              const isToday = cell.date === todayDate;
              return (
                <Box key={cell.date} role="gridcell" aria-selected={isSelected} sx={{ borderRight: 1, borderBottom: 1, borderColor: 'divider', minWidth: 0, minHeight: 0, display: 'flex' }}>
                  <ButtonBase
                    className="h5-cal-cell" data-date={cell.date} data-in-month={cell.inMonth ? 'true' : undefined} data-today={isToday ? 'true' : undefined} data-selected={isSelected ? 'true' : undefined}
                    data-count={list.length} tabIndex={isSelected ? 0 : -1} aria-label={dayName(cell.date, list)} aria-current={isToday ? 'date' : undefined} onClick={() => onSelect(cell.date)} onDoubleClick={() => onDay(cell.date)}
                    sx={theme => ({
                      flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', alignItems: 'stretch', justifyContent: 'flex-start', gap: '3px', p: '4px 6px',
                      color: cell.inMonth ? 'text.primary' : 'text.disabled',
                      '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.light}`, outlineOffset: -2 },
                      bgcolor: isSelected ? alpha(theme.palette.primary.main, 0.12) : isToday ? alpha(theme.palette.primary.main, 0.06) : 'transparent', '&:hover': { bgcolor: alpha(theme.palette.primary.main, isSelected ? 0.16 : 0.06) },
                    })}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
                      <Box component="span" className="h5-cal-num" sx={{ width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', typography: 'body2', ...(isToday ? { bgcolor: 'primary.main', color: 'primary.contrastText' } : {}) }}>{cell.day}</Box>
                      {cell.inMonth ? <Box component="span" className="h5-cal-lunar" aria-hidden="true" sx={{ typography: 'caption', fontSize: 11, color: 'text.secondary', whiteSpace: 'nowrap', overflow: 'hidden' }}>{lunarText(lunarOfDate(cell.date), { prefix: null })}</Box> : null}
                    </Box>
                    {list.slice(0, 2).map(event => <Chip key={event.key} event={event} />)}
                    {list.length > 2 ? <Box component="span" className="h5-cal-more" sx={{ typography: 'caption', color: 'text.secondary', textAlign: 'left', px: 0.75 }}>{t(`+${list.length - 2} more`)}</Box> : null}
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
// An event chip of a computer cell: tinted with its kind's colour (a to do outlined), its title and, for a birthday or anniversary, its number.
function Chip({ event }) {
  const occasion = occasionText(event.kind, event.years);
  const text = `${event.time && event.kind === 'once' ? `${event.time} ` : ''}${event.item.title}${occasion ? ` · ${t(occasion)}` : ''}`;
  return (
    <Box
      component="span" className="h5-cal-chip" data-kind={event.kind} data-key={event.key} aria-hidden="true"
      sx={theme => ({
        display: 'block', height: 20, lineHeight: '20px', boxSizing: 'border-box', borderRadius: 0.5, px: 0.75, typography: 'caption', fontSize: 11, textAlign: 'left',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        ...(event.kind === 'todo'
          ? { border: 1, borderColor: 'text.secondary', color: 'text.primary', lineHeight: '18px' }
          : { bgcolor: alpha(HUE(theme, event.kind).main, 0.2), color: HUE(theme, event.kind).light }),
      })}
    >{text}</Box>
  );
}

function Legend() {
  return (
    <Box id="h5-cal-legend" sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.5, px: 1, py: 1, typography: 'caption', color: 'text.secondary' }}>
      {LEGEND.map(([kind, label]) => <Box component="span" key={kind} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}><KindDot kind={kind} />{t(label)}</Box>)}
    </Box>
  );
}

// "N to do without a date": the open items with neither a schedule nor a due date, in a dialog of the one pattern; a tap opens the item.
function UndatedDialog({ items, tagOf, onOpen, onClose }) {
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="h5-cal-undated-title" id="h5-cal-undated-dialog">
      <DialogTitle id="h5-cal-undated-title">{t('To do without a date')}</DialogTitle>
      <DialogContent dividers sx={{ px: 1 }}>
        <Box role="list">
          {items.map(item => (
            <ListItemButton key={keyOf(item)} role="listitem" className="h5-cal-undated-row" data-key={keyOf(item)} onClick={() => onOpen(keyOf(item))} sx={{ gap: 1, minHeight: 44 }}>
              {tagOf(engineOf(item)) ? <DeviceTag device={tagOf(engineOf(item))} /> : null}
              <Box sx={{ minWidth: 0, typography: 'body1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</Box>
            </ListItemButton>
          ))}
        </Box>
      </DialogContent>
      <DialogActions><Button id="h5-cal-undated-close" onClick={onClose}>{t('Close')}</Button></DialogActions>
    </Dialog>
  );
}

// ── New event ──
const KINDS = [['once', 'One-off'], ['repeat', 'Repeats'], ['birthday', 'Birthday'], ['anniversary', 'Anniversary']];
const NEXT_TITLE = { birthday: 'Next birthday', anniversary: 'Next anniversary' };
// The form of a new event from the selected day: the When form (`scheduleForm` of a new task) starting on that day, 1 hour long, and a yearly date
// on it.
function newForm(date) {
  const p = partsOfDate(date);
  const now = new Date(p.year, p.month - 1, p.day, 12);
  return { ...scheduleForm(null, now), when: 'once', onceDate: date, starts: date, title: '', calendar: 'solar', month: String(p.month), yearDay: String(p.day), leap: false, year: '', duration: '60' };
}
// An engine without `attention:duration` gets neither a duration nor all day (its form does not show them).
const NO_DURATION = { duration: '', durationCustom: false, allDay: false, endInput: null, endError: '' };
// The dialog (the one pattern; full screen on a phone, a long form): chips One-off / Repeats / Birthday / Anniversary, then the fields of that kind,
// and "on <engine>" when several engines take new items (the same choice as the list's quick add). Save: POST <engine> { title, schedule,
// then_action }. Birthday and Anniversary only on an engine with `attention:yearly`; another one says "This computer needs an update first".
function NewEventDialog({ ui, state, engines, date, wide, onClose }) {
  const [kind, setKind] = useState('once');
  const [form, setForm] = useState(() => newForm(date));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const on = useShared(ADD_ON_KEY);
  const picked = engines.find(engine => engine.key === on) || engines[0];
  const engine = picked ? picked.key : 'local';
  const yearly = yearlyOn(state.sources, engine) === true;
  const timing = durationOn(state.sources, engine) === true;
  const occasion = kind === 'birthday' || kind === 'anniversary' ? kind : null;
  useEffect(() => { if (occasion && !yearly) setKind('once'); }, [occasion, yearly]);
  const put = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const choose = value => {
    if (!value) return;
    setKind(value);
    setError('');
    if (value === 'once' || value === 'repeat') put('when', value);
  };
  const yearlyMade = occasion ? yearlySchedule(occasion, { calendar: form.calendar, month: form.month, day: form.yearDay, leap: form.leap, year: form.year }) : null;
  const next = useMemo(() => (yearlyMade && yearlyMade.schedule ? nextYearly(yearlyMade.schedule, today()) : null), [JSON.stringify(yearlyMade)]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async event => {
    if (event) event.preventDefault();
    if (busy) return;
    const name = String(form.title || '').trim();
    if (!name) { setError(t(occasion ? 'Write a name' : 'Write a title')); return; }
    let body;
    if (occasion) {
      if (yearlyMade.error) { setError(t(yearlyMade.error)); return; }
      body = { title: occasionTitle(occasion, name), schedule: yearlyMade.schedule };
    } else {
      const made = scheduleFromForm({ ...form, when: kind, ...(timing ? {} : NO_DURATION) });
      if (made.error) { setError(t(made.error)); return; }
      body = { title: name, schedule: made.schedule, ...(made.then_action && made.then_action.kind !== 'remind' ? { then_action: made.then_action } : {}) };
    }
    setBusy(true);
    setError('');
    try { await ui.actions.attentionCreate(body, engine); ui.notify(t('Saved'), 'success'); onClose(); }
    catch (failure) { setError(`${t('Could not save')}: ${errorText(failure)}`); }
    finally { setBusy(false); }
  };
  return (
    <Dialog
      open onClose={onClose} fullScreen={!wide} fullWidth maxWidth="sm" aria-labelledby="h5-cal-new-title" id="h5-cal-new"
      slotProps={{ paper: { component: 'form', noValidate: true, onSubmit: event => void save(event), sx: wide ? null : { pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' } } }}
    >
      <DialogTitle component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1, py: 1 }}>
        <Typography id="h5-cal-new-title" variant="h6" component="h2" sx={{ flex: '1 1 auto' }}>{t('New event')}</Typography>
        <IconButton id="h5-cal-new-close" {...named(t('Close'))} onClick={onClose}><Icon name="close" size={22} /></IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
        <ToggleButtonGroup
          id="h5-cal-new-kind" exclusive value={kind} onChange={(event, value) => choose(value)} aria-label={t('Kind of event')}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, '& .MuiToggleButtonGroup-grouped': { m: 0, border: 1, borderColor: 'divider', borderRadius: '8px !important', px: 1.75, minHeight: 44 } }}
        >
          {KINDS.filter(([value]) => yearly || (value !== 'birthday' && value !== 'anniversary')).map(([value, label]) => (
            <ToggleButton
              key={value} value={value} data-value={value}
              sx={theme => ({ '&.Mui-selected, &.Mui-selected:hover': { color: HUE(theme, value).light, bgcolor: alpha(HUE(theme, value).main, 0.14), borderColor: `${HUE(theme, value).main} !important` } })}
            >{t(label)}</ToggleButton>
          ))}
        </ToggleButtonGroup>
        {yearly ? null : <Typography id="h5-cal-new-update" variant="body2" color="text.secondary">{`${t('Birthdays and anniversaries')}: ${t('This computer needs an update first')}`}</Typography>}
        {engines.length > 1 ? (
          <NativeSelect
            value={engine} onChange={event => writeShared(ADD_ON_KEY, event.target.value)} disabled={busy} disableUnderline
            inputProps={{ id: 'h5-cal-new-on', 'aria-label': t('Add on'), title: deviceText(picked) }}
            sx={{ alignSelf: 'flex-start', maxWidth: 220, typography: 'body2', color: 'text.secondary', '& select': { py: 0, minHeight: 44, boxSizing: 'border-box', display: 'flex', alignItems: 'center' } }}
          >
            {engines.map(entry => <option key={entry.key} value={entry.key}>{`${t('on')} ${entry.local && !entry.name ? deviceParts(entry).name : shortName(deviceParts(entry).name, 16)}`}</option>)}
          </NativeSelect>
        ) : null}
        <Field id="h5-cal-new-name" label={occasion ? 'Name' : 'Title'} value={form.title} onChange={event => put('title', event.target.value)} htmlInput={{ maxLength: 300 }} autoFocus={wide} />
        {occasion ? (
          <>
            <YearlyFields ids="h5-cal-new-yearly" occasion={occasion} values={{ calendar: form.calendar, month: form.month, day: form.yearDay, leap: form.leap, year: form.year }} put={(key, value) => put(key === 'day' ? 'yearDay' : key, value)} />
            <Box id="h5-cal-new-next" role="status" sx={theme => ({ p: 2, borderRadius: 1, bgcolor: alpha(HUE(theme, kind).main, 0.08), display: 'flex', flexDirection: 'column', gap: 0.5 })}>
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.5 }}>{t(NEXT_TITLE[occasion])}</Typography>
              {yearlyMade.error ? <Typography variant="body2" color="error.light">{t(yearlyMade.error)}</Typography> : next ? (
                <>
                  <Typography id="h5-cal-new-next-date" variant="body1">
                    {t(`${dayTitle(next.date, { short: true })}, ${next.date.slice(0, 4)}`)}
                    {occasionText(occasion, next.years) ? ` · ${t(occasionText(occasion, next.years))}` : ''}
                  </Typography>
                  {form.calendar === 'lunar' ? <Typography id="h5-cal-new-next-lunar" variant="body2" color="text.secondary">{`${lunarText(next.lunar)}. ${t('The solar date changes every year.')}`}</Typography> : null}
                </>
              ) : <Typography variant="body2" color="text.secondary">{t('This date does not come in the next 100 years')}</Typography>}
            </Box>
          </>
        ) : (
          <ScheduleFields form={{ ...form, when: kind, ...(timing ? {} : NO_DURATION) }} setForm={setForm} item={{ engine }} state={state} fixed yearly={yearly} duration={timing} />
        )}
        {error ? <DialogError id="h5-cal-new-error" sx={{ mt: 0 }}>{error}</DialogError> : null}
      </DialogContent>
      <DialogActions>
        <Button id="h5-cal-new-cancel" onClick={onClose}>{t('Cancel')}</Button>
        <Button id="h5-cal-new-save" type="submit" variant="contained" disabled={busy}>{t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// The four views and their segment text: the English word, or the Chinese of "<View> view" ("Day" and "Month" are already the date fields' words).
const VIEW_WORDS = { year: 'Year', month: 'Month', week: 'Week', day: 'Day' };
const UNIT_WORDS = { year: ['Previous year', 'Next year'], month: ['Previous month', 'Next month'], week: ['Previous week', 'Next week'], day: ['Previous day', 'Next day'] };
// The day shown at first: the one chosen last while this page is loaded (not kept: a new page starts on today), else today.
let chosenDate = null;

// The calendar view. `items`: every engine's items (state.attention.items); `onOpen(key)`: the edit view of the list; `engines`: the engines a new
// item can go to; `wide`: the computer layout. The view (Year | Month | Week | Day, the shared page state `h5-attention-cal-view`) and the selected
// day drive everything: each view draws the days around that day, previous / next move it by the view's unit, and a switch keeps it.
export function AttentionCalendar({ ui, state, items, wide, open, tagOf, onOpen, engines }) {
  const todayDate = today();
  const view = calViewOf(useShared(CAL_VIEW_KEY));
  const [selected, setSelectedState] = useState(() => chosenDate || todayDate);
  const [now, setNow] = useState(() => new Date());
  const [adding, setAdding] = useState(false);
  const [undated, setUndated] = useState(false);
  const focusDay = useRef(false);
  const rootRef = useRef(null);
  const setSelected = date => { chosenDate = date; setSelectedState(date); };
  const setView = value => { if (value && value !== view) writeShared(CAL_VIEW_KEY, value); };
  const openDay = date => { setSelected(date); setView('day'); };
  const p = partsOfDate(selected);
  const grid = useMemo(() => monthGrid(p.year, p.month), [p.year, p.month]);
  const range = useMemo(() => viewRange(view, selected), [view, selected]);
  const events = useMemo(() => calendarEvents(items, range.from, range.to), [items, range.from, range.to]);
  const marks = useMemo(() => (view === 'year' ? yearMarks(events) : null), [view, events]);
  const week = useMemo(() => weekOf(selected), [selected]);
  const soon = useMemo(() => (wide ? comingUp(calendarEvents(items, addDays(selected, 1), addDays(selected, 45)), selected) : null), [wide, items, selected]);
  const noDate = useMemo(() => noDateItems(items), [items]);
  useEffect(() => { if (!open) { setAdding(false); setUndated(false); } }, [open]);
  // The "now" line moves every minute.
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60 * 1000); return () => clearInterval(timer); }, []);
  // After a key moved the selection (maybe into another month or year), the focus follows it.
  useEffect(() => {
    if (!focusDay.current) return;
    focusDay.current = false;
    const root = rootRef.current;
    const target = root && (root.querySelector(`.h5-cal-cell[data-date="${selected}"], button.h5-cal-yday[data-date="${selected}"]`) || root.querySelector(`.h5-cal-ymonth[data-month="${selected.slice(0, 7)}"]`));
    if (target) target.focus();
  });
  const go = delta => setSelected(shiftView(view, selected, delta));
  const swipe = useSwipe(wide ? null : go);
  // The keys of a grid of days (the month, the computer year): the arrows a day or a week, Home / End the week's ends, Page Up / Page Down a month.
  const onKey = event => {
    const weekday = new Date(`${selected}T12:00:00Z`).getUTCDay();
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
    if (event.key in moves) { event.preventDefault(); focusDay.current = true; setSelected(addDays(selected, moves[event.key])); return; }
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); focusDay.current = true; setSelected(shiftView('month', selected, event.key === 'PageUp' ? -1 : 1)); }
  };
  // The keys of the phone year (a grid of 12 months, 3 a row): the arrows a month or a row, Page Up / Page Down a year.
  const onMonthKey = event => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, PageUp: -12, PageDown: 12 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    focusDay.current = true;
    setSelected(shiftView('month', selected, moves[event.key]));
  };
  const openMonth = month => { setSelected(shiftView('month', selected, month - p.month)); setView('month'); };
  const list = dayEvents(events, selected);
  const [prevWord, nextWord] = UNIT_WORDS[view];
  const views = (
    <ToggleButtonGroup
      id="h5-cal-views" exclusive size="small" fullWidth={!wide} value={view} aria-label={t('Calendar view')} onChange={(event, value) => setView(value)}
      sx={{ flex: '0 0 auto', ...(wide ? { width: 280 } : {}), '& .MuiToggleButton-root': { minHeight: 36, py: 0.25, [TOUCH]: { minHeight: 44 } } }}
    >
      {CAL_VIEWS.map(value => (
        <ToggleButton key={value} value={value} data-value={value} aria-label={wordOr(`${VIEW_WORDS[value]} view`, VIEW_WORDS[value])} sx={{ flex: '1 1 0' }}>
          <span aria-hidden="true">{wordOr(`${VIEW_WORDS[value]} view`, VIEW_WORDS[value])}</span>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
  const toolbar = (
    <Box id="h5-cal-bar" sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 0.5, pl: wide ? 0 : 1, pb: 0.5 }}>
      {wide ? <Box sx={{ mr: 2 }}>{views}</Box> : null}
      <Typography id="h5-cal-title" variant="h6" component="h2" aria-live="polite" sx={{ flex: '1 1 auto', minWidth: 0, fontSize: wide ? 20 : 18 }} noWrap>{t(viewTitle(view, selected))}</Typography>
      <Button id="h5-cal-today" onClick={() => setSelected(todayDate)} sx={{ minWidth: 0, px: 1.5 }}>{t('Today')}</Button>
      <IconButton id="h5-cal-prev" {...named(t(prevWord))} onClick={() => go(-1)}><Box component="span" sx={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="treeChevron" size={18} /></Box></IconButton>
      <IconButton id="h5-cal-next" {...named(t(nextWord))} onClick={() => go(1)}><Icon name="treeChevron" size={18} /></IconButton>
      {wide ? <Button id="h5-cal-add" variant="contained" onClick={() => setAdding(true)} sx={{ ml: 1 }}>{t('New event')}</Button> : null}
    </Box>
  );
  const agenda = (extra = {}) => (
    <DayAgenda date={selected} events={list} ui={ui} tagOf={tagOf} onOpen={onOpen} undated={noDate} onUndated={() => setUndated(true)} wide={wide} upcoming={soon} {...extra} />
  );
  const panel = content => <Box id="h5-cal-panel" sx={{ flex: '0 0 320px', width: 320, boxSizing: 'border-box', overflowY: 'auto', borderLeft: 1, borderColor: 'divider', p: 2 }}>{content}</Box>;
  const time = (days, heads) => (
    <TimeGrid view={view} days={days} events={events} todayDate={todayDate} now={now} wide={wide} selected={selected} heads={heads} onOpen={onOpen} onDay={openDay} swipe={swipe} />
  );
  let body;
  if (wide) {
    const main = content => <Box id="h5-cal-main" data-view={view} sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', p: 2, pt: 1, overflowY: view === 'month' ? 'auto' : 'hidden' }}>{toolbar}{content}</Box>;
    if (view === 'month') {
      body = (
        <>
          {main(<><MonthGrid grid={grid} events={events} selected={selected} todayDate={todayDate} wide onSelect={setSelected} onKey={onKey} onDay={openDay} /><Legend /></>)}
          {panel(agenda({ onDay: openDay }))}
        </>
      );
    } else if (view === 'year') {
      body = (
        <>
          {main(<><YearView year={p.year} marks={marks} todayDate={todayDate} selected={selected} wide onSelect={setSelected} onDay={openDay} onMonth={openMonth} onKey={onKey} /><YearLegend /></>)}
          {panel(agenda({ onDay: openDay }))}
        </>
      );
    } else if (view === 'week') {
      body = main(time(week.days, true));
    } else {
      body = (
        <>
          {main(time([selected], true))}
          {panel(agenda({ events: allDayEvents(list), allDayOnly: true }))}
        </>
      );
    }
  } else {
    let content;
    if (view === 'month') {
      content = (
        <>
          <PhoneMonth grid={grid} events={events} selected={selected} todayDate={todayDate} onDay={openDay} onKey={onKey} swipe={swipe} />
          {noDate.length ? (
            <ButtonBase id="h5-cal-undated" onClick={() => setUndated(true)} sx={{ flex: '0 0 auto', alignSelf: 'flex-start', minHeight: 44, px: 1, mr: 10, typography: 'body2', color: 'primary.light', borderRadius: 1 }}>
              <span>{t(`${noDate.length} to do without a date`)}</span>
              <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', ml: 0.5 }}><Icon name="treeChevron" size={14} /></Box>
            </ButtonBase>
          ) : <Box sx={{ flex: '0 0 auto', height: 8 }} />}
        </>
      );
    } else if (view === 'year') {
      content = <><YearView year={p.year} marks={marks} todayDate={todayDate} selected={selected} onMonth={openMonth} onKey={onMonthKey} /><YearLegend /></>;
    } else if (view === 'week') {
      content = time(week.days, true);
    } else {
      const lunar = lunarOfDate(selected);
      content = (
        <>
          <WeekStrip days={week.days} selected={selected} todayDate={todayDate} onSelect={setSelected} />
          <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1, px: 2, pt: 1, pb: 0.5 }}>
            <Typography id="h5-cal-day-title" variant="subtitle1" component="h3" sx={{ fontWeight: 500, minWidth: 0 }} noWrap>{t(`${dayTitle(selected)}, ${p.year}`)}</Typography>
            {lunar ? <Typography id="h5-cal-day-lunar" variant="caption" color="text.secondary" sx={{ flex: '0 0 auto' }}>{lunarText(lunar)}</Typography> : null}
          </Box>
          {time([selected], false)}
        </>
      );
    }
    body = (
      <Box id="h5-cal-scroll" data-view={view} sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', pt: 1 }}>
        <Box sx={{ flex: '0 0 auto', px: 2, pb: 1 }}>{views}</Box>
        {toolbar}
        {content}
      </Box>
    );
  }
  return (
    <Box
      id="h5-attention-calendar" ref={rootRef} data-layout={wide ? 'wide' : 'phone'} data-view={view} data-date={selected}
      sx={{ position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column', overflow: 'hidden' }}
    >
      {body}
      {wide ? null : (
        <Fab id="h5-cal-add" color="primary" {...named(t('New event'))} onClick={() => setAdding(true)} sx={{ position: 'absolute', right: 16, bottom: 16, zIndex: 2 }}>
          <Icon name="add" size={24} />
        </Fab>
      )}
      {adding ? <NewEventDialog ui={ui} state={state} engines={engines} date={selected} wide={wide} onClose={() => setAdding(false)} /> : null}
      {undated ? <UndatedDialog items={noDate} tagOf={tagOf} onOpen={key => { setUndated(false); onOpen(key); }} onClose={() => setUndated(false)} /> : null}
    </Box>
  );
}
