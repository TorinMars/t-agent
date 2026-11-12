// The credential of the local relays that programs in a T-Agent terminal call (routes/peer-fs.js for the `t-agent-peers` MCP server,
// routes/tcli.js for `tcli`): the terminal's hook token (routes/terminal.js) in X-T-Agent-Task, X-T-Agent-Terminal and X-T-Agent-Token,
// taken only from this machine. There is no browser login on these routes, so server.js mounts them before the session and the gates.

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
// From this machine: a loopback peer, or the address the server was reached on (the hook endpoint uses HOST when it is not a wildcard), and no
// proxy in between (a reverse proxy on this machine would make every visitor look local).
function fromThisMachine(req) {
  const remote = req.socket && req.socket.remoteAddress;
  if (!remote) return false;
  if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined || req.headers['x-real-ip'] !== undefined) return false;
  return LOOPBACK.test(remote) || remote === req.socket.localAddress;
}

// Whether a relay should take this request at all: it carries one of the terminal headers and comes from this machine. Any other request is
// passed on untouched by the relay, so it meets the login gate like every route.
function isTerminalRequest(req, isLocal = fromThisMachine) {
  const taskHeader = req.get('x-t-agent-task');
  const terminalHeader = req.get('x-t-agent-terminal');
  const token = req.get('x-t-agent-token');
  if (taskHeader === undefined && terminalHeader === undefined && token === undefined) return false;
  return Boolean(isLocal(req));
}

// Checks the three headers. Returns { error: 'AUTH_REQUIRED' | 'AUTH_INVALID' } or { task: { id, user_id } }.
function verifyTerminalRequest(req, { db, verifyToken }) {
  const taskHeader = req.get('x-t-agent-task');
  const terminalHeader = req.get('x-t-agent-terminal');
  const token = req.get('x-t-agent-token');
  if (!taskHeader || !terminalHeader || !token) return { error: 'AUTH_REQUIRED' };
  if (!/^\d{1,12}$/.test(taskHeader) || !verifyToken(Number(taskHeader), terminalHeader, token)) return { error: 'AUTH_INVALID' };
  const task = db.prepare('SELECT id, user_id FROM tasks WHERE id = ?').get(Number(taskHeader));
  if (!task) return { error: 'AUTH_INVALID' };
  return { task };
}

module.exports = { fromThisMachine, isTerminalRequest, verifyTerminalRequest };
