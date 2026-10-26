// Conversation items (what the server keeps) as assistant-ui messages.
//
// A user item starts a message of its own; everything the agent produced after it (text, reasoning, tool calls, errors, notices) is one
// assistant message, in the order it happened.

const asObject = input => (input && typeof input === 'object' && !Array.isArray(input) ? input : { value: input === undefined ? '' : input });

export function toMessages(items) {
  const messages = [];
  let assistant = null;
  const flush = () => { if (assistant && assistant.content.length) messages.push(assistant); assistant = null; };
  const add = part => {
    if (!assistant) assistant = { id: `a-${part.id}`, role: 'assistant', content: [] };
    assistant.content.push(part);
  };
  for (const item of items) {
    if (item.kind === 'user') {
      flush();
      const content = [{ type: 'text', text: item.text || '' }];
      if (item.attachments && item.attachments.length) content.push({ type: 'data', name: 'attachments', data: item.attachments });
      messages.push({ id: item.id, role: 'user', content });
    } else if (item.kind === 'text') {
      add({ id: item.id, type: 'text', text: item.text || '' });
    } else if (item.kind === 'thinking') {
      if (item.text) add({ id: item.id, type: 'reasoning', text: item.text }); // a block that streamed nothing is not shown
    } else if (item.kind === 'tool') {
      const failed = item.status === 'error';
      add({
        id: item.id, type: 'tool-call', toolCallId: item.id, toolName: item.name || 'Tool', args: asObject(item.input),
        // A call without a result is still running; a finished call without output has an empty result.
        ...(item.status === 'running' ? {} : { result: item.output || '' }),
        ...(failed ? { isError: true } : {}),
      });
    } else {
      add({ id: item.id, type: 'data', name: 'notice', data: { kind: item.kind === 'error' ? 'error' : 'notice', text: item.text || '' } });
    }
  }
  flush();
  return messages;
}
