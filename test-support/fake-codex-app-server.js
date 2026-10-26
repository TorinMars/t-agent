#!/usr/bin/env node
// A scripted stand-in for `codex app-server` (newline-delimited JSON over stdio). The prompt of the turn picks the scenario:
//   "approve"  asks to run a command and waits for the decision
//   "question" asks the person a question and waits for the answer
//   "hang"     keeps the turn open until it is steered or interrupted
//   anything else answers at once
// Every request the client makes is appended to $FAKE_CODEX_LOG as one JSON line.
const fs = require('fs');
const readline = require('readline');

const log = row => { if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(row)}\n`); };
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const THREAD = 'thread-fake0001';
const TURN = 'turn-1';
let nextServerId = 100;
const waiting = new Map(); // server request id -> callback
let scenario = '';

function ask(method, params, then) {
  const id = nextServerId++;
  waiting.set(id, then);
  send({ id, method, params });
}

function finish(status = 'completed', error = null) {
  notify('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: { total: {}, last: { inputTokens: 3, outputTokens: 4 }, modelContextWindow: null } });
  notify('turn/completed', { threadId: THREAD, turn: { id: TURN, items: [], status, error } });
}

function reply(text) {
  const item = { type: 'agentMessage', id: 'm1', text: '', phase: null };
  notify('item/started', { threadId: THREAD, turnId: TURN, item });
  notify('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'm1', delta: text.slice(0, 2) });
  notify('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'm1', delta: text.slice(2) });
  notify('item/completed', { threadId: THREAD, turnId: TURN, item: { ...item, text } });
}

function runScenario(text) {
  scenario = text;
  if (text.includes('approve')) {
    const command = { type: 'commandExecution', id: 'c1', command: 'touch x', cwd: '/w', status: 'inProgress', aggregatedOutput: null, exitCode: null };
    notify('item/started', { threadId: THREAD, turnId: TURN, item: command });
    ask('item/commandExecution/requestApproval', { threadId: THREAD, turnId: TURN, itemId: 'c1', command: 'touch x', cwd: '/w', reason: 'Needs to write x' }, result => {
      log({ answer: 'commandExecution', result });
      const declined = result.decision === 'decline';
      notify('item/completed', { threadId: THREAD, turnId: TURN, item: { ...command, status: declined ? 'declined' : 'completed', aggregatedOutput: '', exitCode: declined ? null : 0 } });
      reply(declined ? 'declined' : 'ran');
      finish();
    });
  } else if (text.includes('question')) {
    ask('item/tool/requestUserInput', { threadId: THREAD, turnId: TURN, itemId: 'q1', isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'color', header: 'Color', question: 'Which color?', isOther: true, isSecret: false, options: [{ label: 'red', description: '' }] }] }, result => {
      log({ answer: 'userInput', result });
      reply(`got ${JSON.stringify(result.answers)}`);
      finish();
    });
  } else if (text.includes('hang')) {
    notify('item/started', { threadId: THREAD, turnId: TURN, item: { type: 'reasoning', id: 'r1', summary: [], content: [] } });
    notify('item/reasoning/summaryTextDelta', { threadId: THREAD, turnId: TURN, itemId: 'r1', delta: 'thinking', summaryIndex: 0 });
  } else {
    reply('hello');
    finish();
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) {
    const then = waiting.get(message.id);
    waiting.delete(message.id);
    if (then) then(message.result);
    return;
  }
  log({ method: message.method, params: message.params });
  switch (message.method) {
    case 'initialize': send({ id: message.id, result: { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } }); break;
    case 'thread/start':
    case 'thread/resume': send({ id: message.id, result: { thread: { id: THREAD } } }); break;
    case 'turn/start':
      send({ id: message.id, result: { turn: { id: TURN, items: [], status: 'inProgress' } } });
      setTimeout(() => runScenario(message.params.input[0].text), 5);
      break;
    case 'turn/steer':
      send({ id: message.id, result: { turnId: TURN } });
      if (scenario.includes('hang')) { reply(`steered: ${message.params.input[0].text}`); finish(); }
      break;
    case 'turn/interrupt': send({ id: message.id, result: {} }); finish('interrupted'); break;
    default: if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `unknown ${message.method}` } });
  }
});
