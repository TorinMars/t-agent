import { createTheme } from '@mui/material/styles';

// On a touch screen (input mode 'touch', `<html data-input="touch">`, set by entry.jsx before the first render) every button, list row, checkbox and
// text input is at least 44 x 44px, the size of a fingertip (Apple HIG 44pt, WCAG 2.5.5). A computer (input mode 'pointer') keeps the compact sizes.
// The rule is in the theme, so a new button gets it too; a component that needs a smaller look keeps a 44px target with padding or a `::after`.
export const TOUCH = 'html[data-input="touch"] &';
const FINGER = { [TOUCH]: { minWidth: 44, minHeight: 44 } };

// The Material UI dark theme, with the buttons and inputs made flat and compact: sentence case, no shadow, one corner radius. The colours are as they come.
export const theme = createTheme({
  palette: { mode: 'dark' },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { textTransform: 'none', borderRadius: 8, fontWeight: 500, letterSpacing: 0, [TOUCH]: { minHeight: 44 } } } },
    MuiIconButton: { styleOverrides: { root: FINGER } },
    MuiToggleButton: { styleOverrides: { root: { textTransform: 'none', borderRadius: 8, ...FINGER } } },
    MuiListItemButton: { styleOverrides: { root: { [TOUCH]: { minHeight: 44 } } } },
    MuiCheckbox: { styleOverrides: { root: { [TOUCH]: { padding: 10 } } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 8, [TOUCH]: { minHeight: 44 } } } },
  },
});
