import { useState } from 'react';
import Box from '@mui/material/Box';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { KEY, keyTick } from './Osk.jsx';
import { Group, Hint, Section, SwitchRow } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { InTab } from './DeviceTarget.jsx';
import { STRENGTHS, hapticKind, hapticsOn, readStrength, writeStrength } from './key-haptics.mjs';

// Settings → Keyboard ("Vibration on key taps" in docs/design/key-haptics.md): how strongly the page's own keys vibrate on this device
// (the terminal keyboard, the key row of the bottom bar and the Learn keyboards; key-feedback.mjs plays it). Kept in this browser (key-haptics.mjs),
// so the label says "This device only" whichever device tab is chosen (`follow={false}`). It takes effect at once: no Save button.
// What the section shows follows what the device can play (key-haptics.mjs `hapticKind`):
// - 'vibrate' (Android): an MD2 radio list Off / Light / Medium / Strong; choosing one plays it once; "Try it" keys tick with the chosen strength.
// - 'switch' (iPhone, iPad): one switch row, since a web page there can play only the system's one tap.
// - 'none' (a computer): "This device cannot vibrate". The group stays in the list, so every device shows the same groups in the same order.
export function KeyboardGroup({ request }) {
  return (
    <Group id="keyboard" title="Keyboard" onOpen={() => {}} request={request}>
      <InTab part="key-haptics"><KeyHapticsSection /></InTab>
    </Group>
  );
}

const USED_BY = 'Choosing one plays it once. It is used by the page’s own keys: the terminal keyboard, the key row (Esc, arrows, Enter, Backspace, Tab…) and the Learn letter keyboard. The system keyboard has its own setting in the phone’s settings.';

function KeyHapticsSection() {
  const [kind] = useState(() => hapticKind());
  const [strength, setStrength] = useState(() => readStrength());
  // Kept for this device, then played once inside the tap that chose it. A browser that refuses to keep it (private mode) still shows the choice
  // here; the keys then go on with the default.
  const choose = value => { writeStrength(value); setStrength(value); keyTick(value); };
  return (
    <Section id="key-haptics" title="Vibration on key taps" aside={<ScopeLabel scope="device" follow={false} />}>
      {kind === 'vibrate' ? <Strengths strength={strength} onChoose={choose} />
        : kind === 'switch' ? (
          <>
            <SwitchRow
              inputId="h5-key-haptics-switch" label={t('Vibrate on key taps')} secondary={t('A light tap, as the system plays it')}
              checked={hapticsOn(strength)} onChange={on => choose(on ? 'light' : 'off')}
            />
            <Hint id="h5-key-haptics-hint">{t('iPhone lets a web page play only one kind of tap, so there is no strength to choose here.')}</Hint>
          </>
        ) : (
          <>
            <Typography id="h5-key-haptics-none" variant="body1">{t('This device cannot vibrate')}</Typography>
            <Hint>{t('On a phone or tablet, choose here how the page’s own keys vibrate.')}</Hint>
          </>
        )}
    </Section>
  );
}

// The radio list (MD2: a list of options that take effect at once, one 56px row each, the radio at the start, the label and its note). The chosen
// row carries the selected overlay of the primary colour. The rows reach the edges of the card.
function Strengths({ strength, onChoose }) {
  return (
    <>
      <RadioGroup id="h5-key-haptics" name="h5-key-haptics" value={strength} onChange={event => onChoose(event.target.value)} aria-label={t('Vibration on key taps')} sx={{ mx: -2 }}>
        {STRENGTHS.map(item => {
          const selected = item.id === strength;
          return (
            <Box
              component="label" key={item.id} className="h5-radio-row" data-strength={item.id} data-selected={selected ? '' : undefined}
              sx={{
                display: 'flex', alignItems: 'center', gap: 2, minHeight: 56, px: 2, cursor: 'pointer',
                bgcolor: theme => (selected ? alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity) : 'transparent'),
              }}
            >
              <Radio edge="start" value={item.id} slotProps={{ input: { id: `h5-key-haptics-${item.id}`, 'aria-describedby': `h5-key-haptics-${item.id}-note` } }} />
              <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', py: 0.5 }}>
                <Typography component="span" variant="body1">{t(item.label)}</Typography>
                <Typography component="span" id={`h5-key-haptics-${item.id}-note`} variant="body2" color="text.secondary">{t(item.note)}</Typography>
              </Box>
            </Box>
          );
        })}
      </RadioGroup>
      <Hint>{t(USED_BY)}</Hint>
      <TryIt strength={strength} />
    </>
  );
}

// A few keys that tick with the chosen strength on their press, as the page's keys do (pointerdown; a click from a screen reader or the keyboard,
// `detail` 0, ticks too). They type nothing.
const TRY_KEYS = [
  { id: 'q', label: 'q' }, { id: 'w', label: 'w' }, { id: 'e', label: 'e' },
  { id: 'Escape', label: 'Esc', aria: 'Escape' }, { id: 'Enter', icon: 'keyEnter', aria: 'Enter' }, { id: 'Backspace', icon: 'keyBackspace', aria: 'Backspace' },
];
function TryIt({ strength }) {
  return (
    <Box id="h5-key-try" sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
      <Typography id="h5-key-try-title" component="p" variant="caption" color="text.secondary" sx={{ m: 0, mb: 1 }}>{t('Try it')}</Typography>
      <Box role="group" aria-labelledby="h5-key-try-title" sx={{ display: 'flex', gap: 0.75, justifyContent: 'center', flexWrap: 'wrap' }}>
        {TRY_KEYS.map(item => {
          const name = item.aria ? t(item.aria) : item.label;
          return (
            <Box
              component="button" type="button" key={item.id} className="h5-key-try-key" data-key={item.id} data-fn={item.aria ? '' : undefined}
              aria-label={name} title={item.icon ? name : undefined}
              onPointerDown={event => { if (event.button <= 0) keyTick(strength); }} onClick={event => { if (event.detail === 0) keyTick(strength); }}
              sx={{ ...KEY, minWidth: 44, px: 1.5, ...(item.aria ? null : { fontFamily: 'ui-monospace, Menlo, monospace' }) }}
            >{item.icon ? <Icon name={item.icon} size={22} /> : item.label}</Box>
          );
        })}
      </Box>
    </Box>
  );
}
