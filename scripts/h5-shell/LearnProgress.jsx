import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { alpha, getOverlayAlpha, lighten, useTheme } from '@mui/material/styles';
import { api, errorText, t } from './common.jsx';
import { ViewFrame, tf } from './Learn.jsx';
import {
  columnLayout, columnPath, deltaParts, hasAnswers, labelSlots, mixColor, nearestPoint, niceTicks, percent, runs, shortDay, slotAt, tickText, tiles, weeklyShares,
} from './learn-progress.mjs';

// The Progress view of Learn ("Progress" in docs/design/learn-english-page.md; GET /api/learn/stats, docs/design/learn-english-stats.md). Part of the
// Learn chunk (screen-learn.jsx), opened from the Progress button of the home's Today card: on a phone a full-screen page like the other Learn views, on
// a computer the Learn right pane with the charts two per row.
// - Four stat tiles: the streak (and the best), this week's answers (vs the week before), the share right this week (vs the week before), the cards
//   remembered well (FSRS stability of 21 days or more) of all.
// - Four charts, one measure each, all in the theme's primary hue (one series each, so no legend: the titles name them): answers per day (30 days,
//   columns), right the first time by week (12 weeks, a line with a 10% wash), memory strength (four bars), due in the next 14 days (columns).
//   Every column and the line have a tooltip on hover, tap and keyboard focus (arrow keys move); "Table" in the bar shows every chart as a table.
// The charts are inline SVG drawn here (no chart library), with the thin marks of the dataviz rules: columns at most 24px wide with a 4px rounded top
// and a square foot, a 2px line, an end dot of r 4 with a 2px ring in the card's colour, a hairline grid, text in the text colours only.

const lang = () => (typeof I18n !== 'undefined' && I18n.get() === 'zh' ? 'zh' : 'en');
const fmt = parts => (parts ? tf(parts[0], parts[1]) : '');
const count = (n, one, many) => tf(n === 1 ? one : many, n);

// The width of a box, kept up to date (the charts are drawn at the width they get).
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// The colours of the charts from the MUI theme: the primary hue for every mark, the divider for the grid, the card's own colour for the ring.
function useChartColors() {
  const theme = useTheme();
  const surface = theme.palette.mode === 'dark' ? mixColor(theme.palette.background.paper, '#ffffff', Number(getOverlayAlpha(1))) : theme.palette.background.paper;
  return {
    mark: theme.palette.primary.main, active: lighten(theme.palette.primary.main, 0.3), wash: alpha(theme.palette.primary.main, 0.1), track: alpha(theme.palette.primary.main, 0.12),
    grid: theme.palette.divider, text: theme.palette.text.secondary, strong: theme.palette.text.primary, surface,
  };
}

export function ProgressView({ frame }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [table, setTable] = useState(false);
  const load = useCallback(() => {
    setState(now => ({ ...now, loading: true, error: '' }));
    api('GET', '/api/learn/stats').then(
      data => setState({ loading: false, data: data || {}, error: '' }),
      failure => setState({ loading: false, data: null, error: errorText(failure) || t('Could not load your progress.') }),
    );
  }, []);
  useEffect(() => { load(); }, [load]);
  const { data, error } = state;
  const empty = Boolean(data) && !hasAnswers(data);
  const action = data && !empty ? (
    <Button id="h5-learn-progress-table" size="small" aria-pressed={table} onClick={() => setTable(now => !now)} sx={{ minWidth: 56 }}>
      {table ? t('Charts') : t('Table')}
    </Button>
  ) : null;
  let body;
  if (error && !data) {
    body = <Alert severity="error" id="h5-learn-progress-error" action={<Button color="inherit" size="small" onClick={load}>{t('Retry')}</Button>}>{error}</Alert>;
  } else if (!data) {
    body = <Typography id="h5-learn-progress-loading" variant="body2" color="text.secondary">{t('Loading…')}</Typography>;
  } else {
    body = (
      <>
        {data.offline || data.home_older ? (
          <Alert severity="info" id="h5-learn-progress-offline">
            {data.home_older ? t('The normal computer that keeps your learning data needs an update first. These numbers come from the cards on this computer.')
              : t("Your other computer can't be reached. These numbers come from the cards on this computer.")}
          </Alert>
        ) : null}
        <Tiles stats={data} />
        {empty ? (
          <Card id="h5-learn-progress-empty" sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">{t('Answer a few cards and your progress shows here.')}</Typography>
          </Card>
        ) : table ? <Tables stats={data} /> : <Charts stats={data} />}
      </>
    );
  }
  return <ViewFrame {...frame} action={action}><Box id="h5-learn-progress" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{body}</Box></ViewFrame>;
}

