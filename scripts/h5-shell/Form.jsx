import { useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import TextField from './TextField.jsx';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { t } from './common.jsx';

// The small form parts of the settings sheet (Settings.jsx) and its Engines group (Engines.jsx).
export const failure = error => `${t('Failed')}: ${error.message}`;

// A line under a group's buttons: what was saved, or why it was not. Nothing is drawn when there is nothing to say.
export function useFeedback() {
  const [feedback, setFeedback] = useState({ message: '', error: false });
  return [feedback, (message, error = false) => setFeedback({ message: message ? t(message) : '', error })];
}
export function Feedback({ id, feedback }) {
  if (!feedback.message) return <p id={id} hidden />;
  return <Typography id={id} role="status" variant="body2" color={feedback.error ? 'error' : 'text.secondary'} sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{feedback.message}</Typography>;
}
export const Hint = ({ children, id }) => <Typography id={id} variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{children}</Typography>;
export const Field = ({ id, label, htmlInput, ...props }) => (
  <TextField id={id} label={t(label)} size="small" fullWidth autoComplete="off" slotProps={{ htmlInput: { autoCapitalize: 'off', spellCheck: false, ...htmlInput } }} {...props} />
);

// One folding group. Its data is read each time it is opened.
export function Group({ id, title, onOpen, children }) {
  const [open, setOpen] = useState(false);
  return (
    <Accordion
      id={`h5-set-${id}`} className="h5-setting-group" expanded={open} disableGutters square elevation={0} sx={{ '&::before': { display: 'none' }, borderBottom: 1, borderColor: 'divider', bgcolor: 'transparent' }}
      onChange={(_, expanded) => { setOpen(expanded); if (expanded) onOpen(); }}
      slotProps={{ transition: { unmountOnExit: false } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>{t(title)}</AccordionSummary>
      <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 0 }}>{children}</AccordionDetails>
    </Accordion>
  );
}
