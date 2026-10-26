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
const mac = () => /Mac|iPhone|iPad/.test(navigator.platform || '');
const SpeechRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;

const Icon = ({ d, fill }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const ICONS = {
  plus: 'M12 5v14M5 12h14', chevron: 'M6 9l6 6 6-6', up: 'M12 19V5M5 12l7-7 7 7', stop: 'M6 6h12v12H6z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3', close: 'M6 6l12 12M18 6L6 18', enter: 'M20 5v7a3 3 0 0 1-3 3H5m0 0l4-4m-4 4l4 4',
};

// "claude-sonnet-5-5" -> "Sonnet 5.5"; ids of other makers are shown as they are.
function modelName(id) {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)(?:-\d{8})?$/.exec(id || '');
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2].replace('-', '.')}` : id || '';
}
const capitalize = text => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : '');

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

// "Initialized session": what the agent started with, folded away until asked for.
function Init({ data }) {
  return (
    <details className="ac-item ac-init">
      <summary>{t(data.text)}</summary>
      <dl className="ac-init-body">
        {data.details.map(([label, value]) => (
          <React.Fragment key={label}><dt>{t(label)}</dt><dd translate="no">{value}</dd></React.Fragment>
        ))}
      </dl>
    </details>
  );
}

const AGENT_PARTS = { Text: AgentText, Reasoning: Thinking, tools: { Fallback: ToolCard }, data: { by_name: { notice: Notice, init: Init } } };
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

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

// The turn is running: animated dots and how long it has been going.
function Working({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return (
    <div className="ac-working" role="status">
      <span className="ac-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="ac-elapsed">{formatElapsed(since ? now - since : 0)}</span>
    </div>
  );
}

// Speech to text with the browser's recognizer; the button only exists where the browser has one.
function Mic({ onText, notify }) {
  const [on, setOn] = useState(false);
  const recognizer = useRef(null);
  useEffect(() => () => { if (recognizer.current) recognizer.current.abort(); }, []);
  if (!SpeechRecognition || coarse()) return null; // phones dictate through their keyboard
  const toggle = () => {
    if (recognizer.current) { recognizer.current.stop(); return; }
    const next = new SpeechRecognition();
    next.lang = document.documentElement.lang || navigator.language || 'en-US';
    next.continuous = true;
    next.interimResults = false;
    next.onresult = event => {
      for (let index = event.resultIndex; index < event.results.length; index++) {
        if (event.results[index].isFinal) onText(event.results[index][0].transcript);
      }
    };
    next.onerror = event => { if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') notify(`Dictation failed: ${event.error}`); };
    next.onend = () => { recognizer.current = null; setOn(false); };
    recognizer.current = next;
    setOn(true);
    try { next.start(); } catch { recognizer.current = null; setOn(false); }
  };
  return (
    <button type="button" className={`ac-mic${on ? ' on' : ''}`} aria-pressed={on} aria-label={t(on ? 'Stop dictation' : 'Dictate')} onClick={toggle}><Icon d={ICONS.mic} /></button>
  );
}

function Composer({ store, state, agent, notify, inputRef }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const picker = useRef(null);
  const running = state.status === 'running';
  const filled = Boolean(text.trim() || attachments.length);
  const key = mac() ? '⌘' : 'Ctrl+';

  const grow = node => {
    if (!node) return;
    node.style.height = 'auto';
    if (!node.value) { node.style.height = ''; return; } // empty: the height the stylesheet gives one row
    node.style.height = `${Math.min(node.scrollHeight + 2, 200)}px`;
  };
  useEffect(() => grow(inputRef.current), [text]);

  // Enter sends (into the running turn when the agent takes input, otherwise it waits); Cmd/Ctrl+Enter always waits for the turn to end.
  const placeholder = coarse() ? t(`Message ${agent.label}`)
    : running ? (state.canSteer ? `${mac() ? '⏎ ' : 'Enter '}${t('to send,')} ${key}${mac() ? '⏎' : 'Enter'} ${t('to queue for later')}` : `${mac() ? '⏎ ' : 'Enter '}${t('to queue for later')}`)
      : `${mac() ? '⏎ ' : 'Enter '}${t('to send,')} ${t('Shift+Enter for a new line')}`;

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

  async function dispatch(later) {
    const body = text.trim();
    if ((!body && !attachments.length) || sending) return;
    const message = {
      text: body,
      images: attachments.filter(file => file.kind === 'image').map(({ name, type, data }) => ({ name, type, data })),
      files: attachments.filter(file => file.kind === 'file').map(({ name, text: content }) => ({ name, text: content })),
    };
    if (running && (later || !state.canSteer)) {
      store.enqueue(message);
      setText(''); setAttachments([]);
      return;
    }
    setSending(true);
    const sent = await store.send(message);
    if (sent) { setText(''); setAttachments([]); }
    setSending(false);
  }

  const canNow = entry => !running || state.canSteer;
  return (
    <form className="ac-composer" autoComplete="off" onSubmit={event => { event.preventDefault(); void dispatch(false); }}>
      {state.queue.length ? (
        <div className="ac-queue" aria-label={t('Queued')}>
          {state.queue.map(entry => (
            <span className="ac-chip ac-queued" key={entry.id}>
              <span translate="no">{entry.label}</span>
              {canNow(entry) ? <button type="button" className="ac-chip-remove" aria-label={t('Send now')} onClick={() => void store.sendQueued(entry.id)}><Icon d={ICONS.enter} /></button> : null}
              <button type="button" className="ac-chip-remove" aria-label={t('Remove from the queue')} onClick={() => store.unqueue(entry.id)}>×</button>
            </span>
          ))}
        </div>
      ) : null}
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
      <div className="ac-box">
        <button type="button" className="ac-attach" aria-label={t('Attach an image or text file')} onClick={() => picker.current && picker.current.click()}><Icon d={ICONS.plus} /></button>
        <textarea
          ref={inputRef} className="ac-input" rows={1} maxLength={100000} enterKeyHint="send" value={text}
          placeholder={placeholder}
          aria-label={t(`Message ${agent.label}`)}
          onChange={event => setText(event.target.value)}
          onPaste={event => {
            const files = [...(event.clipboardData ? event.clipboardData.files : [])].filter(file => IMAGE_TYPES.includes(file.type));
            if (files.length) { event.preventDefault(); void addFiles(files); }
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            const later = event.metaKey || event.ctrlKey;
            if (coarse() && !later) return; // on a phone Enter is a new line; the send button sends
            event.preventDefault();
            void dispatch(later);
          }}
        />
        <Mic notify={notify} onText={spoken => setText(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${spoken.trim()}`)} />
        {filled ? <button type="submit" className="ac-send" disabled={sending} aria-label={t(running && !state.canSteer ? 'Queue for later' : 'Send')}><Icon d={ICONS.up} /></button> : null}
        {running ? <button type="button" className="ac-stop" aria-label={t('Stop')} onClick={() => void store.stop()}><Icon d={ICONS.stop} fill /></button> : null}
      </div>
      <input ref={picker} type="file" multiple hidden accept={ACCEPT} onChange={event => { void addFiles([...event.target.files]); event.target.value = ''; }} />
    </form>
  );
}

