import Box from '@mui/material/Box';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { tabEntries, tabHint } from './settings-tabs.mjs';
import { chooseTab, useDeviceTargets } from './DeviceTarget.jsx';

// The tab row at the top of the settings sheet, under its title: Shared, this device (its engine name, "This device" under it), then each linked device
// in the order of the device list ("Settings of a linked device" in DESIGN.md). Drawn only while a device is linked (DeviceTarget.jsx); a linked device
// that is too old, or offline and not known, is a disabled tab with the reason under its name. The row scrolls sideways when the tabs do not fit, with
// a scroll button at each end that shows while there is more to see; the arrow keys move between the tabs (MUI Tabs). The line under the row says
// what a change in the chosen tab affects. Device names are user content: never translated.
const ScrollStart = () => <Box component="span" sx={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="treeChevron" size={16} /></Box>;
const ScrollEnd = () => <Box component="span" sx={{ display: 'inline-flex' }}><Icon name="treeChevron" size={16} /></Box>;

function TabLabel({ entry }) {
  return (
    <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.2, maxWidth: '11rem' }}>
      <Box component="span" className="h5-settings-tab-name" translate={entry.value === 'shared' ? undefined : 'no'} sx={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.label}</Box>
      {entry.note ? <Typography component="span" variant="caption" className="h5-settings-tab-note" sx={{ lineHeight: 1.2, color: 'inherit', opacity: 0.85, whiteSpace: 'nowrap' }}>{entry.note}</Typography> : null}
    </Box>
  );
}

export function SettingsTabs({ state }) {
  const { tab, devices } = useDeviceTargets();
  if (tab === null) return null;
  const local = (state.sources || []).find(source => source.key === 'local');
  const entries = tabEntries(devices, { localName: (local && local.name) || '', t });
  const hint = tabHint(tab, devices, { t });
  return (
    <Box id="h5-settings-tabs-row" sx={{ borderTop: 1, borderColor: 'divider', minWidth: 0 }}>
      <Tabs
        id="h5-settings-tabs" value={tab} onChange={(_, value) => chooseTab(value)} aria-label={t('Settings for')}
        variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile
        slots={{ startScrollButtonIcon: ScrollStart, endScrollButtonIcon: ScrollEnd }}
        sx={{ minHeight: 48, '& .MuiTabScrollButton-root': { width: 44, flexShrink: 0, color: 'text.secondary' }, '& .MuiTabScrollButton-root.Mui-disabled': { opacity: 0 } }}
      >
        {entries.map(entry => (
          <Tab
            key={entry.value} value={entry.value} id={`h5-settings-tab-${entry.value}`} data-tab={entry.value} className="h5-settings-tab" disabled={entry.disabled}
            title={entry.title} label={<TabLabel entry={entry} />}
            sx={{ minHeight: 48, minWidth: 72, px: 1.5, py: 0.75, textTransform: 'none', fontSize: 14, fontWeight: 600, '&.Mui-disabled': { color: 'text.disabled' } }}
          />
        ))}
      </Tabs>
      {hint ? <Typography id="h5-settings-tab-hint" variant="caption" component="p" color="text.secondary" sx={{ m: 0, px: 2, pb: 1, pt: 0.5, overflowWrap: 'anywhere' }}>{hint}</Typography> : null}
    </Box>
  );
}
