import { createTheme } from '@mui/material/styles';

// The Material UI dark theme as it comes. The page has no other colours of its own: h5.css gives the parts that are not Material UI (the terminal, the chat)
// the same values, so everything on the page agrees.
export const theme = createTheme({ palette: { mode: 'dark' } });