// ── Stat tiles ──

function Tile({ id, label, value, note }) {
  return (
    <Card id={id} className="h5-learn-tile" sx={{ p: 1.5, minWidth: 0 }}>
      <Typography variant="caption" component="p" color="text.secondary" noWrap>{label}</Typography>
      <Typography variant="h5" component="p" className="h5-learn-tile-value" sx={{ fontWeight: 500, lineHeight: 1.3 }} noWrap>{value}</Typography>
      <Typography variant="caption" component="p" color="text.secondary" className="h5-learn-tile-note" noWrap>{note}</Typography>
    </Card>
  );
}
function Tiles({ stats }) {
  const tile = tiles(stats);
  const answersDelta = fmt(deltaParts(tile.answers.delta));
  const rightDelta = deltaParts(tile.right.delta, { points: true });
  return (
    <Box id="h5-learn-progress-tiles" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))', gap: 1 }}>
      <Tile id="h5-learn-tile-streak" label={t('Streak')} value={tf(tile.streak.unit, tile.streak.value)} note={tf('best {1}', tile.streak.best)} />
      <Tile id="h5-learn-tile-week" label={t('This week')} value={tile.answers.value.toLocaleString('en-US')} note={`${t('answers')} · ${answersDelta}`} />
      <Tile id="h5-learn-tile-right" label={t('Right this week')} value={tile.right.value === null ? '–' : `${tile.right.value}%`}
        note={rightDelta ? fmt(rightDelta) : t('no answers to compare')} />
      <Tile id="h5-learn-tile-remembered" label={t('Remembered well')} value={tile.remembered.value.toLocaleString('en-US')} note={tf('of {1} cards', tile.remembered.total)} />
    </Box>
  );
}

// ── Charts ──

function ChartCard({ id, title, subtitle, children }) {
  return (
    <Card id={id} className="h5-learn-chart" component="section" aria-labelledby={`${id}-title`} sx={{ p: 2, minWidth: 0 }}>
      <Typography id={`${id}-title`} variant="subtitle1" component="h3" sx={{ fontWeight: 500, lineHeight: 1.4 }}>{title}</Typography>
      <Typography variant="caption" component="p" color="text.secondary">{subtitle}</Typography>
      <Box sx={{ mt: 1.5 }}>{children}</Box>
    </Card>
  );
}

// The tooltip of a chart: two lines (the value first, strong; then what it is), above the point `x`, `y` (px in the chart box), kept inside the box.
function ChartTip({ tip, width }) {
  const ref = useRef(null);
  const [size, setSize] = useState(140);
  useLayoutEffect(() => { if (ref.current) setSize(ref.current.offsetWidth); }, [tip && tip.lines.join('|')]);
  if (!tip) return null;
  const left = Math.max(0, Math.min(width - size, tip.x - size / 2));
  return (
    <Box ref={ref} role="status" className="h5-learn-chart-tip" sx={theme => ({
      position: 'absolute', left, top: Math.max(0, tip.y - 8), transform: 'translateY(-100%)', pointerEvents: 'none', zIndex: 1, whiteSpace: 'nowrap',
      bgcolor: theme.palette.grey[800], borderRadius: 1, px: 1, py: 0.5, boxShadow: theme.shadows[4], ...theme.typography.caption, lineHeight: 1.4,
    })}>
      <Box component="span" sx={{ display: 'block', color: 'text.primary', fontWeight: 500 }}>{tip.lines[0]}</Box>
      {tip.lines[1] ? <Box component="span" sx={{ display: 'block', color: 'text.secondary' }}>{tip.lines[1]}</Box> : null}
    </Box>
  );
}

