import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Feedback, Hint, MinorHeading, Section, SwitchRow, failure, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { Icon } from './Icons.jsx';
import { TOUCH } from './theme.mjs';
import { useStore } from './use-store.mjs';
import { shallowEqual } from './store.mjs';
import { KIND_LABELS, RANGES, refOfNeutral, SERIES, bars, dayName, deviceChoices, duration, kindsLine, lookedText, openTarget, taskRows, tiles, titleLookup } from './usage-time-model.mjs';

// The Time tab of Settings > Usage data ("Time tab" in docs/design/usage-time-page.md; the design's frame 1): range chips (This week, Today, 30 days)
// and the device chip (All devices or one; a device whose engine lacks `usage:time` is listed as "needs an update first"), four tiles with the change
// from the previous period, the time on the page per day as stacked bars (Sessions, Learn, Other) with the values on hover and focus and a table view,
// the tasks with how long the person looked at them and how long the agent worked (a click shows its sessions in place, and a session opens), the
// switch "Record time", Export and Clear. It reads GET /api/usage-time/summary each time it is shown or a choice changes.

// The colours of the three series (the design's): primary (blue 200), success.light (green 300), warning.light (orange 300) of the dark theme. Each
// part is also named in the legend, in the hover / focus text and in the table, so no value is told by its colour alone.
const SERIES_COLOR = { sessions_s: 'primary.main', learn_s: 'success.light', other_s: 'warning.light' };
// The date in a download's name (the person's day).
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// The bars are drawn in pixels: the highest day is BAR_PX tall, and each part of a day gets its share (at least 1px when it is not zero), Sessions at
// the bottom. A 1px gap of the card's colour parts them, so the parts are told apart without their colours too.
const BAR_PX = 112;
const segments = bar => {
  const parts = bar.parts.filter(part => part.seconds > 0);
  const total = Math.round(bar.height * BAR_PX);
  return parts.map((part, index) => ({ ...part, px: Math.max(1, Math.round((part.seconds / bar.total) * total)), top: index === parts.length - 1 }));
};
const STATE = state => ({ sources: state.sources, taskList: state.taskList });
// The person's time zone (IANA), sent with every read so "today", "this week" and the days are the person's, not the server's.
const zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } };
const tzParam = () => (zone() ? `&tz=${encodeURIComponent(zone())}` : '');

function Tile({ tile }) {
  return (
    <Box className="h5-usage-tile" data-tile={tile.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1.75, py: 1.5, minWidth: 0 }}>
      <Typography variant="caption" component="div" color="text.secondary" className="h5-usage-tile-label">{tile.label}</Typography>
      <Typography variant="h5" component="div" className="h5-usage-tile-value" sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{tile.value}</Typography>
      <Typography variant="caption" component="div" className="h5-usage-tile-delta" data-tone={tile.delta.tone} color={tile.delta.tone === 'up' ? 'success.light' : 'text.secondary'}>{tile.delta.text}</Typography>
      {tile.note ? <Typography variant="caption" component="div" color="text.secondary" className="h5-usage-tile-note">{tile.note}</Typography> : null}
    </Box>
  );
}

