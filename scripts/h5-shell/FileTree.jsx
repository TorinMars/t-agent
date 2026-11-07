import { useState } from 'react';
import { asyncDataLoaderFeature, hotkeysCoreFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { api, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { useSwipeDown } from './Design.jsx';
import { ROOT_ID, loadPage, noteId } from './file-tree.mjs';

// The read-only file tree of the task's working directory ("Files" in row 2). Browse and preview only: nothing is created, renamed, deleted or written.
// The tree logic is Headless Tree (@headless-tree/core + react, MIT): its async data loader reads one folder when it is expanded, through the list
// endpoint of the task file API (file-tree.mjs). The rows are drawn here with MUI and the library icons. A tap on a file opens it in the file viewer
// (DesignSheet, h5.js `openFileSheet`), which lies over the tree and has a back arrow: the tree stays mounted under it, so the expanded folders and the
// scroll position are kept. The tree is drawn again from the start (`key`) when the task, its working directory or the Engine changes.
const INDENT = 16; // px per level
const ROW = { minHeight: 36, py: 0, gap: 0.75, alignItems: 'center' };
const NAME = { minWidth: 0, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 };

function TreeRow({ item, current, busy }) {
  const data = item.getItemData() || { kind: 'loading' };
  const { level } = item.getItemMeta();
  const props = item.getProps();
  const pad = `${12 + level * INDENT}px`;
  if (data.kind === 'note' || data.kind === 'loading') {
    // An empty folder or an error: a line of text in the tree (focusable with the arrow keys, not a button).
    const { onClick: _click, ...rest } = props; // eslint-disable-line no-unused-vars
    return (
      <Box {...rest} className="h5-files-note" data-error={data.error ? 'true' : undefined} sx={{ ...ROW, display: 'flex', pl: `calc(${pad} + 34px)`, pr: 1.5, fontSize: 13, color: data.error ? 'error.light' : 'text.secondary', outline: 'none', '&:focus-visible': { bgcolor: 'action.focus' } }}>
        {t(data.message || 'Loading…')}
      </Box>
    );
  }
  if (data.kind === 'more') {
    const label = busy ? t('Loading…') : data.failed ? t('Could not load more. Try again') : t('Load more');
    return (
      <ListItemButton {...props} className="h5-files-more" aria-busy={busy || undefined} sx={{ ...ROW, pl: `calc(${pad} + 34px)`, pr: 1.5, color: data.failed ? 'error.light' : 'primary.light', fontSize: 14, fontWeight: 500 }}>{label}</ListItemButton>
    );
  }
  const folder = data.kind === 'dir';
  const expanded = folder && item.isExpanded();
  const plain = data.kind === 'file';
  return (
    <ListItemButton
      {...props} className="h5-files-row" data-path={data.path} data-kind={data.kind} selected={plain && current === data.path} aria-busy={item.isLoading() || undefined}
      aria-disabled={!folder && !plain ? 'true' : undefined} title={data.path}
      sx={{ ...ROW, pl: pad, pr: 1.5, color: folder || plain ? 'text.primary' : 'text.disabled' }}
    >
      <Box component="span" aria-hidden="true" sx={{ flex: '0 0 14px', display: 'inline-flex', color: 'text.secondary', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', visibility: folder ? 'visible' : 'hidden' }}>
        <Icon name="treeChevron" size={14} />
      </Box>
      <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', color: folder ? 'text.primary' : 'text.secondary' }}>
        <Icon name={folder ? (expanded ? 'folderOpen' : 'folder') : 'file'} size={20} />
      </Box>
      <Box component="span" translate="no" sx={NAME}>{data.name}</Box>
      {data.link ? <Box component="span" sx={{ flex: '0 0 auto', fontSize: 12, color: 'text.disabled' }}>{t('link')}</Box> : null}
    </ListItemButton>
  );
}

// One tree for one working directory (`base` = `<tasksBase>/<task>/files`; null without a task).
function TreeView({ base, current, onOpen, onOther }) {
  const [busy, setBusy] = useState(() => new Set()); // the folders whose next page is being read
  const tree = useTree({
    rootItemId: ROOT_ID,
    getItemName: item => (item.getItemData() && item.getItemData().name) || '',
    isItemFolder: item => Boolean(item.getItemData() && item.getItemData().kind === 'dir'),
    createLoadingItemData: () => ({ kind: 'loading' }),
    dataLoader: {
      // Every item's data arrives with its folder's listing (getChildrenWithData); only the root is asked for on its own.
      getItem: id => (id === ROOT_ID ? { kind: 'dir', name: '', path: '' } : { kind: 'file', name: id.split('/').pop(), path: id }),
      getChildrenWithData: id => (base ? loadPage(api, base, id) : Promise.resolve([{ id: noteId(id), data: { kind: 'note', message: 'Choose a task first' } }])),
    },
    onPrimaryAction: item => {
      const data = item.getItemData();
      if (!data) return;
      if (data.kind === 'file') onOpen(data.path);
      else if (data.kind === 'more') void loadMore(data);
      else if (data.kind === 'other') onOther(data);
    },
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
  });
  // The next page of a folder replaces its "Load more" row (file-tree.mjs mergePage).
  async function loadMore(data) {
    const parent = data.parent;
    if (busy.has(parent)) return;
    setBusy(prev => new Set(prev).add(parent));
    const previous = tree.retrieveChildrenIds(parent, true).map(id => ({ id, data: tree.retrieveItemData(id, true) }));
    const children = await loadPage(api, base, parent, data.offset, previous);
    const ref = tree.getDataRef();
    for (const child of children) ref.current.itemData[child.id] = child.data;
    tree.getItemInstance(parent).updateCachedChildrenIds(children.map(child => child.id));
    setBusy(prev => { const next = new Set(prev); next.delete(parent); return next; });
  }
  const loading = (tree.getState().loadingItemChildrens || []).length > 0;
  return (
    <>
      <LinearProgress id="h5-files-loading" aria-label={t('Loading…')} sx={{ flex: '0 0 auto', visibility: loading ? 'visible' : 'hidden' }} />
      <Box className="h5-files-body" id="h5-files-body" sx={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', pb: 2 }}>
        <Box {...tree.getContainerProps(t('Files'))} id="h5-files-tree" aria-busy={loading || undefined} sx={{ py: 0.5, outline: 'none' }}>
          {tree.getItems().map(item => <TreeRow key={item.getKey()} item={item} current={current} busy={busy.has(item.getItemData() && item.getItemData().parent)} />)}
        </Box>
      </Box>
    </>
  );
}

// The sheet (narrow) or the right side panel (wide) that holds the tree. h5.js writes `state.files`: { open, key, base, dir }.
export function FileTreeSheet({ state, ui }) {
  const files = state.files;
  const open = Boolean(files && files.open);
  const side = Boolean(state.wide);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [reload, setReload] = useState(0); // Reload draws the tree again from the server (folders closed)
  const close = () => ui.actions.closeFiles();
  const swipe = useSwipeDown(close);
  const design = state.design;
  const current = design && design.open && design.link ? design.path : null; // the file shown in the viewer is marked in the tree
  const dir = (files && files.dir) || '';
  const contents = (
    <>
      {side ? null : (
        <Box className="h5-design-handle" aria-hidden="true" sx={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center', pt: 1, pb: 0.5 }}>
          <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'text.disabled' }} />
        </Box>
      )}
      <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 1, pl: 2, pr: 1, pb: 1, pt: side ? 1 : 0, borderBottom: 1, borderColor: 'divider' }}>
        <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
          <Typography id="h5-files-title" variant="subtitle1" component="h2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>{t('Files')}</Typography>
          <Typography id="h5-files-path" variant="caption" component="div" color="text.secondary" translate="no" title={dir}
            sx={{ fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', minHeight: '1.66em' }}
          ><bdi>{dir}</bdi></Typography>
        </Box>
        {/* The way back to the design document (row 2 "Docs" opens it, its Files button leads here): DESIGN.md opens over the tree, with a back arrow to it. */}
        <IconButton id="h5-files-design" {...named(t('Design document'))} onClick={() => ui.actions.openDesign()}><Icon name="designDoc" size={20} /></IconButton>
        <IconButton id="h5-files-reload" {...named(t('Reload'))} onClick={() => setReload(value => value + 1)}><Icon name="reload" size={20} /></IconButton>
        <IconButton id="h5-files-close" {...named(t('Close'))} onClick={close}><Icon name="close" size={22} /></IconButton>
      </Box>
      {files ? (
        <TreeView
          key={`${files.key}#${reload}`} base={files.base} current={current}
          onOpen={filePath => ui.actions.openTreeFile(filePath)}
          onOther={data => ui.notify(t(data.link ? 'Symbolic links are not opened' : 'This is not a plain file'))}
        />
      ) : null}
    </>
  );
  if (side) {
    // A wide screen: a panel on the right beside the terminal, where the design document opens (h5.css `html[data-side-panel]`). A file opens in the
    // file panel, which lies over this one; its back arrow (or Escape) shows the tree again.
    return (
      <Drawer
        variant="persistent" anchor="right" id="h5-files-sheet" open={open} transitionDuration={reduced ? 0 : undefined}
        slotProps={{ paper: { className: 'h5-files-panel h5-design-side', role: 'complementary', 'aria-labelledby': 'h5-files-title', onKeyDown: event => { if (event.key === 'Escape' && event.currentTarget.contains(event.target)) { event.stopPropagation(); close(); } }, sx: { width: 'var(--h5-side-width)', height: '100%', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: 1, borderColor: 'divider' } } }}
      >
        {contents}
      </Drawer>
    );
  }
  // A narrow screen: a sheet from the bottom, like the design document (88% of the height, a swipe down closes it). It stays mounted while closed
  // (keepMounted), so opening it again shows the folders as they were left.
  return (
    <Drawer
      anchor="bottom" id="h5-files-sheet" open={open} onClose={close} transitionDuration={reduced ? 0 : undefined}
      ModalProps={{ disableScrollLock: true, keepMounted: true }}
      slotProps={{ paper: { className: 'h5-files-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'h5-files-title', ...swipe, sx: { height: '88dvh', maxWidth: 960, width: '100%', mx: 'auto', borderRadius: '16px 16px 0 0', backgroundImage: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden', pb: 'env(safe-area-inset-bottom)' } } }}
    >
      {contents}
    </Drawer>
  );
}
