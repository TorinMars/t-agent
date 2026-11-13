import { createTheme } from '@mui/material/styles';
import { blue } from '@mui/material/colors';

// On a touch screen (input mode 'touch', `<html data-input="touch">`, set by entry.jsx before the first render) every button, list row, checkbox and
// text input is at least 44 x 44px, the size of a fingertip (Apple HIG 44pt, WCAG 2.5.5). A computer (input mode 'pointer') keeps the compact sizes.
// The rule is in the theme, so a new button gets it too; a component that needs a smaller look keeps a 44px target with padding or a `::after`.
export const TOUCH = 'html[data-input="touch"] &';
const FINGER = { [TOUCH]: { minWidth: 44, minHeight: 44 } };

// The Material UI dark theme, with the buttons and inputs made flat and compact: sentence case, no shadow, one corner radius. The colours are as they come,
// plus `notice`: a filled blue for a request that waits for the user on top of the dark terminal (the copy bar, Terminal.jsx). It is the primary
// hue (MUI blue) at 800: the dark theme's own blues (primary #90caf9, info #29b6f6) are too light for white text, while white on blue 800 is 5.7:1
// (WCAG AA). `button` / `buttonHover` are the white filled button on it, whose blue text keeps at least 5:1 at rest and on hover; `ring` is the
// primary blue of the one highlight pulse when the bar appears.
const palette = { mode: 'dark', notice: { main: blue[800], contrastText: '#fff', button: '#fff', buttonHover: blue[50], ring: blue[200] } };
const base = createTheme({ palette });

// `<Typography color="text.secondary">` (or "warning.main", "primary.light"): Material UI 9 no longer reads a palette path in Typography's `color`
// prop (only names such as 'textSecondary' and 'warning'), so every hint and caption written that way came out in the full white of the headings.
// These variants give the paths their colour again.
const TEXT_COLORS = [
  ...['primary', 'secondary', 'disabled'].map(key => ({ props: { color: `text.${key}` }, style: { color: base.palette.text[key] } })),
  ...['primary', 'secondary', 'error', 'warning', 'info', 'success'].flatMap(hue => ['main', 'light', 'dark'].map(shade => ({ props: { color: `${hue}.${shade}` }, style: { color: base.palette[hue][shade] } }))),
];

export const theme = createTheme({
  palette,
  components: {
    MuiTypography: { variants: TEXT_COLORS },
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { textTransform: 'none', borderRadius: 8, fontWeight: 500, letterSpacing: 0, [TOUCH]: { minHeight: 44 } } } },
    MuiIconButton: { styleOverrides: { root: FINGER } },
    MuiToggleButton: { styleOverrides: { root: { textTransform: 'none', borderRadius: 8, ...FINGER } } },
    MuiListItemButton: { styleOverrides: { root: { [TOUCH]: { minHeight: 44 } } } },
    MuiCheckbox: { styleOverrides: { root: { [TOUCH]: { padding: 10 } } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 8, [TOUCH]: { minHeight: 44 } } } },
  },
});
