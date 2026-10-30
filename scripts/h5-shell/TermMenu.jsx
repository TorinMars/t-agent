import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';

// The sheet from the bottom that serves three lists: the actions of a terminal, the actions of a chat, and the "Session" choices of the "+" of a task.
export function TermMenu({ state, ui }) {
  const menu = state.menu;
  return (
    <Drawer
      anchor="bottom" id="h5-term-menu" open={Boolean(menu)} onClose={() => ui.actions.menuCancel()}
      slotProps={{ paper: { className: 'h5-menu-panel', sx: { maxWidth: 480, width: '100%', mx: 'auto', borderRadius: '16px 16px 0 0', p: 1.5, backgroundImage: 'none', maxHeight: '80vh' } } }}
      aria-labelledby="h5-term-menu-title"
    >
      {menu ? (
        <>
          <Typography id="h5-term-menu-title" variant="subtitle2" component="h3" color="text.secondary" sx={{ mb: 1, overflowWrap: 'anywhere' }}>{menu.title}</Typography>
          {menu.renaming ? (
            <Box
              component="form" id="h5-term-rename" className="h5-menu-rename" autoComplete="off" sx={{ display: 'flex', gap: 1, mb: 1 }}
              onSubmit={event => { event.preventDefault(); ui.actions.menuRename(new FormData(event.currentTarget).get('title')); }}
            >
              <TextField
                id="h5-term-rename-input" name="title" size="small" fullWidth autoFocus defaultValue={menu.renameValue}
                onFocus={event => event.target.select()}
                slotProps={{ htmlInput: { maxLength: 40, enterKeyHint: 'done', 'aria-label': t('Terminal name') } }}
              />
              <Button type="submit" variant="contained">{t('Save')}</Button>
            </Box>
          ) : (
            <List id="h5-term-menu-actions" className="h5-menu-actions" disablePadding sx={{ overflowY: 'auto' }}>
              {menu.items.map((item, index) => (
                <ListItemButton key={`${index}:${item.label}`} component="button" className={item.kind === 'danger' ? 'danger' : undefined} onClick={() => ui.actions.menuRun(index)}
                  sx={{ borderRadius: 1, color: item.kind === 'danger' ? 'error.main' : undefined, overflowWrap: 'anywhere', textAlign: 'left' }}>
                  {item.kind === 'raw' ? item.label : t(item.label)}
                </ListItemButton>
              ))}
            </List>
          )}
          <Button id="h5-term-menu-cancel" className="h5-menu-cancel" onClick={() => ui.actions.menuCancel()} fullWidth sx={{ mt: 1 }}>{t('Cancel')}</Button>
        </>
      ) : null}
    </Drawer>
  );
}
