import Box from '@mui/material/Box';
import { lighten } from '@mui/material/styles';
import { t } from './common.jsx';
import { dayTitle } from './calendar-model.mjs';
import { durationText } from './calendar-views.mjs';

// The small parts the calendar views (AttentionCalendar.jsx, CalendarViews.jsx) and the search (AttentionSearch.jsx) share ("Calendar view" in
// docs/design/page-attention-calendar.md): the colour of each kind, its dot, the words of a day and of a duration.

// The colour of each kind, from the theme's `palette.calendar` (theme.mjs): once blue, repeats teal, birthdays pink, anniversaries orange (`main`:
// dots and tints; `light`: text on a tint); a to do with a due date a hollow ring.
export const HUE = (theme, kind) => { const main = theme.palette.calendar[kind] || theme.palette.text.secondary; return { main, light: lighten(main, 0.45) }; };
export function KindDot({ kind, size = 6 }) {
  const ring = kind === 'todo' || kind === 'none';
  return (
    <Box
      component="span" className="h5-cal-dot" data-kind={kind} aria-hidden="true"
      sx={{ flex: '0 0 auto', display: 'inline-block', width: size, height: size, boxSizing: 'border-box', borderRadius: '50%', ...(ring ? { border: '1.5px solid', borderColor: kind === 'none' ? 'text.disabled' : 'text.primary' } : { bgcolor: theme => HUE(theme, kind).main }) }}
    />
  );
}
// "Thursday, Nov 26" -> its words: the templates of i18n-zh-ui.js translate the whole ("{1}, Nov {2}").
export const dayWords = (date, short) => t(dayTitle(date, { short }));
// "1 hour", "1.5 hours", "45 min" in the page's language ('' for none).
export const durationWords = minutes => { const text = durationText(minutes); return text ? t(text) : ''; };
// The text of a view's segment and of other words whose English is already taken in the dictionaries by another meaning ("Day" is the date field,
// "Month" the month field): the Chinese of `key` when there is one, else the English `short`.
export const wordOr = (key, short) => { const word = t(key); return word !== key ? word : short; };
