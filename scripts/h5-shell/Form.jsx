import { createContext, useContext, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Switch from '@mui/material/Switch';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';
import { groupInfo } from './settings-target.mjs';

// The small form parts of the Settings page (Settings.jsx) and its groups (Engines.jsx, AttentionSettings.jsx, ...). One look for every group, in
// Material Design 2: a group is a page of cards (`Group`, `Section`), an option that takes effect at once is a switch row (`SwitchRow`), a field is an
// outlined small text field with a label (`Field`), the buttons of a card sit at its bottom right (`Actions`). See "Settings page" in
// docs/design/page-files-and-settings.md.
export const failure = error => `${t('Failed')}: ${error.message}`;

// A line under a card's buttons: what was saved, or why it was not. Nothing is drawn when there is nothing to say.
export function useFeedback() {
  const [feedback, setFeedback] = useState({ message: '', error: false });
  return [feedback, (message, error = false) => setFeedback({ message: message ? t(message) : '', error })];
}
export function Feedback({ id, feedback }) {
  if (!feedback.message) return <p id={id} hidden />;
  return <Typography id={id} role="status" variant="body2" color={feedback.error ? 'error' : 'text.secondary'} sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{feedback.message}</Typography>;
}

// Helper text: body2 in the secondary text colour (MD2 type scale; no size of its own). `HINT` is kept for the parts that style a Typography of their
// own as a hint. Test hook: `.h5-setting-hint`.
export const HINT = {};
export const Hint = ({ children, id, sx, component }) => <Typography id={id} component={component} variant="body2" color="text.secondary" className="h5-setting-hint" sx={{ overflowWrap: 'anywhere', ...sx }}>{children}</Typography>;

// The buttons of a card, on one row at its bottom right that wraps. One rule for every card: at most one main action, contained and last (at the
// right: Save, Generate…); every other action is a text button before it (at its left), a destructive one in the error colour (it still asks first).
// Test hook: `.h5-setting-actions`.
export const Actions = ({ id, children, sx }) => <Box id={id} className="h5-setting-actions" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 1, ...sx }}>{children}</Box>;
export const Field = ({ id, label, htmlInput, ...props }) => (
  <TextField id={id} label={t(label)} size="small" fullWidth autoComplete="off" slotProps={{ htmlInput: { autoCapitalize: 'off', spellCheck: false, ...htmlInput } }} {...props} />
);

// MUI's hidden input of a switch is three thumbs wide and starts one thumb to the left of it; it is kept on the switch, so a click on it (a test, a
// screen reader) lands on the switch and it never sticks out of a card. The whole row is the click target anyway.
export const INPUT_INSIDE = { left: 0, width: '100%' };

// An option that takes effect at once, as an MD2 list row: the label (body1) and an optional line under it (body2, secondary) at the left, the switch at
// the right; the whole row is a <label>, so a tap anywhere on it toggles the switch. `aside` is drawn under the text (a scope label, ScopeLabel.jsx);
// `inputLabel` names the switch when `label` is not plain text.
// A Checkbox is used only inside a form that is saved with a button, or to pick several items of a list. Test hook: `.h5-switch-row`.
export function SwitchRow({ id, inputId, inputClassName, inputLabel, label, secondary = null, aside = null, checked, disabled = false, onChange, className, sx, ...rest }) {
  const described = inputId && secondary ? `${inputId}-desc` : undefined;
  return (
    <Box
      component="label" id={id} className={['h5-switch-row', className].filter(Boolean).join(' ')} {...rest}
      sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 48, minWidth: 0, cursor: disabled ? 'default' : 'pointer', ...sx }}
    >
      <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25, py: 0.5 }}>
        <Typography component="span" variant="body1" className="h5-switch-label" color={disabled ? 'text.disabled' : 'text.primary'} sx={{ overflowWrap: 'anywhere' }}>{label}</Typography>
        {secondary ? <Typography component="span" id={described} variant="body2" color="text.secondary" className="h5-setting-hint" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{secondary}</Typography> : null}
        {aside}
      </Box>
      <Switch
        checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} sx={{ flexShrink: 0 }}
        slotProps={{ input: { id: inputId, className: inputClassName, 'aria-label': inputLabel || (typeof label === 'string' ? label : undefined), 'aria-describedby': described, style: INPUT_INSIDE } }}
      />
    </Box>
  );
}

