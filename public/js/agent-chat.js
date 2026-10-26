// Chat-style view of a Claude Code / Codex conversation (instead of a terminal). Shared by the desktop page and the phone page.
// This file is small and loaded with every page; the view itself (React + assistant-ui, source in scripts/agent-chat/) is the bundle
// agent-chat-ui.js, fetched when the first chat is mounted.
//
//   const chat = AgentChat.mount(element, { api, base, conversation, onClose });
//   api:  { get(url), post(url, body), patch(url, body), del(url) }, each returning the parsed JSON (the host adds its own auth headers)
//   base: `<tasks base>/<task id>/agent`
// The view loads a snapshot of the conversation, then follows the server-sent events after the snapshot's sequence number. Everything the
// agent or the person wrote is rendered by React as text (markdown goes through react-markdown, which does not pass raw HTML).
const AgentChat = (() => {
  const AGENTS = {
    claude: {
      label: 'Claude',
      modes: [['ask', 'Ask before changes'], ['edits', 'Accept edits'], ['plan', 'Plan only'], ['full', 'Full access (no prompts)']],
    },
    codex: {
      label: 'Codex',
      modes: [['readonly', 'Read-only'], ['write', 'Workspace write'], ['full', 'Full access']],
    },
  };
  // The choices for "open a chat": the conversations of the task, then sessions of the agent CLI in the task directory that have no conversation yet.
  async function choices(api, base, agent) {
    const [conversations, sessions] = await Promise.all([
      api.get(`${base}/conversations`).catch(() => []),
      api.get(`${base}/sessions?agent=${encodeURIComponent(agent)}`).catch(() => []),
    ]);
    const mine = (Array.isArray(conversations) ? conversations : []).filter(row => row.agent === agent);
    const taken = new Set(mine.map(row => row.session_id).filter(Boolean));
    return [
      ...mine.map(row => ({ title: row.title, running: row.running, conversation: row })),
      ...(Array.isArray(sessions) ? sessions : []).filter(row => !taken.has(row.id)).map(row => ({ title: row.title, session_id: row.id })),
    ];
  }

  // A choice from `choices()` (or a new chat) as a conversation row, creating it on the server when needed.
  async function open(api, base, agent, choice) {
    if (choice && choice.conversation) return choice.conversation;
    return api.post(`${base}/conversations`, { agent, ...(choice && choice.session_id ? { session_id: choice.session_id, title: choice.title } : {}) });
  }

  // The bundle sits next to this script (same ?v= release query, so it is cached like the other scripts).
  const BUNDLE_URL = (() => {
    const script = document.currentScript;
    return script && script.src ? script.src.replace(/agent-chat\.js/, 'agent-chat-ui.js') : '/js/agent-chat-ui.js';
  })();
  let bundle = null;
  function loadBundle() {
    if (typeof AgentChatUI !== 'undefined') return Promise.resolve(AgentChatUI);
    if (!bundle) {
      bundle = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = BUNDLE_URL;
        script.onload = () => resolve(AgentChatUI);
        script.onerror = () => { bundle = null; reject(new Error('The chat view could not be loaded')); };
        document.head.append(script);
      });
    }
    return bundle;
  }

  // Returns at once; the view appears when the bundle has loaded. focus() and destroy() work before that too.
  function mount(container, options) {
    let view = null;
    let disposed = false;
    let wantFocus = false;
    const notify = options.notify || (() => {});
    loadBundle().then(ui => {
      if (disposed) return;
      view = ui.mount(container, { ...options, agent: AGENTS[options.conversation.agent] || AGENTS.claude });
      if (wantFocus) view.focus();
    }).catch(error => { if (!disposed) notify(error.message); });
    return {
      focus() { wantFocus = true; if (view) view.focus(); },
      destroy() { disposed = true; if (view) view.destroy(); view = null; },
    };
  }

  return { mount, choices, open, AGENTS };
})();
