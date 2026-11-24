import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import Popover from '@mui/material/Popover';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { DomIcon, t, terminalMark } from './common.jsx';
import { overlay } from './Columns.jsx';
import { TOUCH } from './theme.mjs';
import { barsOf, buttonLabel, shownKeyOf, usageModel } from './plan-usage.mjs';
import { shallowEqual } from './store.mjs';
import { useStore } from './use-store.mjs';

// "Plan usage" in the session header ("Plan usage: the page" in docs/design/plan-usage-page.md): `#h5-usage`, before More, on every kind of session
// and with none shown. Per agent (Claude, then Codex) its mark and four thin bars: 5h plan, 5h time, 7d plan, 7d time (20px high, 4px wide, 2px apart,
// 6px between the windows, 8px between the agents; on a phone the agents stack, Claude's row above Codex's, in one 48px button: 14px high, 3px wide,
// 2px apart, 3px between the windows, a 10px mark). The plan fill is primary, the warning colour at 10% or less left (and on a computer its number
// beside the bars, "7d 8%", so it is not colour alone); the time fill is on-surface 45% over a 14% track. Not read yet: outlined bars without fill. An
// agent that is not signed in or could not be read is left out (the details say why). An offline engine: its last reading, dimmed. A click opens the
// details: a menu-like popover on a computer, a bottom sheet on a phone (a modal, so back.mjs closes it with the back gesture; Escape too).
// The readings come from plan-usage-feed.mjs (`state.planUsage`).
const CLAUDE_COLOR = '#d97757'; // Claude's own colour for its sparkle, as on the session tiles (TaskDrawer.jsx)
const MARKS = { claude: terminalMark('claude'), codex: terminalMark('codex') };
const SLICE = state => ({ planUsage: state.planUsage, sources: state.sources, shownKey: shownKeyOf(state), input: state.input });
const TRACK = 'rgba(255, 255, 255, 0.14)';
const TIME_FILL = 'rgba(255, 255, 255, 0.45)';

function useModel(ui, tickMs = 0) {
  const slice = useStore(ui, SLICE, shallowEqual);
  const [, setTick] = useState(0); // a tick only draws again: the texts are made with the time of each drawing
  useEffect(() => {
    if (!tickMs) return undefined;
    const timer = setInterval(() => setTick(value => value + 1), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);
  const usage = slice.planUsage || { readings: {} };
  return { slice, usage, model: usageModel({ readings: usage.readings, sources: slice.sources, shownKey: slice.shownKey, now: Date.now() }) };
}

function Mark({ agent, size }) {
  return (
    <Box component="span" aria-hidden="true" className={`h5-usage-mark ${agent}`}
      sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, fontSize: size, lineHeight: 1, flex: '0 0 auto',
        color: agent === 'claude' ? CLAUDE_COLOR : 'text.primary', '& svg': { width: size, height: size, fill: 'currentColor' } }}>
      <DomIcon make={MARKS[agent]} />
    </Box>
  );
}

