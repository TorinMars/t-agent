// Topics on the clipboard ("Copy and paste" in docs/design/mind-maps.md). A copy puts three forms there at once: plain text (an outline indented with
// tabs, which XMind, MindNode, notes and chats read), an HTML list (documents, Notion, mail) and the exact topics for another T-Agent map (a type of
// our own). A paste reads the best form there is: our topics, then an HTML list, then text. What comes from the clipboard is untrusted: the topics
// found here still go through `sanitizeDoc` before the editor sees them.
import { parseHtmlList, parseOutline, toHtmlList, toOutlineText } from './formats.mjs';

export const CLIPBOARD_TYPE = 'application/x-t-agent-mindmap+json';
// Older pages put the exact topics into the plain text as JSON with this marker; such a copy still pastes exactly.
export const CLIPBOARD_MAGIC = 't-agent-mindmap-topics';
export const MAX_PASTED_TOPICS = 5000;

// `nodes`: the copied topics (each with its subtree). Returns { type: text }.
export function clipboardPayload(nodes) {
  return {
    'text/plain': toOutlineText(nodes),
    'text/html': `<meta charset="utf-8">${toHtmlList(nodes)}`,
    [CLIPBOARD_TYPE]: JSON.stringify({ magic: CLIPBOARD_MAGIC, data: nodes }),
  };
}

function exactTopics(text) {
  if (!text || !/^\s*\{/.test(text)) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return null; }
  return parsed && parsed.magic === CLIPBOARD_MAGIC && Array.isArray(parsed.data) && parsed.data.length ? parsed.data : null;
}

const count = nodes => nodes.reduce((sum, node) => sum + 1 + count(Array.isArray(node && node.children) ? node.children : []), 0);

// `custom`, `html`, `text`: what the clipboard holds of each form ('' when absent). `parseHtml(text)` returns a Document (DOMParser in the page).
// Returns { nodes, exact, topics } or null when there is nothing to paste. Throws the converters' errors (too many topics, too deep) and a
// FormatError-like Error when the paste is larger than MAX_PASTED_TOPICS.
export function topicsFromClipboard({ custom = '', html = '', text = '' } = {}, { parseHtml } = {}) {
  let found = null;
  const exact = exactTopics(custom) || exactTopics(text);
  if (exact) found = { nodes: exact, exact: true };
  if (!found && html && parseHtml && /<(ul|ol)[\s>]/i.test(html)) {
    const list = parseHtmlList(html, { parseHtml });
    if (list && list.nodes.length) found = { nodes: list.nodes, exact: false };
  }
  if (!found && text && text.trim()) {
    const outline = parseOutline(text);
    if (outline.nodes.length) found = { nodes: outline.nodes, exact: false };
  }
  if (!found) return null;
  const topics = count(found.nodes);
  if (topics > MAX_PASTED_TOPICS) throw new PasteError('Too many topics to paste at once');
  return { ...found, topics };
}

export class PasteError extends Error {}
