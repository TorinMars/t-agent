// Chat-style view of a Claude Code / Codex conversation (instead of a terminal). Shared by the desktop page and the phone page.
//
//   const chat = AgentChat.mount(element, { api, base, conversation, onClose });
//   api:  { get(url), post(url, body), patch(url, body), del(url) }, each returning the parsed JSON (the host adds its own auth headers)
//   base: `<tasks base>/<task id>/agent`
// The view loads a snapshot of the conversation, then follows the server-sent events after the snapshot's sequence number. Everything the
// agent or the person wrote is put into the page with textContent / DOM nodes, never as HTML.
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
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_FILE_CHARS = 200 * 1024;
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const t = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
  const coarse = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ── Markdown (a small, safe subset: code blocks, headings, lists, quotes, inline code / bold / italic / links) ──
  function inline(parent, text) {
    const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) parent.append(text.slice(last, match.index));
      const token = match[0];
      if (match[1]) parent.append(el('code', '', token.slice(1, -1)));
      else if (match[2]) parent.append(el('strong', '', token.slice(2, -2)));
      else if (match[3]) parent.append(el('em', '', token.slice(1, -1)));
      else {
        const split = token.lastIndexOf('](');
        const link = el('a', '', token.slice(1, split));
        link.href = token.slice(split + 2, -1);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      }
      last = match.index + token.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function markdown(parent, source) {
    const lines = source.replace(/\r/g, '').split('\n');
    let paragraph = [];
    let list = null;
    const flush = () => {
      if (paragraph.length) { const p = el('p'); inline(p, paragraph.join('\n')); parent.append(p); paragraph = []; }
      list = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*```(\S*)\s*$/.exec(line);
      if (fence) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
        const pre = el('pre');
        pre.append(el('code', '', code.join('\n')));
        parent.append(pre);
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
      const quote = /^>\s?(.*)$/.exec(line);
      if (heading) { flush(); const h = el('h4'); inline(h, heading[2]); parent.append(h); }
      else if (item) {
        const ordered = /^\s*\d+\./.test(line);
        if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { flush(); list = el(ordered ? 'ol' : 'ul'); parent.append(list); }
        const li = el('li');
        inline(li, item[1]);
        list.append(li);
      } else if (quote) { flush(); const q = el('blockquote'); inline(q, quote[1]); parent.append(q); }
      else if (!line.trim()) flush();
      else { list = null; paragraph.push(line); }
    }
    flush();
  }

  // ── Tool cards ──
  function toolSummary(item) {
    const input = item.input || {};
    const value = input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description || '';
    return typeof value === 'string' ? value.split('\n')[0] : '';
  }
  const prettyInput = input => {
    if (!input || typeof input !== 'object') return String(input || '');
    if (typeof input.command === 'string' && Object.keys(input).length <= 2) return input.command;
    try { return JSON.stringify(input, null, 2); } catch { return ''; }
  };

  function renderItem(item) {
    let node;
    if (item.kind === 'user') {
      node = el('div', 'ac-item ac-user');
      const bubble = el('div', 'ac-bubble');
      bubble.translate = false;
      bubble.textContent = item.text || '';
      node.append(bubble);
      if (item.attachments && item.attachments.length) {
        const chips = el('div', 'ac-chips');
        for (const name of item.attachments) chips.append(el('span', 'ac-chip', name));
        node.append(chips);
      }
    } else if (item.kind === 'text') {
      node = el('div', 'ac-item ac-text');
      node.translate = false;
      markdown(node, item.text || '');
    } else if (item.kind === 'thinking') {
      node = el('details', 'ac-item ac-thinking');
      node.append(el('summary', '', 'Thinking'));
      const body = el('div', 'ac-thinking-body', item.text || '');
      body.translate = false;
      node.append(body);
      node.hidden = !item.text; // a block that streamed nothing (the model kept its reasoning private) is not shown
    } else if (item.kind === 'tool') {
      node = el('details', `ac-item ac-tool ${item.status || ''}`);
      const summary = el('summary');
      summary.append(el('span', 'ac-dot'), el('span', 'ac-tool-name', item.name || 'Tool'));
      const brief = el('span', 'ac-tool-brief', toolSummary(item));
      brief.translate = false;
      summary.append(brief);
      node.append(summary);
      const input = prettyInput(item.input);
      if (input) { const pre = el('pre', 'ac-tool-input'); pre.translate = false; pre.textContent = input; node.append(pre); }
      if (item.output) { const pre = el('pre', 'ac-tool-output'); pre.translate = false; pre.textContent = item.output; node.append(pre); }
    } else {
      node = el('div', `ac-item ${item.kind === 'error' ? 'ac-error' : 'ac-notice'}`);
      const body = el('span', '', item.text || '');
      body.translate = false;
      node.append(body);
    }
    node.dataset.id = item.id;
    return node;
  }

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

  function mount(container, { api, base, conversation, onClose, notify = () => {} }) {
    const agent = AGENTS[conversation.agent] || AGENTS.claude;
    const items = new Map();
    let seq = 0;
    let status = 'idle';
    let source = null;
    let retry = null;
    let disposed = false;
    let attachments = [];
    let canSteer = false; // the agent takes input while it works (Codex): Send stays available during a turn

    const root = el('section', 'agent-chat');
    root.setAttribute('aria-label', `${agent.label} chat`);
    const head = el('header', 'ac-head');
    const back = el('button', 'ac-back', '←');
    back.type = 'button';
    back.setAttribute('aria-label', 'Close chat');
    const badge = el('span', `ac-badge ${conversation.agent}`, conversation.agent === 'codex' ? '◎' : '✳');
    badge.setAttribute('aria-hidden', 'true');
    const title = el('span', 'ac-title');
    title.translate = false;
    title.textContent = conversation.title;
    const modeSelect = el('select', 'ac-mode');
    modeSelect.setAttribute('aria-label', 'Access level');
    for (const [value, label] of agent.modes) {
      const option = el('option', '', label);
      option.value = value;
      modeSelect.append(option);
    }
    modeSelect.value = conversation.mode;
    head.append(back, badge, title, modeSelect);

    const messages = el('div', 'ac-messages');
    messages.setAttribute('role', 'log');
    messages.setAttribute('aria-live', 'polite');
    const list = el('div', 'ac-list');
    const requests = el('div', 'ac-requests');
    const working = el('div', 'ac-working', 'Working…');
    working.hidden = true;
    messages.append(list, requests, working);

    const form = el('form', 'ac-composer');
    form.autocomplete = 'off';
    const chips = el('div', 'ac-attachments');
    chips.hidden = true;
    const row = el('div', 'ac-row');
    const attach = el('button', 'ac-attach', '＋');
    attach.type = 'button';
    attach.setAttribute('aria-label', 'Attach an image or text file');
    const picker = el('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = `${IMAGE_TYPES.join(',')},text/*,.md,.json,.js,.ts,.py,.log,.csv,.yml,.yaml,.sh`;
    picker.hidden = true;
    const input = el('textarea', 'ac-input');
    input.rows = 1;
    input.maxLength = 100000;
    input.placeholder = `Message ${agent.label}`;
    input.setAttribute('aria-label', `Message ${agent.label}`);
    input.enterKeyHint = 'send';
    const send = el('button', 'ac-send', 'Send');
    send.type = 'submit';
    const stop = el('button', 'ac-stop', 'Stop');
    stop.type = 'button';
    stop.hidden = true;
    row.append(attach, input, send, stop);
    form.append(chips, row, picker);
    root.append(head, messages, form);
    container.replaceChildren(root);

    const nearBottom = () => messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    const toBottom = () => { messages.scrollTop = messages.scrollHeight; };
    const keepBottom = change => { const stick = nearBottom(); change(); if (stick) toBottom(); };

    function setStatus(next) {
      status = next;
      const running = next === 'running';
      working.hidden = !running;
      send.hidden = running && !canSteer;
      stop.hidden = !running;
      input.readOnly = false;
      input.placeholder = running && canSteer ? `Add to what ${agent.label} is doing` : `Message ${agent.label}`;
    }

    function upsert(item) {
      keepBottom(() => {
        const old = items.get(item.id);
        const node = renderItem(item);
        // An expanded tool card or thinking block stays expanded when its content updates.
        if (old && old.node.open) node.open = true;
        if (old) old.node.replaceWith(node); else list.append(node);
        items.set(item.id, { item, node });
      });
    }
    function append(id, text) {
      const entry = items.get(id);
      if (!entry) return;
      entry.item.text = (entry.item.text || '') + text;
      keepBottom(() => {
        const node = renderItem(entry.item);
        if (entry.node.open) node.open = true;
        entry.node.replaceWith(node);
        entry.node = node;
      });
    }

    function permission(request) {
      if (requests.querySelector(`[data-id="${CSS.escape(request.id)}"]`)) return;
      const card = el('div', 'ac-request');
      card.dataset.id = request.id;
      card.append(el('div', 'ac-request-title', request.title || `Allow ${request.tool}?`));
      const answer = el('div', 'ac-request-actions');
      const buttons = [];
      const reply = body => async () => {
        buttons.forEach(button => { button.disabled = true; });
        try { await api.post(`${base}/conversations/${conversation.id}/permissions/${request.id}`, body()); }
        catch (error) { buttons.forEach(button => { button.disabled = false; }); notify(`Could not answer: ${error.message}`); }
      };
      const action = (className, label, body) => {
        const button = el('button', className, label);
        button.type = 'button';
        button.addEventListener('click', reply(body));
        buttons.push(button);
        answer.append(button);
      };
      if (request.kind === 'question' && request.questions && request.questions.length) {
        const fields = request.questions.map(question => {
          const box = el('label', 'ac-question');
          box.append(el('span', 'ac-question-text', question.question || question.header));
          let control;
          if (question.options && question.options.length) {
            control = el('select', 'ac-question-input');
            for (const option of question.options) {
              const node = el('option', '', option.label);
              node.value = option.label;
              if (option.description) node.title = option.description;
              control.append(node);
            }
            if (question.isOther) {
              const other = el('option', '', 'Other…');
              other.value = '';
              control.append(other);
            }
          } else {
            control = el('input', 'ac-question-input');
            control.type = question.isSecret ? 'password' : 'text';
          }
          control.translate = false;
          box.append(control);
          return [question, box, control];
        });
        // Choosing "Other…" turns the choice into a text answer.
        const typed = fields.map(([question, box, control]) => {
          if (control.tagName !== 'SELECT' || !question.isOther) return null;
          const text = el('input', 'ac-question-input');
          text.hidden = true;
          text.placeholder = 'Your answer';
          text.translate = false;
          control.addEventListener('change', () => { text.hidden = control.value !== ''; if (!text.hidden) text.focus(); });
          box.append(text);
          return text;
        });
        card.append(...fields.map(([, box]) => box));
        action('ac-allow', 'Submit', () => ({
          allow: true,
          answers: Object.fromEntries(fields.map(([question, , control], index) => [question.id, typed[index] && control.value === '' ? typed[index].value : control.value])),
        }));
        action('ac-deny', 'Skip', () => ({ allow: false }));
      } else {
        const detail = el('pre', 'ac-request-detail');
        detail.translate = false;
        detail.textContent = request.description || prettyInput(request.input);
        card.append(detail);
        action('ac-allow', 'Allow', () => ({ allow: true }));
        if (request.canRemember) action('ac-allow ac-remember', 'Allow for this session', () => ({ allow: true, remember: true }));
        action('ac-deny', 'Deny', () => ({ allow: false }));
      }
      card.append(answer);
      keepBottom(() => requests.append(card));
    }

    function apply(event) {
      if (event.seq <= seq) return;
      seq = event.seq;
      switch (event.op) {
        case 'upsert': upsert(event.item); break;
        case 'append': append(event.id, event.text); break;
        case 'status': setStatus(event.status); break;
        case 'permission': permission(event.request); break;
        case 'permission_done': { const card = requests.querySelector(`[data-id="${CSS.escape(event.id)}"]`); if (card) card.remove(); break; }
        case 'meta':
          if (event.title) title.textContent = event.title;
          if (event.mode) modeSelect.value = event.mode;
          break;
        default: break;
      }
    }

    function follow() {
      if (disposed) return;
      source = new EventSource(`${base}/conversations/${conversation.id}/events?after=${seq}`);
      source.onmessage = message => { try { apply(JSON.parse(message.data)); } catch { /* a malformed frame is skipped */ } };
      source.addEventListener('reset', () => { source.close(); void load(); });
      source.addEventListener('gone', () => { source.close(); notify('This chat no longer exists'); });
      // EventSource would reconnect to the same URL with an old `after`; reconnect by hand so no event is applied twice or missed.
      source.onerror = () => { source.close(); source = null; if (!disposed) retry = setTimeout(follow, 2000); };
    }

    async function load() {
      try {
        const state = await api.get(`${base}/conversations/${conversation.id}`);
        if (disposed) return;
        list.replaceChildren();
        requests.replaceChildren();
        items.clear();
        for (const item of state.items) upsert(item);
        for (const request of state.pending) permission(request);
        canSteer = Boolean(state.capabilities && state.capabilities.steer);
        seq = state.seq;
        setStatus(state.status);
        toBottom();
        follow();
      } catch (error) {
        if (!disposed) { notify(`Could not load the chat: ${error.message}`); retry = setTimeout(load, 4000); }
      }
    }

    // ── Attachments ──
    function renderAttachments() {
      chips.hidden = !attachments.length;
      chips.replaceChildren(...attachments.map((file, index) => {
        const chip = el('span', 'ac-chip');
        chip.append(el('span', '', file.name));
        const remove = el('button', 'ac-chip-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove ${file.name}`);
        remove.addEventListener('click', () => { attachments.splice(index, 1); renderAttachments(); });
        chip.append(remove);
        return chip;
      }));
    }
    const readAs = (file, how) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader[how](file);
    });
    async function addFiles(files) {
      for (const file of files) {
        if (IMAGE_TYPES.includes(file.type)) {
          if (file.size > MAX_IMAGE_BYTES) { notify(`${file.name || 'Image'} is larger than 8 MB`); continue; }
          const data = String(await readAs(file, 'readAsDataURL')).split(',')[1] || '';
          attachments.push({ kind: 'image', name: file.name || 'image', type: file.type, data });
        } else if (file.size <= MAX_FILE_CHARS) {
          try { attachments.push({ kind: 'file', name: file.name, text: await readAs(file, 'readAsText') }); }
          catch { notify(`Could not read ${file.name}`); }
        } else {
          notify(`${file.name} is too large (text files up to 200 KB; images up to 8 MB)`);
        }
      }
      renderAttachments();
    }
    attach.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { void addFiles([...picker.files]); picker.value = ''; });
    input.addEventListener('paste', event => {
      const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter(file => IMAGE_TYPES.includes(file.type));
      if (files.length) { event.preventDefault(); void addFiles(files); }
    });

    // ── Sending ──
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight + 2, 160)}px`; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !coarse()) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const text = input.value.trim();
      if ((status === 'running' && !canSteer) || (!text && !attachments.length)) return;
      const body = {
        text,
        images: attachments.filter(file => file.kind === 'image').map(({ name, type, data }) => ({ name, type, data })),
        files: attachments.filter(file => file.kind === 'file').map(({ name, text: content }) => ({ name, text: content })),
      };
      send.disabled = true;
      try {
        await api.post(`${base}/conversations/${conversation.id}/messages`, body);
        input.value = '';
        attachments = [];
        renderAttachments();
        grow();
      } catch (error) {
        notify(error.message === 'CONVERSATION_BUSY' ? 'The agent is still working' : `Could not send: ${error.message}`);
      } finally { send.disabled = false; }
    });
    stop.addEventListener('click', async () => {
      try { await api.post(`${base}/conversations/${conversation.id}/interrupt`, {}); }
      catch (error) { notify(`Could not stop: ${error.message}`); }
    });
    modeSelect.addEventListener('change', async () => {
      const next = modeSelect.value;
      if (next === 'full' && !window.confirm(t('Full access lets the agent act without asking. Continue?'))) { modeSelect.value = conversation.mode; return; }
      try { await api.patch(`${base}/conversations/${conversation.id}`, { mode: next }); conversation.mode = next; }
      catch (error) { modeSelect.value = conversation.mode; notify(`Could not change the access level: ${error.message}`); }
    });
    back.addEventListener('click', () => { if (onClose) onClose(); });

    void load();
    return {
      root,
      focus: () => input.focus(),
      destroy() {
        disposed = true;
        clearTimeout(retry);
        if (source) source.close();
        root.remove();
      },
    };
  }

  return { mount, choices, open, AGENTS };
})();
