import { createContext, useContext, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { t } from './common.jsx';

// The small form parts of the settings sheet (Settings.jsx) and its Devices group (Engines.jsx).
export const failure = error => `${t('Failed')}: ${error.message}`;

// A line under a group's buttons: what was saved, or why it was not. Nothing is drawn when there is nothing to say.
export function useFeedback() {
  const [feedback, setFeedback] = useState({ message: '', error: false });
  return [feedback, (message, error = false) => setFeedback({ message: message ? t(message) : '', error })];
}
export function Feedback({ id, feedback }) {
  if (!feedback.message) return <p id={id} hidden />;
  return <Typography id={id} role="status" variant="body2" color={feedback.error ? 'error' : 'text.secondary'} sx={{ ...HINT, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{feedback.message}</Typography>;
}

// The type scale of an open group, from strong to quiet: the group title (the 16px row label, ROW), the heading of a part (SubHeading: 15px bold;
// 14px semi-bold for a part inside a part), the fields and their labels (16px), then the helper text: 13px (never smaller than 12px) with a 1.5 line
// height in the secondary text colour, so a note reads as a note under its control and an open group is not a wall of same-size text.
export const HINT = { fontSize: '0.8125rem', lineHeight: 1.5 };
// Helper text. Test hook: `.h5-setting-hint`.
export const Hint = ({ children, id, sx }) => <Typography id={id} variant="body2" color="text.secondary" className="h5-setting-hint" sx={{ ...HINT, overflowWrap: 'anywhere', ...sx }}>{children}</Typography>;

// The buttons of a part, on one row that wraps. One rule for every part: at most one main action, first and contained (Save, Generate…); every other
// action outlined (deleting: outlined in the error colour); none in a part inside a part (Advanced) is contained. Buttons keep their own width: a lone
// button directly in a part or a group is not stretched either (`Section`, `Group`). Test hook: `.h5-setting-actions`.
export const Actions = ({ id, children, sx }) => <Box id={id} className="h5-setting-actions" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, ...sx }}>{children}</Box>;
export const Field = ({ id, label, htmlInput, ...props }) => (
  <TextField id={id} label={t(label)} size="small" fullWidth autoComplete="off" slotProps={{ htmlInput: { autoCapitalize: 'off', spellCheck: false, ...htmlInput } }} {...props} />
);

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

// The one look of every top-level row of the settings sheet (plain rows and the headers of the folding groups): the body1 label, 16px side
// padding (lined up with the sheet title), 56px high and a full-width divider under it. Test hook: `.h5-setting-label` on the label.
export const ROW_HEIGHT = 56;
export const ROW = { minHeight: ROW_HEIGHT, px: 2, typography: 'body1' };

// Brings a section (`#h5-sec-<id>`) of an open group, or the group itself, to the top of the sheet's scrolling body.
function reveal(group, section) {
  const target = (section && document.getElementById(`h5-sec-${section}`)) || group;
  if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
}

// Called each time any group opens (ScopeLabel.jsx reads the scope labels then): the sheet itself reads nothing until a group is opened.
let groupOpened = null;
export const onAnyGroupOpen = listener => { groupOpened = listener; };

// Which groups the chosen tab of the sheet has parts in (Settings.jsx gives `group => boolean`; settings-tabs.mjs groupShown). A group with nothing in
// the tab stays mounted, so it keeps its state, but is hidden. Without a provider every group is shown.
export const GroupShown = createContext(null);

// One folding group. Its data is read each time it is opened (`onOpen`). `request`: { section, seq } from `ui.actions.openSettings(id)`
// (settings-target.mjs) opens the group from outside and, once it has unfolded, scrolls to that section; a new request is a new object.
export function Group({ id, title, onOpen, request = null, children }) {
  const shown = useContext(GroupShown);
  const hidden = Boolean(shown) && !shown(id);
  const [open, setOpen] = useState(false);
  const node = useRef(null);
  const pending = useRef(null); // the section to show once the opening animation has ended
  useEffect(() => {
    if (!request) return;
    if (open) { reveal(node.current, request.section); return; }
    pending.current = request.section || '';
    setOpen(true);
    if (groupOpened) groupOpened();
    onOpen();
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps -- only a new request opens the group
  const entered = () => {
    if (pending.current === null) return;
    const section = pending.current;
    pending.current = null;
    reveal(node.current, section);
  };
  return (
    <Accordion
      ref={node} id={`h5-set-${id}`} className="h5-setting-group" expanded={open} disableGutters square elevation={0} hidden={hidden}
      sx={{ '&::before': { display: 'none' }, borderBottom: 1, borderColor: 'divider', bgcolor: 'transparent', '&[hidden]': { display: 'none' } }}
      onChange={(_, expanded) => { setOpen(expanded); if (expanded) { if (groupOpened) groupOpened(); onOpen(); } }}
      slotProps={{ transition: { unmountOnExit: false, onEntered: entered } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ ...ROW, '&.Mui-expanded': { minHeight: ROW_HEIGHT }, '& .MuiAccordionSummary-content': { my: 0 } }}>
        <span className="h5-setting-label">{t(title)}</span>
      </AccordionSummary>
      <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, px: 2, pt: 0, pb: 2.5, ...FLOW }}>{children}</AccordionDetails>
    </Accordion>
  );
}

// The heading of a part of a group: the same bold line as the parts of T-Attention ("Reminders on this device", "CLI tokens"), 15px (HINT above).
// `level` 4 is a part inside a part (the two parts of "Advanced" in Devices): 14px semi-bold.
export const SubHeading = ({ id, level = 3, children }) => (
  <Typography
    id={id} variant="subtitle2" component={`h${level}`} className="h5-setting-subheading"
    sx={{ fontSize: level === 3 ? '0.9375rem' : '0.875rem', lineHeight: 1.4, fontWeight: level === 3 ? 700 : 600, color: 'text.primary', overflowWrap: 'anywhere' }}
  >{children}</Typography>
);

// The flow inside a group and a part: a lone button keeps its own width (Actions), and a hint right under a heading, a field or a checkbox sits closer
// to it than the 12px between controls, so it reads as that control's note.
const FLOW = {
  '& > .MuiButton-root': { alignSelf: 'flex-start' },
  '& > :is(.h5-setting-subheading, .h5-scoped-heading, .h5-setting-minor, .MuiFormControl-root, .MuiFormControlLabel-root) + .h5-setting-hint': { mt: -0.75 },
  '& > .h5-setting-hint + .h5-setting-hint': { mt: -0.5 },
};
// A top-level part after anything else is set apart by a full-width divider; a part inside a part (level 4) has none, only a little more space.
const PART = {
  3: { gap: 1.5, '* + &': { borderTop: 1, borderColor: 'divider', pt: 2.5, mt: 0.5 } },
  4: { gap: 1.25, '* + &': { mt: 0.5 } },
};
// The look of a top-level part for a container that is not a `Section` (the T-Attention slots, attention-slots.mjs).
export const PART_SX = { display: 'flex', flexDirection: 'column', minWidth: 0, ...PART[3], ...FLOW };

// One part of a group (`#h5-sec-<id>`, settings-target.mjs): an optional heading, then its fields. A top-level part that follows anything else is set
// apart by a divider (PART).
// `aside`: drawn after the heading on the same line (wrapping under it on a narrow screen), the scope label of the part (ScopeLabel.jsx).
export function Section({ id, title, level = 3, aside = null, children, sx }) {
  const heading = title ? <SubHeading id={`h5-sec-${id}-title`} level={level}>{t(title)}</SubHeading> : null;
  return (
    <Box
      component="section" id={`h5-sec-${id}`} className="h5-setting-section" aria-labelledby={title ? `h5-sec-${id}-title` : undefined}
      sx={[{ display: 'flex', flexDirection: 'column', minWidth: 0, scrollMarginTop: 8, ...PART[level === 4 ? 4 : 3], ...FLOW }, ...(Array.isArray(sx) ? sx : [sx])]}
    >
      {heading && aside ? <Box className="h5-scoped-heading" sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, minWidth: 0, '& > .h5-scope': { flex: '1 1 10rem' } }}>{heading}{aside}</Box> : heading}
      {children}
    </Box>
  );
}