// The sessions of a task or a day, in place: each opens its session (h5.js through `openTarget`).
function SessionRows({ id, rows, ui, sources, lookup }) {
  if (!rows) return <Hint id={id}>{t('Loading…')}</Hint>;
  if (!rows.length) return <Hint id={id}>{t('No sessions in this time.')}</Hint>;
  return (
    <Box component="ul" id={id} className="h5-usage-sessions" sx={{ listStyle: 'none', m: 0, p: 0, pl: { xs: 1, sm: 2 } }}>
      {rows.map(row => {
        const target = refOfNeutral(row.session, sources);
        const title = row.title || lookup(row.session) || t('Session');
        return (
          <Box component="li" key={row.session || title}>
            <ButtonBase
              className="h5-usage-session" data-session={row.session || undefined} disabled={!target} onClick={() => openTarget(ui, target)}
              sx={{ width: '100%', minHeight: 40, px: 1, py: 0.5, borderRadius: 1, display: 'flex', alignItems: 'center', gap: 1.5, textAlign: 'left', '&:hover': { bgcolor: 'action.hover' }, [TOUCH]: { minHeight: 44 } }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ flex: '0 0 auto', minWidth: 64 }}>{t(KIND_LABELS[row.kind] || 'Session')}</Typography>
              <Typography variant="body2" className="h5-usage-session-name" translate="no" noWrap sx={{ flex: '1 1 auto', minWidth: 0 }}>{title}</Typography>
              <Typography variant="caption" color="text.secondary" className="h5-usage-session-time" sx={{ flex: '0 0 auto', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {lookedText(row, t)}{Number(row.waiting_s) > 0 ? ` · ${t(`waited ${duration(row.waiting_s)}`)}` : ''}
              </Typography>
            </ButtonBase>
          </Box>
        );
      })}
    </Box>
  );
}

// The answer of /task or /day as rows: an array, or an object with `sessions` (and for a day `tasks`, each with its own `sessions`).
const sessionsOf = answer => {
  if (Array.isArray(answer)) return answer;
  if (answer && Array.isArray(answer.sessions)) return answer.sessions;
  if (answer && Array.isArray(answer.tasks)) return answer.tasks.flatMap(task => (Array.isArray(task.sessions) ? task.sessions : []));
  return [];
};

export function UsageTime({ ui, opened, shown }) {
  const state = useStore(ui, STATE, shallowEqual);
  const [range, setRange] = useState('week');
  const [device, setDevice] = useState('all');
  const [summary, setSummary] = useState(null);
  const [record, setRecord] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('chart');
  const [openTask, setOpenTask] = useState(null); // { task, rows }
  const [openDay, setOpenDay] = useState(null); // { day, rows }
  const [deviceMenu, setDeviceMenu] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [feedback, say] = useFeedback();
  const seq = useRef(0);
  const load = async (nextRange = range, nextDevice = device) => {
    const mine = ++seq.current;
    try {
      const [setting, data] = await Promise.all([
        api('GET', '/api/usage-time/settings'),
        api('GET', `/api/usage-time/summary?range=${encodeURIComponent(nextRange)}&device=${encodeURIComponent(nextDevice)}${tzParam()}`),
      ]);
      if (mine !== seq.current) return;
      setRecord(Boolean(setting && setting.usage_time_record));
      setSummary(data || {});
      say('');
    } catch (error) { if (mine === seq.current) say(failure(error), true); }
  };
  useEffect(() => { if (opened && shown) void load(); }, [opened, shown]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const pickRange = next => { if (next === range) return; setRange(next); setOpenTask(null); setOpenDay(null); void load(next, device); };
  const pickDevice = next => { setDeviceMenu(null); if (next === device) return; setDevice(next); setOpenTask(null); setOpenDay(null); void load(range, next); };
  const change = async on => {
    setBusy(true);
    setRecord(on);
    try {
      const saved = await api('PUT', '/api/usage-time/settings', { usage_time_record: on });
      const now = Boolean(saved && saved.usage_time_record);
      setRecord(now);
      ui.set({ usageTimeRecording: now });
    } catch (error) { say(failure(error), true); setRecord(!on); }
    finally { setBusy(false); }
  };
  const showTask = async task => {
    if (openTask && openTask.task === task) { setOpenTask(null); return; }
    setOpenTask({ task, rows: null });
    try {
      const answer = await api('GET', `/api/usage-time/task?task=${encodeURIComponent(task)}&range=${encodeURIComponent(range)}&device=${encodeURIComponent(device)}${tzParam()}`);
      setOpenTask(current => (current && current.task === task ? { task, rows: sessionsOf(answer) } : current));
    } catch (error) { setOpenTask(null); say(failure(error), true); }
  };
  const showDay = async day => {
    if (openDay && openDay.day === day) { setOpenDay(null); return; }
    setOpenDay({ day, rows: null });
    try {
      const answer = await api('GET', `/api/usage-time/day?day=${encodeURIComponent(day)}&device=${encodeURIComponent(device)}${tzParam()}`);
      setOpenDay(current => (current && current.day === day ? { day, rows: sessionsOf(answer) } : current));
    } catch (error) { setOpenDay(null); say(failure(error), true); }
  };
  const clear = async () => {
    setBusy(true);
    try { await api('DELETE', '/api/usage-time?table=time'); setConfirming(false); setOpenTask(null); setOpenDay(null); await load(); say('Time data cleared'); }
    catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const lookup = titleLookup(state);
  const choices = deviceChoices(summary, state.sources, t);
  const old = choices.filter(choice => choice.old);
  const chosen = choices.find(choice => choice.id === device) || choices[0];
  const shownTiles = summary ? tiles(summary, range, t) : [];
  const days = summary ? bars(summary.days, range, t) : [];
  const tasks = summary ? taskRows(summary.tasks) : [];
  const kinds = summary ? kindsLine(summary.kinds, t) : '';
  const touchChip = { height: 32, [TOUCH]: { minHeight: 44 } };
  return (
    <>
      <Section id="usage-time">
        <Box id="h5-usage-time-ranges" role="group" aria-label={t('Time range')} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          {RANGES.map(([id, label]) => (
            <Chip
              key={id} id={`h5-usage-range-${id}`} className="h5-usage-range" label={t(label)} clickable aria-pressed={range === id}
              color={range === id ? 'primary' : 'default'} variant={range === id ? 'filled' : 'outlined'} onClick={() => pickRange(id)} sx={touchChip}
            />
          ))}
          <Box sx={{ flex: '1 1 auto' }} />
          <Chip
            id="h5-usage-device" label={chosen.name} variant="outlined" clickable aria-haspopup="menu" aria-expanded={deviceMenu ? 'true' : undefined}
            aria-label={`${t('Device')}: ${chosen.name}`} deleteIcon={<Box component="span" aria-hidden="true" sx={{ display: 'inline-flex' }}><Icon name="down" size={16} /></Box>}
            onDelete={event => setDeviceMenu(event.currentTarget.closest('.MuiChip-root'))} onClick={event => setDeviceMenu(event.currentTarget)} sx={{ ...touchChip, maxWidth: '100%' }}
          />
          <Menu id="h5-usage-device-menu" anchorEl={deviceMenu} open={Boolean(deviceMenu)} onClose={() => setDeviceMenu(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
            {choices.map(choice => (
              <MenuItem key={choice.id} className="h5-usage-device-choice" data-device={choice.id} disabled={choice.old} selected={choice.id === device} onClick={() => pickDevice(choice.id)} sx={{ minHeight: 44, flexDirection: 'column', alignItems: 'flex-start' }}>
                <Box component="span" translate={choice.id === 'all' ? undefined : 'no'}>{choice.name}</Box>
                {choice.old ? <Typography variant="caption" color="text.secondary">{t('needs an update first')}</Typography> : null}
              </MenuItem>
            ))}
          </Menu>
        </Box>
        <Box id="h5-usage-tiles" sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
          {summary ? shownTiles.map(tile => <Tile key={tile.id} tile={tile} />) : <Hint id="h5-usage-time-loading">{t('Loading…')}</Hint>}
        </Box>
        {old.length ? <Hint id="h5-usage-time-old">{old.map(choice => choice.note).join(' · ')}</Hint> : null}
      </Section>
      <Section id="usage-time-days">
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Box sx={{ flex: '1 1 auto', minWidth: 0 }}><MinorHeading id="h5-usage-days-title">{t('Each day · time on the page')}</MinorHeading></Box>
          <ToggleButtonGroup id="h5-usage-days-view" size="small" color="primary" exclusive value={view} onChange={(event, value) => { if (value) setView(value); }} aria-label={t('Show as')}>
            <ToggleButton id="h5-usage-days-chart" value="chart" sx={{ px: 1.25, py: 0.25 }}>{t('Chart')}</ToggleButton>
            <ToggleButton id="h5-usage-days-table" value="table" sx={{ px: 1.25, py: 0.25 }}>{t('Table')}</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        {view === 'chart' ? (
          <>
            <Box id="h5-usage-bars" role="list" aria-labelledby="h5-usage-days-title" sx={{ display: 'flex', alignItems: 'flex-end', gap: range === '30d' ? 0.25 : 1.5, height: 140 }}>
              {days.map(bar => (
                <Box key={bar.day} role="listitem" sx={{ flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 0.5 }}>
                  <Tooltip title={bar.text} placement="top" describeChild>
                    <ButtonBase
                      className="h5-usage-day" data-day={bar.day} aria-label={bar.text} aria-expanded={openDay && openDay.day === bar.day ? 'true' : 'false'} onClick={() => void showDay(bar.day)}
                      sx={{ width: '100%', height: BAR_PX, display: 'flex', flexDirection: 'column-reverse', justifyContent: 'flex-start', gap: '1px', borderRadius: '3px 3px 0 0', '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineStyle: 'solid', outlineOffset: 2 } }}
                    >
                      {segments(bar).map(part => <Box key={part.key} className="h5-usage-part" data-part={part.key} sx={{ flex: '0 0 auto', width: '100%', height: part.px, bgcolor: SERIES_COLOR[part.key], ...(part.top ? { borderRadius: '3px 3px 0 0' } : {}) }} />)}
                    </ButtonBase>
                  </Tooltip>
                  <Typography variant="caption" color="text.secondary" aria-hidden="true" sx={{ fontSize: 11, lineHeight: 1.4, minHeight: 15, whiteSpace: 'nowrap' }}>{bar.label}</Typography>
                </Box>
              ))}
            </Box>
            <Box id="h5-usage-legend" sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
              {SERIES.map(([key, name]) => (
                <Typography key={key} variant="caption" color="text.secondary" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <Box component="span" aria-hidden="true" sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: SERIES_COLOR[key] }} />{t(name)}
                </Typography>
              ))}
            </Box>
          </>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table id="h5-usage-days-tablebody" size="small" aria-labelledby="h5-usage-days-title">
              <TableHead>
                <TableRow>{['Day', 'Sessions', 'Learn', 'Other'].map(name => <TableCell key={name} align={name === 'Day' ? 'left' : 'right'}>{t(name)}</TableCell>)}</TableRow>
              </TableHead>
              <TableBody>
                {days.map(bar => (
                  <TableRow key={bar.day} hover className="h5-usage-day-row" data-day={bar.day} onClick={() => void showDay(bar.day)} sx={{ cursor: 'pointer' }}>
                    <TableCell><ButtonBase onClick={event => { event.stopPropagation(); void showDay(bar.day); }} sx={{ typography: 'body2', minHeight: 32, [TOUCH]: { minHeight: 44 } }}>{dayName(bar.day, t)}</ButtonBase></TableCell>
                    {bar.parts.map(part => <TableCell key={part.key} align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{duration(part.seconds, t)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        )}
        {openDay ? (
          <Box id="h5-usage-day-detail" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Typography variant="subtitle2" component="h4">{dayName(openDay.day, t)}</Typography>
            <SessionRows id="h5-usage-day-sessions" rows={openDay.rows} ui={ui} sources={state.sources} lookup={lookup} />
          </Box>
        ) : null}
      </Section>
      <Section id="usage-time-tasks">
        <MinorHeading id="h5-usage-tasks-title">{t('Tasks · you looked at it / agent worked')}</MinorHeading>
        {tasks.length ? (
          <Box component="ul" id="h5-usage-tasks" aria-labelledby="h5-usage-tasks-title" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column' }}>
            {tasks.map(row => {
              const open = Boolean(openTask && openTask.task === row.task);
              const name = row.title || lookup(row.task) || t('Task');
              return (
                <Box component="li" key={row.task} className="h5-usage-task-item">
                  <ButtonBase
                    className="h5-usage-task" data-task={row.task} aria-expanded={open ? 'true' : 'false'} onClick={() => void showTask(row.task)}
                    sx={{ width: '100%', minHeight: 40, px: 1, borderRadius: 1, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr) auto', sm: 'minmax(0, 180px) minmax(0, 1fr) auto' }, gridTemplateAreas: { xs: '"name text" "bar bar"', sm: '"name bar text"' }, alignItems: 'center', columnGap: 1.5, rowGap: 0.5, py: 0.5, textAlign: 'left', '&:hover': { bgcolor: 'action.hover' }, [TOUCH]: { minHeight: 44 } }}
                  >
                    <Typography variant="body2" className="h5-usage-task-name" translate="no" noWrap sx={{ gridArea: 'name' }}>{name}</Typography>
                    <Box aria-hidden="true" sx={{ gridArea: 'bar', height: 8, borderRadius: 1, bgcolor: 'action.hover', overflow: 'hidden' }}>
                      <Box className="h5-usage-task-bar" sx={{ width: `${Math.max(row.looked_s > 0 ? 2 : 0, Math.round(row.share * 100))}%`, height: '100%', borderRadius: 1, bgcolor: 'primary.main' }} />
                    </Box>
                    <Typography variant="caption" color="text.secondary" className="h5-usage-task-text" sx={{ gridArea: 'text', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{lookedText(row, t)}</Typography>
                  </ButtonBase>
                  {open ? <SessionRows id="h5-usage-task-sessions" rows={openTask.rows} ui={ui} sources={state.sources} lookup={lookup} /> : null}
                </Box>
              );
            })}
          </Box>
        ) : <Hint id="h5-usage-tasks-empty">{t(summary ? 'No task time in this period.' : 'Loading…')}</Hint>}
        <Hint id="h5-usage-time-hint">{[t('Click a task or a day to see its sessions.'), kinds].filter(Boolean).join(' ')}</Hint>
      </Section>
      <Section id="usage-time-record">
        <SwitchRow
          inputId="h5-usage-time-enabled" label={t('Record time')} checked={Boolean(record)} disabled={record === null || busy} onChange={on => void change(on)}
          secondary={t('Records how long the page is in use (visible, and a key, tap or mouse move in the last 2 minutes), and how long sessions run or wait for you. Only time per day, hour, task and kind of session; no text, no commands.')}
          aside={<ScopeLabel id="usage-time-record" scope="shared" />}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ flex: '1 1 16rem', minWidth: 0 }}>{t('Kept per day for 2 years, on your own machines.')}</Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, ml: 'auto' }}>
            <Button id="h5-usage-time-clear" color="error" disabled={busy} onClick={() => setConfirming(true)}>{t('Clear')}</Button>
            <Button id="h5-usage-time-export-csv" component="a" href="/api/usage-time/export?table=time&format=csv" download={`t-agent-time-${today()}.csv`}>{t('Export CSV')}</Button>
            <Button id="h5-usage-time-export" component="a" href="/api/usage-time/export?table=time&format=json" download={`t-agent-time-${today()}.json`}>{t('Export JSON')}</Button>
          </Box>
        </Box>
        <Feedback id="h5-usage-time-feedback" feedback={feedback} />
      </Section>
      <Dialog id="h5-usage-time-clear-dialog" open={confirming} onClose={() => setConfirming(false)} fullWidth maxWidth="xs" aria-labelledby="h5-usage-time-clear-title" aria-describedby="h5-usage-time-clear-text">
        <DialogTitle id="h5-usage-time-clear-title">{t('Clear time data?')}</DialogTitle>
        <DialogContent>
          <DialogContentText id="h5-usage-time-clear-text" variant="body2">{t('Every recorded time on the page and of the sessions is deleted, here and on the linked machines that keep the same data. This cannot be undone.')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button id="h5-usage-time-clear-cancel" onClick={() => setConfirming(false)}>{t('Cancel')}</Button>
          <Button id="h5-usage-time-clear-confirm" color="error" disabled={busy} onClick={() => void clear()}>{t('Clear')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
