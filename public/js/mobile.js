(() => {
  const body = document.body;
  const media = window.matchMedia('(max-width: 768px)');
  const listButton = document.getElementById('mobile-show-tasks');
  const detailsButton = document.getElementById('mobile-show-details');
  let ready = false;
  function setView(view) {
    body.dataset.mobileView = view;
    listButton.setAttribute('aria-pressed', String(view === 'tasks'));
    detailsButton.setAttribute('aria-pressed', String(view === 'details'));
    window.dispatchEvent(new Event('resize'));
  }
  window.ClientMobile = {
    showDetails(title) {
      document.getElementById('mobile-task-title').textContent = title;
      if (ready && body.classList.contains('mobile-client')) setView('details');
    },
    finishStartup() { ready = true; },
    createDocumentEditor(host, source) {
      const input = document.createElement('textarea');
      input.className = 'mobile-document-editor';
      input.setAttribute('aria-label', 'Markdown 文档内容');
      input.spellcheck = false;
      input.autocapitalize = 'off';
      input.value = source;
      host.appendChild(input);
      return {
        model: { getValue: () => input.value, dispose() {} },
        editor: {
          focus: () => input.focus(), dispose: () => input.remove(), addCommand() {},
          onDidChangeModelContent: listener => input.addEventListener('input', listener),
        },
      };
    },
  };
  function updateMode() {
    const mobile = body.classList.contains('h5-client') || (location.pathname !== '/web' && media.matches);
    body.classList.toggle('mobile-client', mobile);
    const link = document.getElementById('btn-client-mode');
    link.href = mobile ? '/web' : '/h5'; link.textContent = mobile ? '电脑版' : '手机版';
    if (!body.dataset.mobileView) setView('tasks');
  }
  updateMode();
  media.addEventListener('change', updateMode);
  listButton.addEventListener('click', () => setView('tasks'));
  detailsButton.addEventListener('click', () => setView('details'));

  function addMoreControls() {
    document.querySelectorAll('.task-nav-item, .task-group-header[data-mobile-menu="true"], .engine-tab[data-engine-key]:not([data-engine-key="local"])').forEach(element => {
      if (element.querySelector('.mobile-more')) return;
      // Engine tabs are already buttons; a keyboard-operable span avoids nesting buttons.
      const control = document.createElement(element.tagName === 'BUTTON' ? 'span' : 'button');
      if (control.tagName === 'BUTTON') control.type = 'button';
      else { control.setAttribute('role', 'button'); control.tabIndex = 0; }
      control.className = 'mobile-more';
      control.textContent = '⋯';
      control.setAttribute('aria-label', '更多操作');
      function open(event) {
        event.preventDefault(); event.stopPropagation();
        const rect = control.getBoundingClientRect();
        element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.min(rect.left, innerWidth - 170), clientY: rect.bottom }));
      }
      control.addEventListener('click', open);
      control.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) open(event); });
      element.appendChild(control);
    });
  }
  const observer = new MutationObserver(addMoreControls);
  ['task-nav', 'engine-tabs'].forEach(id => observer.observe(document.getElementById(id), { childList: true, subtree: true }));
  addMoreControls();

  const keys = { escape: '\x1b', tab: '\t', interrupt: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
  document.querySelectorAll('[data-terminal-key]').forEach(button => {
    button.addEventListener('click', () => {
      const controller = window.RemoteTasks && RemoteTasks.isSelected() ? RemoteTasks : window.Tasks;
      if (controller && controller.sendTerminalInput) controller.sendTerminalInput(keys[button.dataset.terminalKey]);
    });
  });
})();