// One agent's four bars (`small`: the phone's stacked rows).
function Bars({ view, small = false }) {
  const bars = barsOf(view);
  return (
    <Box component="span" className="h5-usage-bars" sx={{ display: 'inline-flex', alignItems: 'flex-end' }}>
      {bars.map((bar, index) => (
        <Box key={`${bar.window}-${bar.kind}`} component="span" className={`h5-usage-bar ${bar.kind}`} data-window={bar.window} data-value={Math.round(bar.value * 100)}
          data-low={bar.low ? 'true' : undefined}
          sx={theme => ({
            position: 'relative', overflow: 'hidden', display: 'inline-block', boxSizing: 'border-box', width: small ? 3 : 4, height: small ? 14 : 20, borderRadius: small ? '1.5px' : '2px',
            ml: index === 0 ? 0 : index % 2 ? '2px' : small ? '3px' : '6px',
            ...(view.outlined ? { border: `1px solid ${theme.palette.text.disabled}`, bgcolor: 'transparent' } : { bgcolor: TRACK }),
          })}>
          {view.outlined ? null : (
            <Box component="span" className="h5-usage-fill" sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${bar.value * 100}%`,
              bgcolor: bar.kind === 'time' ? TIME_FILL : bar.low ? 'warning.light' : 'primary.main' }} />
          )}
        </Box>
      ))}
    </Box>
  );
}

export function PlanUsageButton({ ui, phone }) {
  const anchor = useRef(null);
  const { slice, usage, model } = useModel(ui);
  if (!model) return null;
  const open = Boolean(usage.open);
  const label = buttonLabel(model.agents, t);
  // Every agent left out (not signed in, not read): its mark alone, dimmed, so the details stay one click away.
  const groups = model.inBars.length ? model.inBars : model.agents.map(view => ({ ...view, marksOnly: true }));
  return (
    <>
      <ButtonBase id="h5-usage" ref={anchor} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? 'h5-usage-details' : undefined}
        data-offline={model.offline ? 'true' : undefined} data-engine={model.key} onClick={() => ui.actions.openPlanUsage()}
        sx={theme => ({
          // Phone: one 48px column, an agent per row (an agent left out leaves its row out, so one agent is one centred row).
          flex: '0 0 auto', height: phone ? 44 : 36, minWidth: 44, ...(phone ? { width: 48, px: 0, flexDirection: 'column', justifyContent: 'center', gap: '3px' } : { px: 1, gap: 1 }),
          borderRadius: 1, display: 'inline-flex', alignItems: 'center',
          bgcolor: phone ? 'transparent' : alpha('#fff', 0.06), opacity: model.offline ? 0.38 : 1,
          [TOUCH]: { minHeight: 44 },
          '@media (hover: hover)': { '&:hover': { bgcolor: alpha('#fff', phone ? 0.06 : 0.1) } },
          '&.Mui-focusVisible': { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
        })}>
        {groups.map(view => (
          <Box key={view.agent} component="span" className="h5-usage-agent" data-agent={view.agent} data-state={view.state}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: phone ? '3px' : '4px', opacity: view.marksOnly ? 0.6 : 1 }}>
            <Mark agent={view.agent} size={phone ? 10 : 14} />
            {view.marksOnly ? null : <Bars view={view} small={phone} />}
            {!phone && !view.marksOnly && view.lowText ? (
              <Typography className="h5-usage-low" component="span" sx={{ fontSize: 11, fontWeight: 500, lineHeight: 1, color: 'warning.light', whiteSpace: 'nowrap' }}>{view.lowText}</Typography>
            ) : null}
          </Box>
        ))}
      </ButtonBase>
      <PlanUsageDetails ui={ui} phone={phone} open={open} anchor={anchor} busy={Boolean(usage.refreshing)} touch={slice.input === 'touch'} />
    </>
  );
}

// A horizontal bar of the details (120 x 6).
const Line = ({ value, color, className }) => (
  <Box component="span" className={className} sx={{ position: 'relative', overflow: 'hidden', display: 'inline-block', flex: '0 0 auto', width: 120, height: 6, borderRadius: '3px', bgcolor: alpha('#fff', 0.12) }}>
    <Box component="span" sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.round(value * 100)}%`, bgcolor: color }} />
  </Box>
);

function DetailsContent({ model, busy, touch, onRefresh }) {
  return (
    <Box sx={{ pt: 2, pb: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, pb: 1 }}>
        <Typography id="h5-usage-title" variant="h6" component="h2" sx={{ flex: '1 1 auto' }}>{t('Plan usage')}</Typography>
        <Typography id="h5-usage-read" variant="caption" color={model.offline ? 'warning.light' : 'text.secondary'} noWrap translate="no" sx={{ minWidth: 0 }}>{t(model.header)}</Typography>
      </Box>
      <Box sx={{ opacity: model.offline ? 0.6 : 1 }}>
        {model.details.map(view => (
          <Box key={view.agent} className="h5-usage-detail" data-agent={view.agent} data-state={view.state} sx={{ px: 2, pt: 1, pb: 0.5 }}>
            <Typography variant="subtitle2" component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Mark agent={view.agent} size={16} />
              {view.name}
            </Typography>
            {view.message ? (
              <Typography className="h5-usage-message" variant="body2" color="text.secondary" sx={{ py: 1 }}>{t(view.message)}</Typography>
            ) : view.windows.map(win => (
              <Box key={win.id} className="h5-usage-row" data-window={win.id} data-passed={win.passed ? 'true' : undefined}
                sx={{ display: 'grid', gridTemplateColumns: '56px minmax(0, 1fr)', columnGap: 1.5, pt: 1, pb: 0.75 }}>
                <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 13, pt: '1px' }}>{t(win.label)}</Typography>
                <Box sx={{ minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Line className="h5-usage-plan" value={win.plan} color={win.low ? 'warning.light' : 'primary.main'} />
                    <Typography className="h5-usage-left" variant="body2" component="span" color={win.low ? 'warning.light' : 'text.primary'} sx={{ fontSize: 13, fontWeight: 500 }}>{t(`${win.left}% left`)}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
                    <Line className="h5-usage-time" value={win.time} color={TIME_FILL} />
                    <Typography className="h5-usage-reset" variant="body2" component="span" color="text.secondary" sx={{ fontSize: 13, minWidth: 0 }}>{t(win.resetText)}</Typography>
                  </Box>
                  {win.pace ? <Typography className="h5-usage-pace" variant="caption" component="div" color="warning.light" sx={{ mt: 0.5 }}>{t(win.pace)}</Typography> : null}
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <Divider sx={{ my: 0.5 }} />
      {model.others.length || model.olderNote ? (
        <Box id="h5-usage-others" sx={{ px: 2, py: 1 }}>
          {[model.olderNote, ...model.others].filter(Boolean).map(line => (
            <Typography key={line} className="h5-usage-other" variant="caption" component="div" color="text.secondary" sx={{ lineHeight: 1.5 }}>{t(line)}</Typography>
          ))}
        </Box>
      ) : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, px: 1 }}>
        {/* Not `disabled` while it runs: a disabled button drops the focus out of the popover, and Escape would no longer close it. */}
        <Button id="h5-usage-refresh" onClick={busy ? undefined : onRefresh} aria-disabled={busy ? 'true' : undefined} data-busy={busy ? 'true' : undefined} sx={touch ? { minHeight: 44 } : undefined}>{t(busy ? 'Refreshing…' : 'Refresh')}</Button>
      </Box>
    </Box>
  );
}

// The details: drawn only while open; the time texts move on every 30 s while they are shown.
function PlanUsageDetails({ ui, phone, open, anchor, busy, touch }) {
  const { model } = useModel(ui, open ? 30000 : 0);
  const close = () => ui.actions.closePlanUsage();
  if (!model) return null;
  const content = <DetailsContent model={model} busy={busy} touch={touch} onRefresh={() => ui.actions.refreshPlanUsage()} />;
  const paper = { id: 'h5-usage-details', className: 'h5-usage-details', role: 'dialog', 'aria-labelledby': 'h5-usage-title' };
  if (phone) {
    return (
      <Drawer anchor="bottom" open={open} onClose={close} ModalProps={{ disableScrollLock: true }}
        slotProps={{
          backdrop: { sx: { bgcolor: 'rgba(0, 0, 0, 0.32)' } },
          paper: { ...paper, 'data-layout': 'sheet', 'aria-modal': 'true', sx: { borderTopLeftRadius: 8, borderTopRightRadius: 8, maxHeight: '85vh', backgroundImage: overlay(16) } },
        }}>
        {content}
      </Drawer>
    );
  }
  return (
    <Popover open={open} onClose={close} anchorEl={anchor.current} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { ...paper, 'data-layout': 'popover', elevation: 8, sx: { width: 400, maxWidth: 'calc(100vw - 32px)', borderRadius: 1, mt: 0.5 } } }}>
      {content}
    </Popover>
  );
}
