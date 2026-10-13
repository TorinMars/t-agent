// 更新过程的终端式日志：弹窗上方是当前进度，下方滚动显示更新命令的输出。所有文本都用 textContent 写入。
const UpdateLog = (() => {
  const pad = value => String(value).padStart(2, '0');
  const timeOf = at => { const date = new Date(at); return Number.isNaN(date.getTime()) ? '' : `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`; };

  // 进度区 + 日志区。ids 里的 message / error 沿用各弹窗原有的元素 id，日志区 id 为 `${message}-log`。
  function markup(messageId, errorId, text = '正在启动更新流程…') {
    return `<div class="update-progress"><span class="update-spinner"></span><span id="${messageId}">${text}</span></div>`
      + `<pre class="update-log" id="${messageId}-log" aria-label="更新日志" aria-live="off"></pre>`
      + `<div class="form-hint" id="${errorId}"></div>`;
  }

  // 用最新日志刷新终端区；用户向上滚动查看历史时不强行拉到底部。
  function render(node, lines) {
    if (!node || !Array.isArray(lines)) return;
    const key = `${lines.length}:${lines.length ? lines[lines.length - 1].at + lines[lines.length - 1].text : ''}`;
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    const stuck = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    node.textContent = lines.map(line => `${timeOf(line.at)} ${line.text}`).join('\n');
    if (stuck) node.scrollTop = node.scrollHeight;
  }

  // 顶部进度行只保留“阶段 · 已用时间”，最近一行输出已经在日志里。
  const headline = message => String(message || '').split(' · ').slice(0, 2).join(' · ');

  return { markup, render, headline };
})();
