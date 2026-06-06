import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0f1117', paper: '#1a1d27' },
    primary: { main: '#e0863f' },
    success: { main: '#10b981' },
    error: { main: '#ef4444' },
    text: { primary: '#f1f5f9', secondary: '#94a3b8' },
    divider: '#2d3748',
  },
  shape: { borderRadius: 11 },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
});
