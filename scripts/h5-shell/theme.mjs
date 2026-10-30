import { createTheme } from '@mui/material/styles';

// The Material UI dark theme, with the buttons and inputs made flat and compact: sentence case, no shadow, one corner radius. The colours are as they come.
export const theme = createTheme({
  palette: { mode: 'dark' },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { textTransform: 'none', borderRadius: 8, fontWeight: 500, letterSpacing: 0 } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 8 } } },
    MuiToggleButton: { styleOverrides: { root: { textTransform: 'none', borderRadius: 8 } } },
  },
});