// The agent's mark (Claude's glyph, the OpenAI logo for Codex) is drawn by agent-chat.js, which the pages load before this bundle.
function AgentIcon({ agent }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && typeof AgentChat !== 'undefined') ref.current.replaceChildren(AgentChat.icon(agent)); }, [agent]);
  return <span ref={ref} className={`ac-badge ${agent}`} aria-hidden="true" />;
}

// The title with a menu: rename the chat, or close it.
function TitleMenu({ title, store, onClose }) {
  const [open, setOpen] = useState(false);
  const holder = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = event => { if (holder.current && !holder.current.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  const rename = async () => {
    setOpen(false);
    const next = window.prompt(t('Rename chat'), title);
    if (next && next.trim() && next.trim() !== title) await store.rename(next.trim());
  };
  return (
    <div className="ac-titlebar" ref={holder}>
      <button type="button" className="ac-title-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="ac-title">{title}</span>
        <Icon d={ICONS.chevron} />
      </button>
      {open ? (
        <div className="ac-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => void rename()}>{t('Rename…')}</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); if (onClose) onClose(); }}>{t('Close chat')}</button>
        </div>
      ) : null}
    </div>
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
  const model = [modelName(state.model), capitalize(state.effort)].filter(Boolean).join(' ');

  return (
    <section className={`agent-chat ${conversation.agent}`} aria-label={t(`${agent.label} chat`)} translate="no">
      <header className="ac-head">
        <button type="button" className="ac-back" aria-label={t('Close chat')} onClick={() => onClose && onClose()}>←</button>
        <AgentIcon agent={conversation.agent} />
        <TitleMenu title={state.title} store={store} onClose={onClose} />
      </header>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="ac-thread">
          <ThreadPrimitive.Viewport className="ac-messages" role="log" aria-live="polite" scrollToBottomOnInitialize>
            <div className="ac-list"><ThreadPrimitive.Messages components={MESSAGES} /></div>
            <div className="ac-requests">{state.pending.map(request => <Request key={request.id} request={request} store={store} />)}</div>
            {state.status === 'running' ? <Working since={state.runningSince} /> : null}
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
      <Composer store={store} state={state} agent={agent} notify={notify} inputRef={inputRef} />
      <div className="ac-foot">
        <label className="ac-mode-label">
          <span className="ac-mode-text">{t((agent.modes.find(([value]) => value === state.mode) || [state.mode, state.mode])[1])}</span>
          <Icon d={ICONS.chevron} />
          <select className="ac-mode" aria-label={t('Access level')} value={state.mode} onChange={changeMode}>
            {agent.modes.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
          </select>
        </label>
        {model ? <span className="ac-model" translate="no">{model}</span> : null}
      </div>
    </section>
  );
});
