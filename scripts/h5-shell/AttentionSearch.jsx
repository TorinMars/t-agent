import { Fragment, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { named, t } from './common.jsx';
import { DeviceTag } from './TaskDrawer.jsx';
import { Icon } from './Icons.jsx';
import { engineOf, ruleTokens, scheduleOf, today } from './attention-model.mjs';
import { MONTHS, dayTitle, occasionText } from './calendar-model.mjs';
import { SEARCH_FILTERS, dateBlock, highlightParts, searchItems } from './calendar-search.mjs';
import { KindDot } from './CalendarParts.jsx';
import { Words, lunarText } from './Attention.jsx';
import { TOUCH } from './theme.mjs';

// The search of T-Attention ("Search" in docs/design/page-attention-calendar.md), opened by the magnifier of the panel's header in the list and in
// the calendar: a field, filter chips (All, Schedules, Birthdays, Anniversaries, To do; Include finished) and the results of every engine's items
// grouped Next up / Earlier this year / Earlier / No date / Finished (calendar-search.mjs). Full screen on a phone (a back arrow), a dialog on a
// computer (a close button); Escape closes it; a tap on a result opens the item's edit view.

// The lunar date of a lunar yearly rule in the page's words: what a person reading Chinese types ("lunar month 10" -> its words).
const lunarWords = item => {
  const rule = (scheduleOf(item) || {}).rule;
  if (!rule || rule.freq !== 'yearly' || rule.calendar !== 'lunar') return [];
  const value = { month: rule.month, day: rule.day, leap: Boolean(rule.leap) };
  return [lunarText(value), lunarText(value, { prefix: null })];
};
function Marked({ text, query }) {
  return highlightParts(text, query).map((part, index) => (part.hit
    ? <Box key={index} component="mark" className="h5-search-hit" sx={theme => ({ bgcolor: alpha(theme.palette.primary.main, 0.3), color: 'inherit', borderRadius: '2px' })}>{part.text}</Box>
    : <Fragment key={index}>{part.text}</Fragment>));
}
// The second line of a result: the day (with its year when it is not this year), the lunar date of a lunar rule, and the rule in words.
function resultLine(result, thisYear) {
  const schedule = scheduleOf(result.item);
  const rule = schedule && schedule.rule;
  const parts = [];
  if (result.date) parts.push(t(result.date.slice(0, 4) === thisYear ? dayTitle(result.date, { short: true }) : `${dayTitle(result.date, { short: true })}, ${result.date.slice(0, 4)}`));
  if (rule && rule.freq === 'yearly' && rule.calendar === 'lunar') parts.push(lunarText({ month: rule.month, day: rule.day, leap: Boolean(rule.leap) }));
  return { parts, schedule, yearly: Boolean(rule && rule.freq === 'yearly') };
}
function ResultRow({ result, query, tag, thisYear, onOpen }) {
  const occasion = occasionText(result.kind, result.years);
  const block = dateBlock(result.date);
  const line = resultLine(result, thisYear);
  const month = block ? t(MONTHS[Number(result.date.slice(5, 7)) - 1].long) : '';
  return (
    <ListItemButton
      role="listitem" className="h5-search-result" data-key={result.key} data-kind={result.kind} data-date={result.date || undefined} onClick={() => onOpen(result.key)}
      sx={{ gap: 1.5, minHeight: 64, px: 2, borderBottom: 1, borderColor: 'divider' }}
    >
      <Box className="h5-search-date" aria-hidden="true" sx={{ flex: '0 0 auto', width: 44, textAlign: 'center' }}>
        {block ? (
          <>
            <Box sx={{ typography: 'caption', color: 'text.secondary', lineHeight: 1.3 }}>{month !== MONTHS[Number(result.date.slice(5, 7)) - 1].long ? month : block.month.toUpperCase()}</Box>
            <Box sx={{ typography: 'h6', lineHeight: 1.2, fontWeight: 400 }}>{block.day}</Box>
          </>
        ) : <Box sx={{ typography: 'h6', color: 'text.disabled' }}>–</Box>}
      </Box>
      <KindDot kind={result.kind} size={8} />
      <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          {tag ? <Box component="span" sx={{ flex: '0 0 auto', display: 'inline-flex' }}><DeviceTag device={tag} /></Box> : null}
          <Box className="h5-search-title" sx={{ minWidth: 0, typography: 'body1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <Marked text={String(result.item.title || '')} query={query} />{occasion ? ` · ${t(occasion)}` : ''}
          </Box>
        </Box>
        <Box className="h5-search-line" sx={{ typography: 'body2', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {line.parts.join(' · ')}{line.parts.length ? ' · ' : ''}
          {line.yearly ? t('Every year') : line.schedule ? <Words tokens={ruleTokens(line.schedule)} /> : t(result.kind === 'todo' ? 'To do' : 'No date')}
        </Box>
      </Box>
    </ListItemButton>
  );
}

const CHIP_SX = theme => ({ height: 32, minWidth: 44, borderRadius: '16px', [TOUCH]: { height: 44, borderRadius: '22px' }, '&.h5-on': { bgcolor: alpha(theme.palette.primary.main, 0.16), borderColor: theme.palette.primary.main, color: theme.palette.primary.light } });
export function AttentionSearch({ items, wide, tagOf, onOpen, onClose }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [finished, setFinished] = useState(false);
  const todayDate = today();
  const found = useMemo(() => searchItems(items, query, { filter, finished, today: todayDate, extra: lunarWords }), [items, query, filter, finished, todayDate]);
  const thisYear = todayDate.slice(0, 4);
  const chip = (id, label, on, onClick) => (
    <Chip
      key={id} id={id} label={t(label)} variant="outlined" clickable onClick={onClick} className={on ? 'h5-on' : undefined}
      aria-pressed={on} component="button" sx={CHIP_SX}
    />
  );
  return (
    <Dialog
      open onClose={onClose} fullScreen={!wide} fullWidth maxWidth="sm" id="h5-attention-search-view" aria-label={t('Search')}
      slotProps={{ paper: { sx: wide ? { height: 'min(720px, calc(100vh - 64px))' } : { pt: 'env(safe-area-inset-top)', pb: 'env(safe-area-inset-bottom)' } } }}
    >
      <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 56, px: 1, borderBottom: 1, borderColor: 'divider' }}>
        {wide ? null : <IconButton id="h5-search-back" {...named(t('Back'))} onClick={onClose}><Icon name="back" size={22} /></IconButton>}
        <Box sx={theme => ({ flex: '1 1 auto', minWidth: 0, height: 40, [TOUCH]: { height: 44, borderRadius: '22px' }, display: 'flex', alignItems: 'center', gap: 1, pl: 1.5, pr: 0.5, borderRadius: '20px', bgcolor: alpha(theme.palette.common.white, 0.08) })}>
          <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', color: 'text.secondary' }}><Icon name="search" size={20} /></Box>
          <InputBase
            id="h5-search-field" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('Search titles, notes and names')}
            inputProps={{ 'aria-label': t('Search'), enterKeyHint: 'search', autoComplete: 'off' }} sx={{ flex: '1 1 auto', minWidth: 0, alignSelf: 'stretch', typography: 'body1' }}
          />
          {query ? <IconButton id="h5-search-clear" size="small" {...named(t('Clear'))} onClick={() => setQuery('')} sx={{ [TOUCH]: { width: 44, height: 44 } }}><Icon name="close" size={18} /></IconButton> : null}
        </Box>
        {wide ? <IconButton id="h5-search-close" {...named(t('Close'))} onClick={onClose}><Icon name="close" size={22} /></IconButton> : null}
      </Box>
      <Box id="h5-search-filters" role="group" aria-label={t('Filters')} sx={{ flex: '0 0 auto', display: 'flex', flexWrap: 'wrap', gap: 1, px: 2, py: 1 }}>
        {SEARCH_FILTERS.map(entry => chip(`h5-search-filter-${entry.value}`, entry.label, filter === entry.value, () => setFilter(entry.value)))}
        {chip('h5-search-finished', 'Include finished', finished, () => setFinished(value => !value))}
      </Box>
      <Box id="h5-search-results" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', pb: 2 }}>
        {found.groups.map(group => (
          <Box key={group.key} component="section" className="h5-search-group" data-group={group.key} aria-labelledby={`h5-search-group-${group.key}`}>
            <Typography id={`h5-search-group-${group.key}`} variant="overline" component="h3" color="text.secondary" sx={{ display: 'block', px: 2, pt: 1, lineHeight: 2.5 }}>{t(group.title)}</Typography>
            <Box role="list" aria-labelledby={`h5-search-group-${group.key}`}>
              {group.results.map(result => <ResultRow key={result.key} result={result} query={query} tag={tagOf(engineOf(result.item))} thisYear={thisYear} onOpen={onOpen} />)}
            </Box>
          </Box>
        ))}
        <Typography id="h5-search-count" role="status" variant="body2" color="text.secondary" sx={{ px: 2, py: 2 }}>
          {query.trim() ? (found.count ? t(found.count === 1 ? '1 result' : `${found.count} results`) : t('No results')) : t('Searches titles, notes, results and names; birthdays also match their lunar date (try "lunar 10/7").')}
        </Typography>
      </Box>
    </Dialog>
  );
}
