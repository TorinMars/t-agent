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
  // The mark of each agent: Claude's sparkle is a text glyph, Codex uses the OpenAI logo (Simple Icons, CC0), drawn in the current text color.
  const OPENAI_LOGO = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';
  function icon(agent) {
    if (agent !== 'codex') return document.createTextNode('\u2733');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'agent-logo');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', OPENAI_LOGO);
    svg.append(path);
    return svg;
  }

  // The mark of a chat in a list of terminals and chats: the agent's mark with a small speech bubble, so it differs from a terminal that runs
  // the same agent (which shows the plain mark).
  const BUBBLE = 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z';
  function chatIcon(agent) {
    const mark = document.createElement('span');
    mark.className = 'agent-chat-mark';
    mark.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'agent-chat-bubble');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', BUBBLE);
    svg.append(path);
    mark.append(icon(agent), svg);
    return mark;
  }

  // The choices for "open a chat": the conversations of the task, then sessions of the agent CLI in the task directory that have no conversation yet.
  async function choices(api, base, agent) {
    const [conversations, sessions] = await Promise.all([
      api.get(`${base}/conversations`).catch(() => []),
      api.get(`${base}/sessions?agent=${encodeURIComponent(agent)}`).catch(() => []),
    ]);
    const mine = (Array.isArray(conversations) ? conversations : []).filter(row => row.agent === agent).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))); // the latest first (updated_at is 'YYYY-MM-DD HH:MM:SS')
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

  return { mount, choices, open, icon, chatIcon, AGENTS };
})();
