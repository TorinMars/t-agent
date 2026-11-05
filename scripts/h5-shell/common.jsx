import { useEffect, useRef } from 'react';
import Tooltip from '@mui/material/Tooltip';

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
    throw error;
  }
  return data;
}

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
export const chatMark = agent => AgentChat => AgentChat.chatIcon(agent);

// Icon buttons on a computer (input mode 'pointer') get a Material UI tooltip; on a touch screen they keep only the native title (a tooltip there would
// open on a long press and get in the way of hold-to-talk and the press handling). `describeChild` keeps the button's own aria-label as its name, and
// MUI gives the button its `title` back whenever the tooltip is closed, so the title never shows twice.
export function Tip({ on, title, children }) {
  return on ? <Tooltip title={title} describeChild>{children}</Tooltip> : children;
}
// The name props of an icon button: always the aria-label; the title only where no MUI tooltip supplies it.
export const named = (label, tip) => (tip ? { 'aria-label': label } : { 'aria-label': label, title: label });
