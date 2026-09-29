// Utility tools live beside Tasks; switching only toggles visibility so terminals stay connected.
const Tools = (() => {
  const CLAUDE_INSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
curl -fsSL https://claude.ai/install.sh | bash
claude --version
`;
  const tabTasks = document.getElementById('tab-tasks');
  const tabTools = document.getElementById('tab-tools');
  const panel = document.getElementById('tools-panel');
  const copyButton = document.getElementById('btn-copy-claude-install');
  const status = document.getElementById('tool-copy-status');
  let timer;

  function show(tools) {
    document.body.classList.toggle('tools-open', tools);
    panel.hidden = !tools;
    tabTasks.classList.toggle('active', !tools); tabTasks.setAttribute('aria-pressed', String(!tools));
    tabTools.classList.toggle('active', tools); tabTools.setAttribute('aria-pressed', String(tools));
    if (!tools) window.dispatchEvent(new Event('resize'));
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const area = document.createElement('textarea');
    area.value = text; area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area); area.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
  }
  tabTasks.addEventListener('click', () => show(false));
  tabTools.addEventListener('click', () => show(true));
  copyButton.addEventListener('click', async () => {
    status.textContent = (await copy(CLAUDE_INSTALL_SCRIPT)) ? '已复制' : '复制失败，请检查浏览器剪贴板权限';
    clearTimeout(timer); timer = setTimeout(() => { status.textContent = ''; }, 2500);
  });
  return { show, script: CLAUDE_INSTALL_SCRIPT };
})();
