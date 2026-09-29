// Utility tools live beside Tasks; switching only toggles visibility so terminals stay connected.
const Tools = (() => {
  const SCRIPT_BASE_URL = 'https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts/';
  const commandFor = button => {
    const args = button.dataset.args;
    return `curl -fsSL ${SCRIPT_BASE_URL}${button.dataset.script} | bash${args ? ` -s -- ${args}` : ''}`;
  };
  const tabTasks = document.getElementById('tab-tasks');
  const tabTools = document.getElementById('tab-tools');
  const panel = document.getElementById('tools-panel');
  const timers = new WeakMap();

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
  document.querySelectorAll('.tool-copy-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const status = button.closest('.tool-card-actions').querySelector('.tool-copy-status');
      status.textContent = (await copy(commandFor(button))) ? '已复制' : '复制失败，请检查浏览器剪贴板权限';
      clearTimeout(timers.get(status)); timers.set(status, setTimeout(() => { status.textContent = ''; }, 2500));
    });
  });
  return { show, commandFor };
})();