// One dialog for the forms of the Devices group (remote engines and linked services): full screen on a phone, a normal dialog on a wide screen.
export function EngineDialog({ state, id, title, open, onClose, locked = false, children, actions }) {
  return (
    <Dialog id={id} open={open} onClose={locked ? undefined : onClose} fullScreen={!state.wide} fullWidth maxWidth="sm" aria-labelledby={`${id}-title`}>
      <DialogTitle id={`${id}-title`} sx={{ overflowWrap: 'anywhere' }}>{title}</DialogTitle>
      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{children}</DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>{actions}</DialogActions>
    </Dialog>
  );
}

// Brings a section (`#h5-sec-<id>`) of the shown group, or the top of the group, into view in the scrolling pane of the page.
function reveal(group, section) {
  const target = (section && document.getElementById(`h5-sec-${section}`)) || group;
  if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
}

// Called each time any group opens (ScopeLabel.jsx reads the scope labels then): the page itself reads nothing of a group until it is opened.
let groupOpened = null;
export const onAnyGroupOpen = listener => { groupOpened = listener; };

// Which groups the chosen device tab has parts in (Settings.jsx gives `group => boolean`; settings-tabs.mjs groupShown). A group with nothing in the
// tab stays mounted, so it keeps its state, but is hidden and left out of the group list. Without a provider every group is shown.
export const GroupShown = createContext(null);
// The group the page shows (Settings.jsx): { current: a group id or null (the list on a phone), wide }. Without a provider every group is shown.
export const SettingsNav = createContext(null);

// One group: a page of cards. Every group is mounted while the page is open and only the chosen one is shown, so an edit that is not saved yet is
// kept when another group or device is chosen and the person comes back. Its data is read each time it is shown (`onOpen`): a group that is never
// chosen reads nothing. `request`: { section, seq } from `ui.actions.openSettings(id)` (settings-target.mjs); once the group is shown the section is
// brought into view (a new request is a new object). On a computer the group starts with its title (h5, focused when the person picks the group) and
// its one-line description; on a phone the title is in the app bar of the group's page (Settings.jsx) and the page starts with the description.
export function Group({ id, title, onOpen, request = null, children }) {
  const shown = useContext(GroupShown);
  const nav = useContext(SettingsNav);
  const hidden = Boolean(shown) && !shown(id);
  const selected = !hidden && (!nav || nav.current === id);
  const wide = !nav || nav.wide;
  const node = useRef(null);
  const revealed = useRef(null);
  useEffect(() => {
    if (!selected) return;
    if (groupOpened) groupOpened();
    onOpen();
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps -- each showing of the group is an opening
  useEffect(() => {
    if (!request || !selected || revealed.current === request.seq) return undefined;
    revealed.current = request.seq;
    const go = () => reveal(node.current, request.section);
    // Once now, and again after a part that unfolds with the request (Devices → Advanced) or the phone's page has finished moving.
    const frame = requestAnimationFrame(go);
    const later = setTimeout(go, 400);
    return () => { cancelAnimationFrame(frame); clearTimeout(later); };
  }, [request, selected]);
  const info = groupInfo(id);
  return (
    <Box
      ref={node} component="section" id={`h5-set-${id}`} className="h5-setting-group" data-group={id} hidden={!selected}
      role={nav && wide ? 'tabpanel' : undefined} aria-labelledby={nav && !wide ? 'h5-settings-page-title' : `h5-set-${id}-title`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, scrollMarginTop: 24, '&[hidden]': { display: 'none' } }}
    >
      {wide ? (
        <Box component="header" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1 }}>
          <Typography id={`h5-set-${id}-title`} component="h2" variant="h5" className="h5-group-title" tabIndex={-1} sx={{ outline: 'none', overflowWrap: 'anywhere' }}>{t(title)}</Typography>
          {info ? <Typography variant="body2" color="text.secondary" className="h5-group-description">{t(info.description)}</Typography> : null}
        </Box>
      ) : info ? <Typography variant="body2" color="text.secondary" className="h5-group-description">{t(info.description)}</Typography> : null}
      {children}
    </Box>
  );
}

