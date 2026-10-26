// The chat view of one conversation. assistant-ui supplies the thread (message list, scroll-to-bottom, part rendering); the access
// level, permission / question cards and the composer are ours because they talk to this server's API (see store.js).
import React, { useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime,
} from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import { toMessages } from './convert.mjs';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_CHARS = 200 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPT = `${IMAGE_TYPES.join(',')},text/*,.md,.json,.js,.ts,.py,.log,.csv,.yml,.yaml,.sh`;

const t = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
const coarse = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };

// ── Message parts ──
function Code({ className, children }) {
  const source = String(children ?? '');
  const language = /language-(\S+)/.exec(className || '')?.[1];
  const html = useMemo(() => {
    try { return language && hljs.getLanguage(language) ? hljs.highlight(source.replace(/\n$/, ''), { language, ignoreIllegals: true }).value : null; }
    catch { return null; }
  }, [source, language]);
  if (!className) return <code>{children}</code>; // inline code
  // hljs escapes the source, so its output is safe to insert.
  return html === null ? <code className={className}>{children}</code> : <code className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
const Link = ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
const MARKDOWN = { code: Code, a: Link };

function AgentText() {
  return <div className="ac-item ac-text"><MarkdownTextPrimitive remarkPlugins={[remarkGfm]} components={MARKDOWN} /></div>;
}

function UserText({ text }) {
  return <div className="ac-bubble">{text}</div>;
}

function Thinking({ text }) {
  return (
    <details className="ac-item ac-thinking">
      <summary>{t('Thinking')}</summary>
      <div className="ac-thinking-body">{text}</div>
    </details>
  );
}

const toolSummary = input => {
  const value = (input && (input.command || input.file_path || input.path || input.pattern || input.query || input.url || input.description)) || '';
  return typeof value === 'string' ? value.split('\n')[0] : '';
};
const prettyInput = input => {
  if (!input || typeof input !== 'object') return String(input || '');
  if (typeof input.command === 'string' && Object.keys(input).length <= 2) return input.command;
  try { return JSON.stringify(input, null, 2); } catch { return ''; }
};

function ToolCard({ toolName, args, result, isError }) {
  const status = result === undefined ? 'running' : isError ? 'error' : 'done';
  const input = prettyInput(args);
  return (
    <details className={`ac-item ac-tool ${status}`}>
      <summary>
        <span className="ac-dot" />
        <span className="ac-tool-name">{toolName}</span>
        <span className="ac-tool-brief">{toolSummary(args)}</span>
      </summary>
      {input ? <pre className="ac-tool-input">{input}</pre> : null}
      {result ? <pre className="ac-tool-output">{String(result)}</pre> : null}
    </details>
  );
}

function Notice({ data }) {
  return <div className={`ac-item ${data.kind === 'error' ? 'ac-error' : 'ac-notice'}`}><span>{data.text}</span></div>;
}

function Attachments({ data }) {
  return <div className="ac-chips">{data.map((name, index) => <span className="ac-chip" key={index}>{name}</span>)}</div>;
}

const AGENT_PARTS = { Text: AgentText, Reasoning: Thinking, tools: { Fallback: ToolCard }, data: { by_name: { notice: Notice } } };
const USER_PARTS = { Text: UserText, data: { by_name: { attachments: Attachments } } };

const AssistantMessage = () => <MessagePrimitive.Root className="ac-assistant"><MessagePrimitive.Parts components={AGENT_PARTS} /></MessagePrimitive.Root>;
const UserMessage = () => <MessagePrimitive.Root className="ac-item ac-user"><MessagePrimitive.Parts components={USER_PARTS} /></MessagePrimitive.Root>;
const MESSAGES = { UserMessage, AssistantMessage };

// ── Permission and question cards ──
function Question({ question, value, onChange }) {
  const options = question.options && question.options.length ? question.options : null;
  const [typing, setTyping] = useState(false);
  return (
    <label className="ac-question">
      <span className="ac-question-text">{question.question || question.header}</span>
      {options ? (
        <>
          <select className="ac-question-input" translate="no" value={typing ? '' : value} onChange={event => {
            const other = event.target.value === '';
            setTyping(other);
            onChange(other ? '' : event.target.value);
          }}>
            {options.map(option => <option key={option.label} value={option.label} title={option.description || undefined}>{option.label}</option>)}
            {question.isOther ? <option value="">{t('Other…')}</option> : null}
          </select>
          {typing ? <input className="ac-question-input" translate="no" autoFocus placeholder={t('Your answer')} value={value} onChange={event => onChange(event.target.value)} /> : null}
        </>
      ) : (
        <input className="ac-question-input" translate="no" type={question.isSecret ? 'password' : 'text'} value={value} onChange={event => onChange(event.target.value)} />
      )}
    </label>
  );
}

function Request({ request, store }) {
  const questions = request.kind === 'question' && request.questions && request.questions.length ? request.questions : null;
  const [answers, setAnswers] = useState(() => Object.fromEntries((questions || []).map(question => [question.id, question.options && question.options.length ? question.options[0].label : ''])));
  const [busy, setBusy] = useState(false);
  const reply = async body => {
    setBusy(true);
    const done = await store.answer(request.id, body);
    if (!done) setBusy(false); // answered requests disappear through permission_done
  };
  return (
    <div className="ac-request" data-id={request.id}>
      <div className="ac-request-title">{request.title || `${t('Allow')} ${request.tool}?`}</div>
      {questions ? questions.map(question => (
        <Question key={question.id} question={question} value={answers[question.id] ?? ''} onChange={value => setAnswers(current => ({ ...current, [question.id]: value }))} />
      )) : <pre className="ac-request-detail" translate="no">{request.description || prettyInput(request.input)}</pre>}
      <div className="ac-request-actions">
        {questions ? (
          <>
            <button type="button" className="ac-allow" disabled={busy} onClick={() => reply({ allow: true, answers })}>{t('Submit')}</button>
            <button type="button" className="ac-deny" disabled={busy} onClick={() => reply({ allow: false })}>{t('Skip')}</button>
          </>
        ) : (
          <>
            <button type="button" className="ac-allow" disabled={busy} onClick={() => reply({ allow: true })}>{t('Allow')}</button>
            {request.canRemember ? <button type="button" className="ac-allow ac-remember" disabled={busy} onClick={() => reply({ allow: true, remember: true })}>{t('Allow for this session')}</button> : null}
            <button type="button" className="ac-deny" disabled={busy} onClick={() => reply({ allow: false })}>{t('Deny')}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Composer ──
const readAs = (file, how) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader[how](file);
});

function Composer({ store, state, agent, notify, inputRef }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const picker = useRef(null);
  const running = state.status === 'running';

  const grow = node => {
    if (!node) return;
    node.style.height = 'auto';
    if (!node.value) { node.style.height = ''; return; } // empty: the height the stylesheet gives one row
    node.style.height = `${Math.min(node.scrollHeight + 2, 160)}px`;
  };
  useEffect(() => grow(inputRef.current), [text]);

  async function addFiles(files) {
    const added = [];
    for (const file of files) {
      if (IMAGE_TYPES.includes(file.type)) {
        if (file.size > MAX_IMAGE_BYTES) { notify(`${file.name || 'Image'} is larger than 8 MB`); continue; }
        const data = String(await readAs(file, 'readAsDataURL')).split(',')[1] || '';
        added.push({ kind: 'image', name: file.name || 'image', type: file.type, data });
      } else if (file.size <= MAX_FILE_CHARS) {
        try { added.push({ kind: 'file', name: file.name, text: await readAs(file, 'readAsText') }); }
        catch { notify(`Could not read ${file.name}`); }
      } else {
        notify(`${file.name} is too large (text files up to 200 KB; images up to 8 MB)`);
      }
    }
    setAttachments(current => [...current, ...added]);
  }

  async function submit(event) {
    event.preventDefault();
    const body = text.trim();
    if ((running && !state.canSteer) || (!body && !attachments.length) || sending) return;
    setSending(true);
    const sent = await store.send({
      text: body,
      images: attachments.filter(file => file.kind === 'image').map(({ name, type, data }) => ({ name, type, data })),
      files: attachments.filter(file => file.kind === 'file').map(({ name, text: content }) => ({ name, text: content })),
    });
    if (sent) { setText(''); setAttachments([]); }
    setSending(false);
  }

  return (
    <form className="ac-composer" autoComplete="off" onSubmit={submit}>
      {attachments.length ? (
        <div className="ac-attachments">
          {attachments.map((file, index) => (
            <span className="ac-chip" key={index}>
              <span>{file.name}</span>
              <button type="button" className="ac-chip-remove" aria-label={t(`Remove ${file.name}`)} onClick={() => setAttachments(current => current.filter((_, at) => at !== index))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="ac-row">
        <button type="button" className="ac-attach" aria-label={t('Attach an image or text file')} onClick={() => picker.current && picker.current.click()}>＋</button>
        <textarea
          ref={inputRef} className="ac-input" rows={1} maxLength={100000} enterKeyHint="send" value={text}
          placeholder={running && state.canSteer ? t(`Add to what ${agent.label} is doing`) : t(`Message ${agent.label}`)}
          aria-label={t(`Message ${agent.label}`)}
          onChange={event => setText(event.target.value)}
          onPaste={event => {
            const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter(file => IMAGE_TYPES.includes(file.type));
            if (files.length) { event.preventDefault(); void addFiles(files); }
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !coarse()) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
          }}
        />
        {!running || state.canSteer ? <button type="submit" className="ac-send" disabled={sending}>{t('Send')}</button> : null}
        {running ? <button type="button" className="ac-stop" onClick={() => void store.stop()}>{t('Stop')}</button> : null}
      </div>
      <input ref={picker} type="file" multiple hidden accept={ACCEPT} onChange={event => { void addFiles([...event.target.files]); event.target.value = ''; }} />
    </form>
  );
}

// ── The view ──
export const Chat = React.forwardRef(function Chat({ store, agent, conversation, onClose, notify }, ref) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const messages = useMemo(() => toMessages(state.items), [state.items]);
  const inputRef = useRef(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current && inputRef.current.focus() }), []);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: state.status === 'running',
    convertMessage: message => message,
    // The composer posts to our own API and the new item arrives over SSE, so nothing is appended here.
    onNew: async () => {},
  });

  const changeMode = async event => {
    const next = event.target.value;
    if (next === 'full' && !window.confirm(t('Full access lets the agent act without asking. Continue?'))) return;
    await store.setMode(next);
  };

  return (
    <section className="agent-chat" aria-label={t(`${agent.label} chat`)} translate="no">
      <header className="ac-head">
        <button type="button" className="ac-back" aria-label={t('Close chat')} onClick={() => onClose && onClose()}>←</button>
        <span className={`ac-badge ${conversation.agent}`} aria-hidden="true">{conversation.agent === 'codex' ? '◎' : '✳'}</span>
        <span className="ac-title">{state.title}</span>
        <select className="ac-mode" aria-label={t('Access level')} value={state.mode} onChange={changeMode}>
          {agent.modes.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
        </select>
      </header>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="ac-thread">
          <ThreadPrimitive.Viewport className="ac-messages" role="log" aria-live="polite" scrollToBottomOnInitialize>
            <div className="ac-list"><ThreadPrimitive.Messages components={MESSAGES} /></div>
            <div className="ac-requests">{state.pending.map(request => <Request key={request.id} request={request} store={store} />)}</div>
            {state.status === 'running' ? <div className="ac-working">{t('Working…')}</div> : null}
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
      <Composer store={store} state={state} agent={agent} notify={notify} inputRef={inputRef} />
    </section>
  );
});
