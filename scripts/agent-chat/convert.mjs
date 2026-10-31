// Conversation items (what the server keeps) as assistant-ui messages.
//
// A user item starts a message of its own; everything the agent produced after it (text, reasoning, tool calls, errors, notices) is one
// assistant message, in the order it happened. Tool calls that follow each other are one `tools` part (shown as a folded "Ran 3 commands").
// A call that has no result yet is running; a finished call without output has an empty one.
//
// Every message also carries `footer` for the line under it (time, copy, fork, new session): { itemId, at, text }. `itemId` is the item a fork starts at (the message
// of the person itself, or the last item of the agent's message), `at` when it was sent (for the agent: when its last item appeared) and `text` what "copy" copies
// (the person's message, or the agent's text blocks, not its tool calls or reasoning).

const asObject = input => (input && typeof input === 'object' && !Array.isArray(input) ? input : { value: input === undefined ? '' : input });

export function toMessages(items) {
  const messages = [];
  let assistant = null;
  const flush = () => { if (assistant && assistant.content.length) messages.push(assistant); assistant = null; };
  const add = (part, item) => {
    if (!assistant) assistant = { id: `a-${part.id}`, role: 'assistant', content: [], footer: { itemId: item.id, at: item.at, text: '' } };
    assistant.content.push(part);
    assistant.footer.itemId = item.id;
    if (item.at) assistant.footer.at = item.at;
    if (item.kind === 'text' && item.text) assistant.footer.text = assistant.footer.text ? `${assistant.footer.text}\n\n${item.text}` : item.text;
  };
  for (const item of items) {
    if (item.kind === 'user') {
      flush();
      const content = [{ type: 'text', text: item.text || '' }];
      if (item.attachments && item.attachments.length) content.push({ type: 'data', name: 'attachments', data: item.attachments });
      messages.push({ id: item.id, role: 'user', content, footer: { itemId: item.id, at: item.at, text: item.text || '' } });
    } else if (item.kind === 'text') {
      add({ id: item.id, type: 'text', text: item.text || '' }, item);
    } else if (item.kind === 'thinking') {
      if (item.text) add({ id: item.id, type: 'reasoning', text: item.text }, item); // a block that streamed nothing is not shown
    } else if (item.kind === 'tool') {
      const call = { id: item.id, name: item.name || 'Tool', args: asObject(item.input), output: item.output || '', status: item.status === 'running' ? 'running' : item.status === 'error' ? 'error' : 'done' };
      const last = assistant && assistant.content[assistant.content.length - 1];
      if (last && last.type === 'data' && last.name === 'tools') last.data.calls.push(call);
      else add({ id: `tools-${item.id}`, type: 'data', name: 'tools', data: { calls: [call] } }, item);
      if (last && last.type === 'data' && last.name === 'tools') { assistant.footer.itemId = item.id; if (item.at) assistant.footer.at = item.at; }
    } else if (item.kind === 'init') {
      add({ id: item.id, type: 'data', name: 'init', data: { text: item.text || '', details: Array.isArray(item.details) ? item.details : [] } }, item);
    } else {
      add({ id: item.id, type: 'data', name: 'notice', data: { kind: item.kind === 'error' ? 'error' : 'notice', ...(item.level === 'warn' ? { level: 'warn' } : {}), text: item.text || '' } }, item);
    }
  }
  flush();
  return messages;
}