const PAD = { left: 32, right: 8, top: 8, axis: 20 };
// The pointer and the keyboard on a chart: `active` is the slot shown (null for none). A mouse shows the slot under it and clears on leaving; a touch
// shows the slot tapped (a second tap on it clears); focus shows the last slot, the arrow keys move, Escape clears.
function useActive(n, slotOf) {
  const [active, setActive] = useState(null);
  const handlers = {
    onPointerMove: event => { if (event.pointerType === 'mouse') setActive(slotOf(event)); },
    onPointerDown: event => { if (event.pointerType !== 'mouse') { const slot = slotOf(event); setActive(now => (now === slot ? null : slot)); } },
    onPointerLeave: event => { if (event.pointerType === 'mouse') setActive(null); },
    onFocus: () => setActive(now => (now === null ? n - 1 : now)),
    onBlur: () => setActive(null),
    onKeyDown: event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        setActive(now => Math.max(0, Math.min(n - 1, (now === null ? n - 1 : now) + step)));
      } else if (event.key === 'Escape' && active !== null) {
        event.preventDefault();
        event.stopPropagation();
        setActive(null);
      }
    },
  };
  return [active, handlers];
}
const plotOffset = (event, left) => event.clientX - event.currentTarget.getBoundingClientRect().left - left;

// Columns from a baseline: `items` [{ value, tip: [line, line] }], `labels` the x labels of the first, middle and last slots.
function ColumnChart({ id, items, labels, height = 120, label }) {
  const colors = useChartColors();
  const [ref, width] = useWidth();
  const n = items.length;
  const plot = Math.max(0, width - PAD.left - PAD.right);
  const layout = columnLayout(n, plot);
  const { top, ticks } = niceTicks(Math.max(0, ...items.map(item => item.value)));
  const y = value => PAD.top + height - (value / top) * height;
  const base = PAD.top + height;
  const [active, handlers] = useActive(n, event => slotAt(plotOffset(event, PAD.left), n, plot));
  const tip = active !== null && width ? { x: PAD.left + layout.center(active), y: y(items[active].value), lines: items[active].tip } : null;
  return (
    <Box ref={ref} sx={{ position: 'relative', width: '100%' }}>
      {width ? (
        <svg id={id} width={width} height={base + PAD.axis} role="img" aria-label={label} tabIndex={0} {...handlers}
          style={{ display: 'block', outline: 'none', touchAction: 'pan-y', fontVariantNumeric: 'tabular-nums' }} className="h5-learn-columns">
          {ticks.map(value => (
            <g key={value}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(value)} y2={y(value)} stroke={colors.grid} strokeWidth="1" shapeRendering="crispEdges" />
              <text x={PAD.left - 6} y={y(value) + 3.5} fill={colors.text} fontSize="10" textAnchor="end">{tickText(value, top)}</text>
            </g>
          ))}
          {items.map((item, i) => (item.value > 0 ? (
            <path key={i} className="h5-learn-column" data-index={i} data-value={item.value} d={columnPath(PAD.left + layout.x(i), y(item.value), layout.bar, base)}
              fill={i === active ? colors.active : colors.mark} />
          ) : null))}
          {labelSlots(n).map(i => (
            <text key={i} className="h5-learn-xlabel" x={PAD.left + layout.center(i)} y={base + 14} fill={colors.text} fontSize="10"
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} dx={i === 0 ? -layout.step / 2 + 1 : i === n - 1 ? layout.step / 2 - 1 : 0}>{labels[i]}</text>
          ))}
          {/* The hit targets: every slot, the full height (bigger than the column, so a short or empty day is easy to point at). */}
          {items.map((item, i) => <rect key={i} className="h5-learn-slot" data-index={i} x={PAD.left + i * layout.step} y={PAD.top} width={layout.step} height={height} fill="transparent" />)}
        </svg>
      ) : <Box sx={{ height: base + PAD.axis }} />}
      <ChartTip tip={tip} width={width} />
    </Box>
  );
}

