// The replay page of a recording made with --frames (`tcli browser record export <id> --html file`; "Pictures of a recording" in
// docs/design/browser-extension.md): one self-contained HTML file, the pictures embedded as data: URLs, the action and its time under each,
// Previous / Next buttons and the arrow keys. It makes no request at all: a Content-Security-Policy allows only data: images and the inline
// style and script, and nothing in it names another address except as text. Used by scripts/tcli-browser-records.js. Node built-ins only.

const escapeHtml = value => String(value === undefined || value === null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const flat = (value, max = 120) => {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// The words for a target: `button "Save"`, `input "Search"`, else its selector.
function targetText(target) {
  if (!target || typeof target !== 'object') return '';
  const near = target.nearest && typeof target.nearest === 'object' ? target.nearest : null;
  const kind = target.role || target.tag || (near && (near.role || near.tag)) || 'element';
  const name = flat(target.name || target.text || (near && (near.name || near.text)) || '', 60);
  if (name) return `${kind} "${name}"`;
  return target.selector ? `${kind} ${flat(target.selector, 60)}` : kind;
}

// One line for an action item (the item a picture follows).
function describeItem(item) {
  if (!item || typeof item !== 'object') return 'Picture';
  const who = item.source === 'agent' ? 'Agent' : item.source === 'user' ? 'Person' : '';
  const on = targetText(item.target);
  let what;
  switch (item.kind) {
    case 'click': what = `${item.count === 2 ? 'double-clicked' : item.button && item.button !== 'left' ? `${item.button}-clicked` : 'clicked'} ${on}`; break;
    case 'input': what = `typed ${typeof item.value === 'string' ? `"${flat(item.value, 60)}"` : 'text'}${on ? ` into ${on}` : ''}${item.submit ? ' and submitted' : ''}`; break;
    case 'change': what = `chose ${Array.isArray(item.values) ? item.values.map(value => `"${flat(value, 30)}"`).join(', ') : 'a value'}${on ? ` in ${on}` : ''}`; break;
    case 'submit': what = `submitted ${on || 'a form'}`; break;
    case 'key': what = `pressed ${[...(Array.isArray(item.modifiers) ? item.modifiers : []), item.key || 'a key'].join('+')}`; break;
    case 'hover': what = `pointed at ${on}`; break;
    case 'scroll': what = `scrolled${on ? ` ${on}` : ''} by ${item.dy ?? 0}`; break;
    case 'nav': what = `${item.action ? `${item.action}: ` : ''}went to ${flat(item.to || item.url, 200)}`; break;
    default: what = item.kind ? String(item.kind) : 'step';
  }
  const text = `${who ? `${who} ` : ''}${what}`.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SKIPPED = {
  mask: 'not taken: a part that must be hidden could not be checked',
  limit: 'not taken: the recording reached its picture limit',
  debugger: 'not taken: the debugger was not attached to this tab',
  timeout: 'not taken: the tab drew no picture in time',
  error: 'not taken: the picture failed',
};

// steps: [{ item (the frame item), action (the item it follows, or null), image (a Buffer of the JPEG, or null) }] in order.
function buildReplayHtml({ recordingId, startedAt = null, steps = [] }) {
  const start = Date.parse(startedAt) || (steps[0] && Number(steps[0].item.at)) || 0;
  const figures = steps.map((step, index) => {
    const at = Number(step.action && Number.isFinite(step.action.at) ? step.action.at : step.item.at);
    const when = Number.isFinite(at) && at > 0 ? new Date(at) : null;
    const offset = when && start ? `+${((at - start) / 1000).toFixed(1)} s` : '';
    const text = describeItem(step.action);
    const picture = step.image
      ? `<img src="data:image/jpeg;base64,${step.image.toString('base64')}" alt="${escapeHtml(`Step ${index + 1}: ${text}`)}"${step.item.width ? ` width="${Number(step.item.width) | 0}" height="${Number(step.item.height) | 0}"` : ''}>`
      : `<div class="none">No picture (${escapeHtml(SKIPPED[step.item.skipped] || flat(step.item.skipped || 'not stored', 80))})</div>`;
    const tab = Number.isInteger(step.item.tab) ? ` · tab ${step.item.tab}` : '';
    return `<figure class="step${index === 0 ? ' on' : ''}" id="step-${index + 1}">${picture}<figcaption><span class="n">${index + 1} / ${steps.length}</span> <span class="text">${escapeHtml(text)}</span><br><time datetime="${when ? when.toISOString() : ''}">${escapeHtml(offset)}${when ? ` · ${escapeHtml(when.toISOString().replace('T', ' ').slice(0, 19))} UTC` : ''}</time>${escapeHtml(tab)}${step.action && (step.action.url || step.item.url) ? `<br><span class="url">${escapeHtml(flat(step.action.url || step.item.url, 200))}</span>` : ''}</figcaption></figure>`;
  });
  const empty = steps.length ? '' : '<p class="none">This recording has no pictures. Record with: tcli browser record start --frames (or open --record --frames).</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>Replay ${escapeHtml(recordingId)}</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #212121; --muted: #616161; --line: #e0e0e0; --accent: #1565c0; }
@media (prefers-color-scheme: dark) { :root { --bg: #121212; --fg: #e0e0e0; --muted: #9e9e9e; --line: #333; --accent: #90caf9; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
h1 { font-size: 20px; font-weight: 500; margin: 0 0 4px; }
.meta { color: var(--muted); margin: 0 0 16px; }
.step { display: none; margin: 0; }
.step.on { display: block; }
.step img { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
.none { padding: 32px 16px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }
figcaption { margin-top: 8px; }
.n { color: var(--accent); font-weight: 500; }
time, .url { color: var(--muted); }
.url { word-break: break-all; }
nav { display: flex; gap: 8px; align-items: center; margin: 16px 0 0; }
button { font: inherit; padding: 8px 16px; min-height: 44px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--accent); cursor: pointer; }
button:disabled { color: var(--muted); cursor: default; }
@media print { .step { display: block; page-break-inside: avoid; margin-bottom: 24px; } nav { display: none; } }
</style>
</head>
<body>
<h1>Recording ${escapeHtml(recordingId)}</h1>
<p class="meta">${steps.length} steps${startedAt ? ` · started ${escapeHtml(String(startedAt).replace('T', ' ').slice(0, 19))} UTC` : ''} · Left and right arrow keys move between them. Secret fields were masked before each picture was taken.</p>
<main>${empty}${figures.join('\n')}</main>
<nav><button id="prev" type="button" aria-label="Previous step" title="Previous step">Previous</button><button id="next" type="button" aria-label="Next step" title="Next step">Next</button></nav>
<script>
(function () {
  var steps = document.querySelectorAll('.step'), i = 0, prev = document.getElementById('prev'), next = document.getElementById('next');
  function show(n) {
    if (!steps.length) { prev.disabled = next.disabled = true; return; }
    i = Math.max(0, Math.min(steps.length - 1, n));
    for (var k = 0; k < steps.length; k++) steps[k].className = k === i ? 'step on' : 'step';
    prev.disabled = i === 0; next.disabled = i === steps.length - 1;
  }
  prev.onclick = function () { show(i - 1); };
  next.onclick = function () { show(i + 1); };
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { show(i - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { show(i + 1); e.preventDefault(); }
    if (e.key === 'Home') show(0);
    if (e.key === 'End') show(steps.length - 1);
  });
  show(0);
})();
</script>
</body>
</html>
`;
}

module.exports = { buildReplayHtml, describeItem, escapeHtml };
