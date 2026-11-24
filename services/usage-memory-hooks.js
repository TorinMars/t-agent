// Where the memories' events come from ("Memories" in docs/design/usage-time.md): each hook turns something the server already knows into one
// English line (services/usage-memories.js addEvent, de-duplicated by code and reference within 10 minutes). Only titles, names, versions and
// counts go into a line; never terminal text, commands or file contents.
//   T-Attention (services/attention.js onChange): the person confirmed (review -> done), sent back (review -> working) or handled (waiting_user ->
//     working) an item; an agent (any other actor) set it done or failed.
//   lib/usage-events.js: a task created or archived, an update applied (the "Updated to" notice), a practice of the coach finished.
//   Service links (onChange): a linked engine that went offline or came back.
//   The session clocks (services/usage-time-clock.js onLongTurn): an agent turn longer than 30 minutes.
const { onUsageEvent } = require('../lib/usage-events');

const TITLE = 120;
const short = value => {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > TITLE ? `${text.slice(0, TITLE - 1)}…` : text;
};

// The line and code of a T-Attention change, or null.
function attentionLine(change) {
  if (!change || change.kind !== 'updated' || !change.item || !change.previous || !change.event) return null;
  const from = change.previous.status;
  const to = change.item.status;
  if (from === to) return null;
  const title = short(change.item.title);
  const byPerson = change.event.actor === 'user';
  if (byPerson && from === 'review' && to === 'done') return { event: 'attention-confirm', text: `You confirmed "${title}"` };
  if (byPerson && from === 'review' && to === 'working') return { event: 'attention-reject', text: `You sent "${title}" back` };
  if (byPerson && from === 'waiting_user' && to === 'working') return { event: 'attention-handled', text: `You handled "${title}"` };
  if (!byPerson && to === 'done') return { event: 'attention-done', text: `"${title}" is done` };
  if (!byPerson && to === 'failed') return { event: 'attention-failed', text: `"${title}" failed` };
  return null;
}

function startMemoryHooks({ memories, instanceId, attention = null, serviceLinks = null, taskTitle = null } = {}) {
  const stops = [];
  const taskRef = taskId => { const id = instanceId(); return id && Number.isInteger(Number(taskId)) && Number(taskId) > 0 ? `${id}|${Number(taskId)}` : null; };
  const add = entry => { try { return memories.addEvent(entry); } catch { return null; } };

  if (attention && typeof attention.onChange === 'function') {
    stops.push(attention.onChange(change => {
      const line = attentionLine(change);
      if (!line) return;
      const tie = change.item.context && change.item.context.tagent;
      const task = tie ? taskRef(tie.task_id) : null;
      const session = task && tie && typeof tie.terminal_id === 'string' ? `${task}|${tie.terminal_id}` : null;
      add({ ...line, ref: `attention:${change.item.id}`, task, session });
    }));
  }

  stops.push(onUsageEvent((name, payload) => {
    if (name === 'task-created' || name === 'task-archived') {
      const task = taskRef(payload.task_id);
      add({ event: name, text: `Task "${short(payload.title)}" ${name === 'task-created' ? 'created' : 'archived'}`, ref: task || '', task });
    } else if (name === 'update-applied' && typeof payload.version === 'string') {
      add({ event: 'update-applied', text: `Updated to v${payload.version}`, ref: `version:${payload.version}` });
    } else if (name === 'practice-finished' && Number.isInteger(payload.total) && payload.total > 0) {
      const right = Number.isInteger(payload.right) ? payload.right : 0;
      add({ event: 'practice-finished', text: `Practice finished: ${right} of ${payload.total} right`, ref: `practice:${short(payload.title)}` });
    }
  }));

  if (serviceLinks && typeof serviceLinks.onChange === 'function') {
    const known = new Map(); // link id -> online, from the first look on (the start itself is no event)
    const look = () => {
      let peers = [];
      try { peers = serviceLinks.peers(); } catch { return; }
      for (const peer of peers) {
        const before = known.get(peer.id);
        known.set(peer.id, Boolean(peer.online));
        if (before === undefined || before === Boolean(peer.online)) continue;
        const name = short(peer.name) || 'A linked engine';
        add({ event: peer.online ? 'engine-up' : 'engine-down', text: peer.online ? `${name} is back online` : `${name} went offline`, ref: `engine:${peer.instanceId || peer.id}` });
      }
    };
    look();
    stops.push(serviceLinks.onChange(look));
  }

  // For the session clocks' onLongTurn.
  function longTurn({ task, session, seconds }) {
    const minutes = Math.round(seconds / 60);
    const title = taskTitle && task ? short(taskTitle(task)) : '';
    add({ event: 'long-turn', text: title ? `An agent worked for ${minutes} min in "${title}"` : `An agent worked for ${minutes} min`, ref: session || task || '', task, session });
  }

  return { longTurn, stop: () => { while (stops.length) { try { stops.pop()(); } catch { /* stopping anyway */ } } } };
}

module.exports = { startMemoryHooks, attentionLine };
