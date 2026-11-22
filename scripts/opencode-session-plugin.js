// OpenCode plugin of T-Agent terminals (docs/design/opencode-terminals.md). routes/terminal.js starts opencode in an OpenCode
// terminal as `OPENCODE_CONFIG_CONTENT="$TA_OPENCODE_CONFIG" opencode`, and that config names this file (file://...), so it is loaded for that
// process only: the person's own opencode config and plugins still load, and T-Agent writes nothing to ~/.config/opencode.
//
// It tells the T-Agent server, over the terminal's hook endpoint ($TA_HOOK_URL, with $TA_HOOK_TOKEN as X-TA-Token), what opencode does:
//  - event=session { session_id, source, cwd }: the session the terminal runs. 'startup' for the first root session this process makes,
//    'new' for one made later (/new), 'resume' when the process works on a root session it did not make (`opencode -s <id>`, /sessions).
//  - event=start (a root session is busy, a permission or a question was answered), event=stop (a root session is idle),
//    event=attention&kind=accept (a permission request), event=attention&kind=select&via=tool (the question tool).
// With $TA_SESSION_NAME (a terminal the person named in T-Agent), a root session gets that title when it is made, and the session a process started
// with (`opencode -s <id>`) gets it too when its title differs (the same as Claude's --name at each start); one picked later with /sessions does not. opencode keeps a title it did not generate itself.
//
// Written for opencode 1.19.6 (checked there: the plugin shape, the event names and fields, the v1 SDK client with { path, body }); an ES module with no
// dependencies. Every step is caught and nothing is printed: a broken report never disturbs opencode. Without TA_HOOK_URL / TA_HOOK_TOKEN it does nothing.
// Sessions with a parentID (the sub-agents' child sessions) do not bind and their busy / idle are not reported; their permission requests and
// questions are, since the person must answer those in the terminal.

const POST_TIMEOUT_MS = 1500;

export const TAgentSessionPlugin = async ({ client, directory } = {}) => {
  const url = process.env.TA_HOOK_URL;
  const token = process.env.TA_HOOK_TOKEN;
  if (!url || !token) return {};
  let base;
  try { base = new URL(url); } catch { return {}; }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return {};
  const name = String(process.env.TA_SESSION_NAME || '').trim();

  const roots = new Set();
  const children = new Set();
  let current = null; // the root session this process works on
  let queue = Promise.resolve(); // reports are sent one after the other, in the order the events came

  const send = async (query, body) => {
    try {
      const target = new URL(base.href);
      for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
      const headers = { 'X-TA-Token': token };
      if (body) headers['Content-Type'] = 'application/json';
      const response = await fetch(target, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
      try { await response.body?.cancel(); } catch { /* nothing to read */ }
    } catch { /* the server is gone or slow: the next event reports again */ }
  };
  const later = step => { queue = queue.then(step).catch(() => {}); };

  const sessionOf = async id => {
    try {
      const answer = await client.session.get({ path: { id } });
      return (answer && answer.data) || null;
    } catch { return null; }
  };
  // Whether a session is a root one: known from session.created, else asked once (a session made before this process started).
  const isRoot = async id => {
    if (roots.has(id)) return true;
    if (children.has(id)) return false;
    const info = await sessionOf(id);
    const root = !(info && info.parentID);
    (root ? roots : children).add(id);
    return root;
  };
  const rename = async (id, known) => {
    if (!name) return;
    try {
      const info = known || await sessionOf(id);
      if (info && info.title === name) return;
      await client.session.update({ path: { id }, body: { title: name } });
    } catch { /* the title stays opencode's */ }
  };
  const bind = (id, source, cwd) => send({ event: 'session' }, { session_id: id, source, cwd: cwd || directory || process.cwd() });

  const handle = async event => {
    const type = event && event.type;
    const props = (event && event.properties) || {};
    if (type === 'session.created') {
      const info = props.info || {};
      const id = info.id || props.sessionID;
      if (typeof id !== 'string') return;
      if (info.parentID) { children.add(id); return; }
      roots.add(id);
      const source = current ? 'new' : 'startup';
      current = id;
      await bind(id, source, info.directory);
      await rename(id, info);
      return;
    }
    const id = props.sessionID;
    if (typeof id !== 'string') return;
    if (type === 'session.status') {
      if (!props.status || props.status.type !== 'busy' || !(await isRoot(id))) return;
      if (id !== current) {
        const first = current === null; // `opencode -s <id>`: the session the terminal was started with
        current = id;
        const info = await sessionOf(id);
        await bind(id, 'resume', info && info.directory);
        if (first) await rename(id, info);
      }
      await send({ event: 'start' });
    } else if (type === 'session.idle') {
      if (await isRoot(id)) await send({ event: 'stop' });
    } else if (type === 'permission.asked') {
      await send({ event: 'attention', kind: 'accept' });
    } else if (type === 'question.asked') {
      await send({ event: 'attention', kind: 'select', via: 'tool' });
    } else if (type === 'permission.replied' || type === 'question.replied' || type === 'question.rejected') {
      await send({ event: 'start' });
    }
  };

  return {
    event: async ({ event } = {}) => {
      later(() => handle(event)); // opencode does not wait for the network
    },
  };
};
