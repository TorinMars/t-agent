// Terminal-style log of an update: current progress on top, the output of the update commands scrolling below. All text is written with textContent.
const UpdateLog = (() => {
  const pad = value => String(value).padStart(2, '0');
  const timeOf = at => { const date = new Date(at); return Number.isNaN(date.getTime()) ? '' : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; };

  // Progress area + log area. The message / error ids reuse each dialog's existing element ids; the log area id is `${message}-log`.
  function markup(messageId, errorId, text = 'Starting the update…') {
    return `<div class="update-progress"><span class="update-spinner"></span><span id="${messageId}">${text}</span></div>`
      + `<pre class="update-log" id="${messageId}-log" aria-label="Update log" aria-live="off"></pre>`
      + `<div class="form-hint" id="${errorId}"></div>`;
  }

  // Refresh the terminal area with the latest log; if the user scrolled up to read history, do not force it to the bottom.
  function render(node, lines) {
    if (!node || !Array.isArray(lines)) return;
    const key = `${lines.length}:${lines.length ? lines[lines.length - 1].at + lines[lines.length - 1].text : ''}`;
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    const stuck = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    node.textContent = lines.map(line => `${timeOf(line.at)} ${line.text}`).join('\n');
    if (stuck) node.scrollTop = node.scrollHeight;
  }

  // The top progress line only keeps "stage · elapsed time"; the latest output line is already in the log.
  const headline = message => String(message || '').split(' · ').slice(0, 2).join(' · ');

  return { markup, render, headline };
})();