// The title of a card, or of a part inside a card (`level` 4). MD2: subtitle1 in medium weight for a card, subtitle2 for a part inside it.
export const SubHeading = ({ id, level = 3, children }) => (
  <Typography
    id={id} variant={level === 3 ? 'subtitle1' : 'subtitle2'} component={`h${level}`} className="h5-setting-subheading"
    sx={{ fontWeight: 500, color: 'text.primary', overflowWrap: 'anywhere' }}
  >{children}</Typography>
);

// A small label inside a card ("Shared skills", "Listeners", "Web addresses"): the MD2 overline, in the secondary text colour.
export const MinorHeading = ({ id, children, sx }) => (
  <Typography id={id} variant="overline" component="h4" color="text.secondary" className="h5-setting-minor" sx={{ display: 'block', lineHeight: 2, overflowWrap: 'anywhere', ...sx }}>{children}</Typography>
);

// The flow inside a card: a lone button keeps its own width and sits at the right (the place of a card's main action), and a hint right under a
// heading, a field or a checkbox sits closer to it than the 12px between controls, so it reads as that control's note.
const FLOW = {
  '& > .MuiButton-root': { alignSelf: 'flex-end' },
  '& > :is(.h5-setting-subheading, .h5-scoped-heading, .h5-setting-minor, .MuiFormControl-root, .MuiFormControlLabel-root) + .h5-setting-hint': { mt: -0.75 },
  '& > .h5-setting-hint + .h5-setting-hint': { mt: -0.5 },
};
// A card of a group (MD2 card: background.paper, elevation 1, 8px corners from the theme, 16px padding); a part inside a card (level 4) has none,
// only a little more space above it.
const CARD = { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1.5, p: 2, overflow: 'visible' };
const INNER = { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1.25, '* + &': { mt: 1 } };
// The look of a card for a container that is not a `Section` (the T-Attention slots, attention-slots.mjs).
export const PART_SX = { ...CARD, ...FLOW };
export const SettingsCard = ({ id, className, children, sx, ...rest }) => (
  <Card component="section" elevation={1} id={id} className={['h5-setting-card', className].filter(Boolean).join(' ')} sx={[PART_SX, ...(Array.isArray(sx) ? sx : [sx])]} {...rest}>{children}</Card>
);

// One part of a group (`#h5-sec-<id>`, settings-target.mjs): a card with an optional title, then its fields; `level` 4 is a part inside a card.
// `aside`: drawn after the title on the same line (wrapping under it on a narrow screen), the scope label of the part (ScopeLabel.jsx).
export function Section({ id, title, level = 3, aside = null, children, sx }) {
  const heading = title ? <SubHeading id={`h5-sec-${id}-title`} level={level}>{t(title)}</SubHeading> : null;
  const inner = level === 4;
  const props = {
    id: `h5-sec-${id}`, 'aria-labelledby': title ? `h5-sec-${id}-title` : undefined,
    sx: [{ ...(inner ? INNER : CARD), scrollMarginTop: 24, ...FLOW }, ...(Array.isArray(sx) ? sx : [sx])],
  };
  const body = (
    <>
      {heading && aside ? <Box className="h5-scoped-heading" sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, minWidth: 0, '& > .h5-scope': { flex: '1 1 10rem' } }}>{heading}{aside}</Box> : heading}
      {children}
    </>
  );
  if (inner) return <Box component="section" className="h5-setting-section" {...props}>{body}</Box>;
  return <Card component="section" elevation={1} className="h5-setting-section h5-setting-card" {...props}>{body}</Card>;
}
