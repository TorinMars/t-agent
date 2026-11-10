// The one check that a linked service may reach a task under /v1 (services/task-visibility.js). It sits first in routes/engine-v1.js, before every route.
//
// A denied request is not answered here: the task id in its URL (or body) is replaced by an id no task has, and the request goes on. Whatever route it reaches
// answers from its own "no such task" path, so the answer is the same as for a task that does not exist, down to the status, the body, a watch route's empty 404
// and a sub-path that has no route at all. A route added later under /tasks/:id is covered without doing anything.
const { authenticateAccessToken } = require('../services/engine-auth');
const { MISSING_TASK_ID } = require('../services/task-visibility');

// Every path whose second segment is a task id. Matched like Express matches its routes: without regard to case, and on the decoded segment.
const TASK_PATH = /^\/(tasks|terminal-sessions)\/([^/]+)(\/.*)?$/i;
// The two routes that take task ids from the body.
const REORDER_PATH = /^\/tasks\/reorder\/?$/i;
const TICKET_PATH = /^\/terminal-sessions\/?$/i;

function decodeSegment(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}

// An event stream ends cleanly, which the reader treats like the end of the feed. Anything else was cut off halfway and must not look complete.
function endResponse(res) {
  if (String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) res.end();
  else res.destroy();
}

function createTaskVisibilityGuard({ visibility, db, serviceLinks }) {
  function linkOf(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const token = match && authenticateAccessToken(db, match[1]);
    const link = token && serviceLinks.linkForToken(token.id);
    return link ? link.id : null;
  }

  return function taskVisibilityGuard(req, res, next) {
    const taskPath = TASK_PATH.exec(req.path);
    const reorder = req.method === 'PUT' && REORDER_PATH.test(req.path);
    const ticket = req.method === 'POST' && TICKET_PATH.test(req.path);
    if (!taskPath && !reorder && !ticket) return next();
    // Without a link token the request goes on untouched, also a bad one: the route's own authentication answers that.
    const linkId = linkOf(req);
    if (!linkId) return next();

    if (taskPath) {
      const taskId = visibility.taskIdOf(decodeSegment(taskPath[2]));
      if (taskId !== null) {
        if (visibility.isDenied(taskId, linkId)) {
          const query = req.url.indexOf('?');
          req.url = `/${taskPath[1]}/${MISSING_TASK_ID}${taskPath[3] || ''}${query < 0 ? '' : req.url.slice(query)}`;
        } else {
          // Whatever this request stays open for (an event stream, a file download) ends when the link loses the task.
          res.on('close', visibility.track(linkId, taskId, () => endResponse(res)));
        }
      }
    }

    const hidden = value => {
      const taskId = visibility.taskIdOf(value);
      return taskId !== null && visibility.isDenied(taskId, linkId);
    };
    if (reorder && Array.isArray(req.body)) {
      req.body = req.body.map(item => (item && hidden(item.id) ? { ...item, id: MISSING_TASK_ID } : item));
    }
    if (ticket && req.body && hidden(req.body.task_id)) req.body = { ...req.body, task_id: MISSING_TASK_ID };
    next();
  };
}

module.exports = { createTaskVisibilityGuard };
