import { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';

export const t = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);

// The requests of the phone page: same-origin, with the header the Client wants, and the server's own error code as the message.
export async function api(method, url, body) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain-text error */ }
  if (!res.ok) {
    const error = new Error((data && data.error) || text || `HTTP ${res.status}`);
    error.data = data;
    error.status = res.status;
    throw error;
  }
  return data;
}

// The text of a failed request for the person: the server's English `message` (translated by the server dictionary) when it sent one, else the
// error code that `api` put into `error.message`.
export const errorText = error => t((error && error.data && typeof error.data.message === 'string' && error.data.message) || (error && error.message) || '');

// An icon that agent-chat.js draws as a DOM node (the agent's mark, the chat bubble): put into the React tree and left alone.
export function DomIcon({ make }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || typeof AgentChat === 'undefined') return;
    ref.current.replaceChildren(make(AgentChat));
  }, [make]);
  return <span ref={ref} style={{ display: 'contents' }} />;
}
export const terminalMark = agent => AgentChat => AgentChat.icon(agent);

// The name of a device (an entry of `state.sources` or a section of the task list) for the person. A remote one has its own name (`label`). This machine
// has its engine name (`name`, from `GET /api/system/version` `engine_name`) followed by a small "This machine" hint; an older server has no name, and then the
// hint is the whole name, as before.
export function deviceParts(source) {
  if (!source || !(source.local || source.key === 'local')) return { name: (source && source.label) || '', hint: '' };
  return source.name ? { name: source.name, hint: t('This machine') } : { name: t('This machine'), hint: '' };
}
export const deviceText = source => { const parts = deviceParts(source); return parts.hint ? `${parts.name} · ${parts.hint}` : parts.name; };
// The same in a line: the name is cut with an ellipsis when space is short (the full text is its `title`), the hint always stays.
export function DeviceName({ source, className, hintClassName }) {
  const parts = deviceParts(source);
  return (
    <>
      <Box component="span" className={className} translate="no" title={deviceText(source)} sx={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{parts.name}</Box>
      {parts.hint ? <Box component="span" className={hintClassName} sx={{ flex: '0 0 auto', whiteSpace: 'nowrap', fontWeight: 400, opacity: 0.8 }}>{`· ${parts.hint}`}</Box> : null}
    </>
  );
}

// The name props of an icon button: the aria-label and the same native title (the browser's own tooltip on a computer; no MUI Tooltip, which
// would add about 31 KB and on a touch screen open on a long press, in the way of hold-to-talk).
export const named = label => ({ 'aria-label': label, title: label });

// A small rounded label (what MUI's Chip drew here, without its 8 KB): `onClick` makes it a button (ButtonBase: ripple, focus ring).
// `tone` is a palette colour ('primary', 'success', 'error', ...) or 'default'; `filled` fills it with that colour, else it is outlined.
export function Pill({ label, tone = 'default', filled = false, onClick, sx, ...props }) {
  const color = tone === 'default' ? 'text.primary' : `${tone}.main`;
  const look = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', height: 24, px: 1.25, borderRadius: 12,
    fontSize: 13, lineHeight: 1, whiteSpace: 'nowrap', border: 1, verticalAlign: 'middle', fontFamily: 'inherit',
    ...(filled
      ? { bgcolor: tone === 'default' ? 'action.selected' : `${tone}.main`, color: tone === 'default' ? 'text.primary' : `${tone}.contrastText`, borderColor: 'transparent' }
      : { bgcolor: 'transparent', color, borderColor: tone === 'default' ? 'divider' : color }),
    ...sx,
  };
  if (!onClick) return <Box component="span" sx={look} {...props}>{label}</Box>;
  return <ButtonBase onClick={onClick} sx={{ ...look, '&:hover': { filter: 'brightness(1.15)' }, '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 } }} {...props}>{label}</ButtonBase>;
}