// The share right the first time by week: a 2px line over a 10% wash, the last value labelled at its end dot, a crosshair on the nearest week.
function LineChart({ id, values, labels, tips, height = 110, label }) {
  const colors = useChartColors();
  const [ref, width] = useWidth();
  const n = values.length;
  const right = 14;
  const plot = Math.max(0, width - PAD.left - right);
  const x = i => PAD.left + (n === 1 ? plot / 2 : (i / (n - 1)) * plot);
  const y = value => PAD.top + height - (value / 100) * height;
  const base = PAD.top + height;
  const [active, handlers] = useActive(n, event => nearestPoint(plotOffset(event, PAD.left), values, plot));
  const shown = active !== null && active >= 0 && values[active] !== null ? active : null;
  const segments = runs(values);
  const last = segments.length ? segments[segments.length - 1].slice(-1)[0] : -1;
  const line = run => run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`).join('');
  const tip = shown !== null && width ? { x: x(shown), y: y(values[shown]), lines: tips[shown] } : null;
  return (
    <Box ref={ref} sx={{ position: 'relative', width: '100%' }}>
      {width ? (
        <svg id={id} width={width} height={base + PAD.axis} role="img" aria-label={label} tabIndex={0} {...handlers}
          style={{ display: 'block', outline: 'none', touchAction: 'pan-y', fontVariantNumeric: 'tabular-nums' }} className="h5-learn-line">
          {[0, 25, 50, 75, 100].map(value => (
            <g key={value}>
              <line x1={PAD.left} x2={width - right} y1={y(value)} y2={y(value)} stroke={colors.grid} strokeWidth="1" shapeRendering="crispEdges" />
              <text x={PAD.left - 6} y={y(value) + 3.5} fill={colors.text} fontSize="10" textAnchor="end">{`${value}%`}</text>
            </g>
          ))}
          {segments.map(run => (run.length > 1 ? (
            <path key={`a${run[0]}`} d={`${line(run)}L${x(run[run.length - 1]).toFixed(1)},${base}L${x(run[0]).toFixed(1)},${base}Z`} fill={colors.wash} />
          ) : null))}
          {segments.map(run => (run.length > 1
            ? <path key={`l${run[0]}`} className="h5-learn-line-path" d={line(run)} fill="none" stroke={colors.mark} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            : <circle key={`l${run[0]}`} cx={x(run[0])} cy={y(values[run[0]])} r="2" fill={colors.mark} />))}
          {shown !== null ? <line className="h5-learn-crosshair" x1={x(shown)} x2={x(shown)} y1={PAD.top} y2={base} stroke={colors.text} strokeWidth="1" shapeRendering="crispEdges" /> : null}
          {last >= 0 ? (
            <>
              <circle className="h5-learn-line-end" cx={x(last)} cy={y(values[last])} r="4" fill={colors.mark} stroke={colors.surface} strokeWidth="2" />
              <text className="h5-learn-line-label" x={x(last) - 8} y={y(values[last]) < PAD.top + 14 ? y(values[last]) + 16 : y(values[last]) - 9} fill={colors.strong} fontSize="12" textAnchor="end">{`${values[last]}%`}</text>
            </>
          ) : null}
          {shown !== null && shown !== last ? <circle cx={x(shown)} cy={y(values[shown])} r="4" fill={colors.mark} stroke={colors.surface} strokeWidth="2" /> : null}
          {labelSlots(n).map(i => (
            <text key={i} className="h5-learn-xlabel" x={x(i)} y={base + 14} fill={colors.text} fontSize="10" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{labels[i]}</text>
          ))}
          <rect className="h5-learn-line-hit" x={PAD.left - 8} y={PAD.top} width={plot + 16} height={height} fill="transparent" />
        </svg>
      ) : <Box sx={{ height: base + PAD.axis }} />}
      <ChartTip tip={tip} width={width} />
    </Box>
  );
}

const MEMORY = [
  ['new', 'New', 'never answered'],
  ['learning', 'Learning', 'under 1 day'],
  ['young', 'Getting there', '1 to 21 days'],
  ['mature', 'Remembered well', '21 days or more'],
];
// Memory strength: one bar per group, relative to the largest group, the count printed at the right; a tooltip with its share of all cards.
function MemoryBars({ stats }) {
  const colors = useChartColors();
  const memory = stats.memory || {};
  const values = MEMORY.map(([key]) => Math.max(0, Number(memory[key]) || 0));
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const [active, setActive] = useState(null);
  return (
    <Box component="ul" id="h5-learn-memory" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {MEMORY.map(([key, name, note], i) => {
        const share = percent(values[i], total);
        return (
          <Box component="li" key={key} className="h5-learn-memory-row" data-group={key} tabIndex={0} aria-label={`${t(name)}: ${count(values[i], '{1} card', '{1} cards')}`}
            onPointerEnter={event => { if (event.pointerType === 'mouse') setActive(i); }} onPointerLeave={() => setActive(null)}
            onPointerDown={event => { if (event.pointerType !== 'mouse') setActive(now => (now === i ? null : i)); }} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
            sx={{ position: 'relative', display: 'grid', gridTemplateColumns: 'minmax(96px, 38%) 1fr 44px', alignItems: 'center', columnGap: 1.5, minHeight: 36, outline: 'none', borderRadius: 1, '&:focus-visible': { boxShadow: theme => `0 0 0 2px ${theme.palette.primary.main}` } }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" component="p" noWrap>{t(name)}</Typography>
              <Typography variant="caption" component="p" color="text.secondary" noWrap>{t(note)}</Typography>
            </Box>
            <Box sx={{ height: 12, bgcolor: colors.track, borderRadius: '0 4px 4px 0' }}>
              {values[i] > 0 ? <Box className="h5-learn-memory-bar" sx={{ width: `${(values[i] / max) * 100}%`, minWidth: 2, height: 12, bgcolor: i === active ? colors.active : colors.mark, borderRadius: '0 4px 4px 0' }} /> : null}
            </Box>
            <Typography variant="body2" component="p" className="h5-learn-memory-value" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{values[i].toLocaleString('en-US')}</Typography>
            {i === active ? (
              <Box role="status" className="h5-learn-chart-tip" sx={theme => ({ position: 'absolute', right: 52, bottom: '100%', mb: 0.25, pointerEvents: 'none', zIndex: 1, whiteSpace: 'nowrap', bgcolor: theme.palette.grey[800], borderRadius: 1, px: 1, py: 0.5, boxShadow: theme.shadows[4], ...theme.typography.caption, lineHeight: 1.4 })}>
                <Box component="span" sx={{ display: 'block', color: 'text.primary', fontWeight: 500 }}>{count(values[i], '{1} card', '{1} cards')}</Box>
                <Box component="span" sx={{ display: 'block', color: 'text.secondary' }}>{share === null ? t(name) : tf('{1} · {2}% of all cards', t(name), share)}</Box>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

// The four charts' rows, shared by the charts and the tables.
function chartData(stats) {
  const language = lang();
  const daily = Array.isArray(stats.daily) ? stats.daily : [];
  const weekly = Array.isArray(stats.weekly) ? stats.weekly : [];
  const due = Array.isArray(stats.due) ? stats.due : [];
  const shares = weeklyShares(weekly);
  return {
    daily: daily.map(item => {
      const answers = Math.max(0, Number(item.answers) || 0);
      const right = Math.max(0, Number(item.right) || 0);
      const day = shortDay(item.day, language);
      return {
        day, answers, right, share: percent(right, answers),
        tip: answers ? [`${day} · ${count(answers, '{1} answer', '{1} answers')}`, tf('{1} right ({2}%)', right, percent(right, answers))] : [day, t('No answers')],
      };
    }),
    weekly: weekly.map((item, i) => {
      const week = shortDay(item.week_start, language);
      const answers = Math.max(0, Number(item.answers) || 0);
      return {
        week, answers, right: Math.max(0, Number(item.right_first) || 0), share: shares[i],
        tip: shares[i] === null ? [tf('Week of {1}', week), t('No answers')] : [tf('{1}% right the first time', shares[i]), tf('Week of {1} · {2}', week, count(answers, '{1} card', '{1} cards'))],
      };
    }),
    due: due.map((item, i) => {
      const day = i === 0 ? t('Today') : shortDay(item.day, language);
      const cards = Math.max(0, Number(item.count) || 0);
      return { day, cards, tip: [count(cards, '{1} card', '{1} cards'), i === 0 ? t('Today, with the overdue ones') : day] };
    }),
  };
}

function Charts({ stats }) {
  const rows = chartData(stats);
  const dailyLabels = rows.daily.map(item => item.day);
  return (
    <Box id="h5-learn-progress-charts" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 1.5 }}>
      <ChartCard id="h5-learn-chart-daily" title={t('Answers per day')} subtitle={t('Last 30 days')}>
        <ColumnChart id="h5-learn-chart-daily-svg" label={t('Answers per day, last 30 days')} items={rows.daily.map(item => ({ value: item.answers, tip: item.tip }))} labels={dailyLabels} />
      </ChartCard>
      <ChartCard id="h5-learn-chart-weekly" title={t('Right answers by week')} subtitle={t('Share of answers right the first time, last 12 weeks')}>
        <LineChart id="h5-learn-chart-weekly-svg" label={t('Share of answers right the first time, last 12 weeks')} values={rows.weekly.map(item => item.share)}
          labels={rows.weekly.map(item => item.week)} tips={rows.weekly.map(item => item.tip)} />
      </ChartCard>
      <ChartCard id="h5-learn-chart-memory" title={t('Memory strength')} subtitle={t('How long each card is expected to stay remembered (FSRS)')}>
        <MemoryBars stats={stats} />
      </ChartCard>
      <ChartCard id="h5-learn-chart-due" title={t('Due in the next 14 days')} subtitle={t('Cards the schedule brings back each day')}>
        <ColumnChart id="h5-learn-chart-due-svg" label={t('Cards due in the next 14 days')} height={100} items={rows.due.map(item => ({ value: item.cards, tip: item.tip }))} labels={rows.due.map(item => item.day)} />
      </ChartCard>
    </Box>
  );
}

// ── Tables: every chart as a table (the "Table" button of the bar) ──

function DataTable({ id, title, head, rows }) {
  return (
    <Card id={id} className="h5-learn-progress-table" sx={{ minWidth: 0, overflowX: 'auto' }}>
      <Table size="small" aria-labelledby={`${id}-title`}>
        <caption id={`${id}-title`} style={{ captionSide: 'top', textAlign: 'left', padding: '16px 16px 8px' }}>
          <Typography variant="subtitle1" component="span" sx={{ fontWeight: 500, color: 'text.primary' }}>{title}</Typography>
        </caption>
        <TableHead>
          <TableRow>{head.map((cell, i) => <TableCell key={cell} align={i ? 'right' : 'left'} sx={{ color: 'text.secondary' }}>{cell}</TableCell>)}</TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r}>{row.map((cell, i) => <TableCell key={i} align={i ? 'right' : 'left'} sx={{ fontVariantNumeric: 'tabular-nums' }}>{cell}</TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
function Tables({ stats }) {
  const rows = chartData(stats);
  const memory = stats.memory || {};
  const share = value => (value === null ? '–' : `${value}%`);
  return (
    <Box id="h5-learn-progress-tables" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 1.5, alignItems: 'start' }}>
      <DataTable id="h5-learn-table-daily" title={t('Answers per day')} head={[t('Day'), t('Answers'), t('Right')]}
        rows={rows.daily.slice().reverse().map(item => [item.day, item.answers, item.answers ? `${item.right} (${share(item.share)})` : '0'])} />
      <DataTable id="h5-learn-table-weekly" title={t('Right answers by week')} head={[t('Week of'), t('Cards'), t('Right the first time')]}
        rows={rows.weekly.slice().reverse().map(item => [item.week, item.answers, item.answers ? `${item.right} (${share(item.share)})` : '–'])} />
      <DataTable id="h5-learn-table-memory" title={t('Memory strength')} head={[t('Group'), t('Cards')]}
        rows={MEMORY.map(([key, name, note]) => [`${t(name)} (${t(note)})`, Math.max(0, Number(memory[key]) || 0)])} />
      <DataTable id="h5-learn-table-due" title={t('Due in the next 14 days')} head={[t('Day'), t('Cards')]} rows={rows.due.map(item => [item.day, item.cards])} />
    </Box>
  );
}
