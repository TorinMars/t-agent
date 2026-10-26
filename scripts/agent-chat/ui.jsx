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
import ReactMarkdown from 'react-markdown';
import { callBrief, capitalize, diffLines, groupLabel, limitText, modelName, tokens, visibleLimits } from './format.mjs';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_CHARS = 200 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const ACCEPT = `${IMAGE_TYPES.join(',')},text/*,.md,.json,.js,.ts,.py,.log,.csv,.yml,.yaml,.sh`;

const t = text => (typeof I18n !== 'undefined' ? I18n.t(text) : text);
const coarse = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };
const mac = () => /Mac|iPhone|iPad/.test(navigator.platform || '');

const Icon = ({ d, fill }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const ICONS = {
  plus: 'M12 5v14M5 12h14', chevron: 'M6 9l6 6 6-6', up: 'M12 19V5M5 12l7-7 7 7', stop: 'M6 6h12v12H6z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3', close: 'M6 6l12 12M18 6L6 18', edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4', expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7', collapse: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7', enter: 'M20 5v7a3 3 0 0 1-3 3H5m0 0l4-4m-4 4l4 4',
};


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

const prettyInput = input => {
  if (!input || typeof input !== 'object') return String(input || '');
  if (typeof input.command === 'string' && Object.keys(input).length <= 2) return input.command;
  try { return JSON.stringify(input, null, 2); } catch { return ''; }
};

// The changes of an edit, for review: removed lines, added lines and the lines around them.
function DiffView({ lines }) {
  return (
    <pre className="ac-diff" translate="no">
      {lines.map((line, index) => (
        <span key={index} className={`ac-diff-line ${line.type}`}>{line.type === 'file' || line.type === 'hunk' ? line.text : `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}` || ' '}</span>
      ))}
    </pre>
  );
}

// The state of one step: a ring that turns while it runs, a check when it is done, a cross when it failed.
function StepIcon({ status }) {
  return (
    <svg className={`ac-step-icon ${status}`} viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <circle cx="10" cy="10" r="8" fill="none" strokeWidth="1.6" />
      {status === 'done' ? <path d="M6.2 10.4l2.5 2.5 5-5.3" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {status === 'error' ? <path d="M7 7l6 6M13 7l-6 6" fill="none" strokeWidth="1.7" strokeLinecap="round" /> : null}
    </svg>
  );
}

// One call of a group: its state and what it is about; opening it shows what was sent and what came back.
function ToolStep({ call }) {
  const changes = diffLines(call.args);
  const input = changes ? '' : prettyInput(call.args);
  return (
    <details className={`ac-item ac-tool ${call.status}`}>
      <summary>
        <StepIcon status={call.status} />
        <span className="ac-tool-name">{call.name}</span>
        <span className="ac-tool-brief">{callBrief(call.args)}</span>
      </summary>
      {changes ? <DiffView lines={changes} /> : null}
      {input ? <pre className="ac-tool-input">{input}</pre> : null}
      {call.output ? <pre className="ac-tool-output">{String(call.output)}</pre> : null}
    </details>
  );
}

// The tool calls of a turn as one folded line ("Ran 2 commands"); opened, a card with a row per call.
function ToolGroup({ data }) {
  const label = groupLabel(data.calls);
  const what = t(label.text);
  return (
    <details className={`ac-item ac-toolgroup${label.running ? ' running' : ''}${label.failed ? ' failed' : ''}`}>
      <summary>
        {label.running ? <StepIcon status="running" /> : null}
        <span translate="no">{what}</span>
        {label.failed ? <span className="ac-failed" translate="no">{`· ${t(`${label.failed} failed`)}`}</span> : null}
      </summary>
      <div className="ac-steps">{data.calls.map(call => <ToolStep key={call.id} call={call} />)}</div>
    </details>
  );
}

function Notice({ data }) {
  const style = data.kind === 'error' ? 'ac-error' : (data.level === 'warn' ? 'ac-warn' : 'ac-notice');
  return <div className={`ac-item ${style}`}><span>{data.text}</span></div>;
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

const AGENT_PARTS = { Text: AgentText, Reasoning: Thinking, data: { by_name: { notice: Notice, init: Init, tools: ToolGroup } } };
const USER_PARTS = { Text: UserText, data: { by_name: { attachments: Attachments } } };

const AssistantMessage = () => <MessagePrimitive.Root className="ac-assistant"><MessagePrimitive.Parts components={AGENT_PARTS} /></MessagePrimitive.Root>;
const UserMessage = () => <MessagePrimitive.Root className="ac-item ac-user"><MessagePrimitive.Parts components={USER_PARTS} /></MessagePrimitive.Root>;
const MESSAGES = { UserMessage, AssistantMessage };

// ── Permission, question and plan cards ──
// One question of the agent: a list of options to pick (one, or several when `multiSelect`), and always another answer of one's own.
// `value` is what will be sent: a string, or a list of strings when several can be picked.
function Question({ question, value, onChange }) {
  const options = question.options && question.options.length ? question.options : null;
  const multi = Boolean(question.multiSelect);
  const picked = multi ? value : [value];
  const labels = options ? options.map(option => option.label) : [];
  const [writing, setWriting] = useState(false);
  const [other, setOther] = useState('');
  const send = (nextPicked, nextOther, nextWriting) => {
    const extra = nextWriting && nextOther.trim() ? [nextOther.trim()] : [];
    onChange(multi ? [...nextPicked, ...extra] : (extra[0] || nextPicked[0] || ''));
  };
  const toggle = label => {
    const keep = picked.filter(entry => labels.includes(entry));
    const next = multi ? (keep.includes(label) ? keep.filter(entry => entry !== label) : [...keep, label]) : [label];
    if (!multi) setWriting(false);
    send(next, other, multi ? writing : false);
  };
  if (!options) {
    return (
      <label className="ac-question">
        <span className="ac-question-text">{question.question || question.header}</span>
        <input className="ac-question-input" translate="no" type={question.isSecret ? 'password' : 'text'} value={value || ''} onChange={event => onChange(event.target.value)} />
      </label>
    );
  }
  return (
    <fieldset className="ac-question">
      <legend className="ac-question-text">
        {question.header ? <span className="ac-question-chip" translate="no">{question.header}</span> : null}
        <span translate="no">{question.question}</span>
      </legend>
      {multi ? <span className="ac-question-hint">{t('Select all that apply')}</span> : null}
      <div className="ac-options" role={multi ? 'group' : 'radiogroup'}>
        {options.map(option => {
          const on = picked.includes(option.label) && !(writing && !multi);
          return (
            <label className={`ac-option${on ? ' on' : ''}`} key={option.label}>
              <input type={multi ? 'checkbox' : 'radio'} name={`q-${question.id}`} checked={on} onChange={() => toggle(option.label)} />
              <span className="ac-option-body" translate="no">
                <span className="ac-option-label">{option.label}</span>
                {option.description ? <span className="ac-option-desc">{option.description}</span> : null}
                {option.preview ? <pre className="ac-option-preview">{option.preview}</pre> : null}
              </span>
            </label>
          );
        })}
        {question.isOther !== false ? (
          <label className={`ac-option${writing ? ' on' : ''}`}>
            <input type={multi ? 'checkbox' : 'radio'} name={`q-${question.id}`} checked={writing} onChange={() => {
              const next = !writing;
              setWriting(next);
              send(multi ? picked.filter(entry => labels.includes(entry)) : [], other, next);
            }} />
            <span className="ac-option-body">
              <span className="ac-option-label">{t('Other…')}</span>
              {writing ? <input className="ac-question-input" translate="no" autoFocus placeholder={t('Your answer')} value={other} onChange={event => {
                setOther(event.target.value);
                send(multi ? picked.filter(entry => labels.includes(entry)) : [], event.target.value, true);
              }} /> : null}
            </span>
          </label>
        ) : null}
      </div>
    </fieldset>
  );
}

// A question counts as answered when something is picked or written.
const answered = (question, value) => (question.multiSelect ? Array.isArray(value) && value.length > 0 : typeof value === 'string' && value.trim() !== '');

// The plan the agent proposes, as formatted text, for the person to approve or to send back with comments.
function PlanReview({ request, reply, busy, agent }) {
  const [feedback, setFeedback] = useState('');
  return (
    <>
      <div className="ac-plan ac-text"><ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>{request.plan || t('The agent did not include the plan text.')}</ReactMarkdown></div>
      <textarea className="ac-question-input ac-plan-feedback" rows={2} translate="no" placeholder={t(`Tell ${agent.label} what to change (optional)`)} value={feedback} onChange={event => setFeedback(event.target.value)} />
      <div className="ac-request-actions">
        <button type="button" className="ac-allow" disabled={busy} onClick={() => reply({ allow: true })}>{t('Approve plan')}</button>
        <button type="button" className="ac-deny" disabled={busy} onClick={() => reply({ allow: false, message: feedback.trim() || undefined })}>{t('Keep planning')}</button>
      </div>
    </>
  );
}

function Request({ request, store, agent }) {
  const questions = request.kind === 'question' && request.questions && request.questions.length ? request.questions : null;
  const [answers, setAnswers] = useState(() => Object.fromEntries((questions || []).map(question => [question.id, question.multiSelect ? [] : ''])));
  const [busy, setBusy] = useState(false);
  const reply = async body => {
    setBusy(true);
    const done = await store.answer(request.id, body);
    if (!done) setBusy(false); // answered requests disappear through permission_done
  };
  const changes = !questions && request.kind !== 'plan' ? diffLines(request.input) : null;
  const ready = questions ? questions.every(question => answered(question, answers[question.id])) : true;
  return (
    <div className={`ac-request ${request.kind || 'approval'}`} data-id={request.id}>
      <div className="ac-request-title">{t(request.title) || `${t('Allow')} ${request.tool}?`}</div>
      {request.kind === 'plan' ? <PlanReview request={request} reply={reply} busy={busy} agent={agent} /> : (
        <>
          {questions ? questions.map(question => (
            <Question key={question.id} question={question} value={answers[question.id]} onChange={value => setAnswers(current => ({ ...current, [question.id]: value }))} />
          )) : changes ? <DiffView lines={changes} /> : <pre className="ac-request-detail" translate="no">{request.description || prettyInput(request.input)}</pre>}
          <div className="ac-request-actions">
            {questions ? (
              <>
                <button type="button" className="ac-allow" disabled={busy || !ready} onClick={() => reply({ allow: true, answers })}>{t('Submit')}</button>
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
        </>
      )}
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

// Speech to text with the speech model of the page (VoiceInput in voice-input.js: Fun-ASR, the same as the Chinese input box), not the browser's own
// recognizer. A tap starts recording, the next tap stops it. VoiceInput writes into a textarea, but React owns the real one (a value set from outside
// does not reach its state), so VoiceInput gets a detached textarea and every change of that one is copied into the chat text after what was typed
// before the recording. The button only exists where the page loaded voice-input.js.
function Mic({ text, setText, notify }) {
  const button = useRef(null);
  const latest = useRef(text);
  latest.current = text;
  const Voice = typeof window !== 'undefined' ? window.VoiceInput : undefined;
  useEffect(() => {
    const node = button.current;
    if (!node || !Voice || !Voice.attach) return undefined;
    const proxy = document.createElement('textarea');
    let typed = '';
    const controller = Voice.attach({
      textarea: proxy,
      button: node,
      onNotConfigured: () => (typeof API !== 'undefined' && Voice.showSettings ? Voice.showSettings() : notify('Set up voice input on the desktop page')),
    });
    // Capturing: this runs before VoiceInput's own click handler on the button, so the text typed so far is the base of a new recording.
    const begin = () => { if (controller.state === 'idle') { typed = latest.current; proxy.value = ''; } };
    node.addEventListener('click', begin, true);
    const copy = () => setText(proxy.value ? `${typed}${typed && !/\s$/.test(typed) ? ' ' : ''}${proxy.value}` : typed);
    proxy.addEventListener('input', copy);
    return () => { node.removeEventListener('click', begin, true); proxy.removeEventListener('input', copy); controller.cancel(); };
  }, [Voice]);
  if (!Voice) return null;
  const label = t('Voice input');
  return <button ref={button} type="button" className="ac-mic" aria-label={label} title={label}><Icon d={ICONS.mic} /></button>;
}

// The images on the clipboard of a paste event. Some browsers list a pasted screenshot in `items` but leave `files` empty.
function pastedImages(event) {
  const data = event.clipboardData;
  if (!data) return [];
  const files = [...(data.files || [])].filter(file => IMAGE_TYPES.includes(file.type));
  if (files.length) return files;
  return [...(data.items || [])].filter(item => item.kind === 'file' && IMAGE_TYPES.includes(item.type)).map(item => item.getAsFile()).filter(Boolean);
}

function Composer({ store, state, agent, notify, inputRef }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false); // the big input box: Enter is a new line, and the message is sent with the button only
  const translate = state.translate; // saved with the chat: each chat keeps its own switch
  const submitting = useRef(false);
  const picker = useRef(null);
  const form = useRef(null);
  const running = state.status === 'running';
  const filled = Boolean(text.trim() || attachments.length);
  const key = mac() ? '⌘' : 'Ctrl+';

  const grow = node => {
    if (!node) return;
    if (expanded) { node.style.height = ''; return; } // the stylesheet gives the expanded box its height
    node.style.height = 'auto';
    if (!node.value) { node.style.height = ''; return; } // empty: the height the stylesheet gives one row
    node.style.height = `${Math.min(node.scrollHeight + 2, 200)}px`;
  };
  useEffect(() => grow(inputRef.current), [text, expanded]);

  // Enter sends (into the running turn when the agent takes input, otherwise it waits); Cmd/Ctrl+Enter always waits for the turn to end.
  // In the expanded box Enter is a new line, and only the send button sends.
  const placeholder = expanded ? t('Enter for a new line; use the send button to send')
    : coarse() ? t(`Message ${agent.label}`)
    : running ? (state.canSteer ? `${mac() ? '⏎ ' : 'Enter '}${t('to send,')} ${key}${mac() ? '⏎' : 'Enter'} ${t('to queue for later')}` : `${mac() ? '⏎ ' : 'Enter '}${t('to queue for later')}`)
      : `${mac() ? '⏎ ' : 'Enter '}${t('to send,')} ${t('Shift+Enter for a new line')}`;

  // Pasting an image works wherever the focus is in this chat (the message list, a button), not only inside the input box.
  const paste = useRef(null);
  useEffect(() => {
    const onPaste = event => {
      const target = event.target;
      const node = form.current;
      if (event.defaultPrevented || !node || node.offsetParent === null || !(target instanceof Element)) return;
      if (target.closest('input, textarea, select, [contenteditable]')) return; // the input box handles its own paste; other fields keep theirs
      const chat = node.closest('.agent-chat');
      const inside = chat && chat.contains(target);
      const loose = target === document.body && document.querySelectorAll('.agent-chat').length === 1;
      if (!inside && !loose) return;
      const files = pastedImages(event);
      if (files.length) { event.preventDefault(); void paste.current(files); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  async function addFiles(files) {
    if (submitting.current) return;
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
  paste.current = addFiles;

  async function dispatch(later) {
    const body = text.trim();
    if ((!body && !attachments.length) || submitting.current) return;
    submitting.current = true;
    setSending(true);
    try {
      const message = await store.prepareMessage({
        text: body,
        images: attachments.filter(file => file.kind === 'image').map(({ name, type, data }) => ({ name, type, data })),
        files: attachments.filter(file => file.kind === 'file').map(({ name, text: content }) => ({ name, text: content })),
      }, translate);
      if (!message) return;
      // Translation can outlast the current turn; use the latest status when deciding whether to queue.
      const current = store.getState();
      if (current.status === 'running' && (later || !current.canSteer)) {
        store.enqueue(message);
        setText(''); setAttachments([]);
      } else if (await store.send(message)) {
        setText(''); setAttachments([]);
      }
    } catch (error) {
      notify(error.message || 'Translation failed');
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  const canNow = entry => !running || state.canSteer;
  const [editing, setEditing] = useState(null); // a queued message being edited: { id, text }
  const finishEdit = save => {
    if (editing && save && !store.editQueued(editing.id, editing.text)) notify('A queued message cannot be empty; remove it instead');
    setEditing(null);
  };
  return (
    <>
    <form ref={form} className={`ac-composer${expanded ? ' expanded' : ''}`} aria-busy={sending} autoComplete="off" onSubmit={event => { event.preventDefault(); void dispatch(false); }}>
      {state.queue.length ? (
        <div className="ac-queue" aria-label={t('Queued')}>
          {state.queue.map(entry => (editing && editing.id === entry.id ? (
            <span className="ac-chip ac-queued ac-queued-editing" key={entry.id}>
              <input className="ac-queued-input" translate="no" autoFocus value={editing.text} aria-label={t('Edit the queued message')} maxLength={100000}
                onChange={event => setEditing({ id: entry.id, text: event.target.value })}
                onBlur={() => finishEdit(true)}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') { event.preventDefault(); finishEdit(true); }
                  else if (event.key === 'Escape') { event.preventDefault(); finishEdit(false); }
                }} />
            </span>
          ) : (
            <span className="ac-chip ac-queued" key={entry.id}>
              <span translate="no">{entry.label}</span>
              <button type="button" className="ac-chip-remove" aria-label={t('Edit the queued message')} title={t('Edit the queued message')} onClick={() => setEditing({ id: entry.id, text: entry.body.text || '' })}><Icon d={ICONS.edit} /></button>
              {canNow(entry)
                ? <button type="button" className="ac-chip-remove" aria-label={t('Send now')} title={t('Send now')} onClick={() => void store.sendQueued(entry.id)}><Icon d={ICONS.enter} /></button>
                : <button type="button" className="ac-chip-remove ac-chip-force" aria-label={t('Stop the agent and send now')} title={t('Stop the agent and send now')} onClick={() => void store.forceSend(entry.id)}><Icon d={ICONS.enter} /></button>}
              <button type="button" className="ac-chip-remove" aria-label={t('Remove from the queue')} title={t('Remove from the queue')} onClick={() => store.unqueue(entry.id)}>×</button>
            </span>
          )))}
        </div>
      ) : null}
      {attachments.length ? (
        <div className="ac-attachments">
          {attachments.map((file, index) => (
            <span className="ac-chip" key={index}>
              <span>{file.name}</span>
              <button type="button" className="ac-chip-remove" aria-label={t(`Remove ${file.name}`)} disabled={sending} onClick={() => setAttachments(current => current.filter((_, at) => at !== index))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="ac-box">
        <button type="button" className="ac-attach" disabled={sending} aria-label={t('Attach an image or text file')} onClick={() => picker.current && picker.current.click()}><Icon d={ICONS.plus} /></button>
        <textarea
          ref={inputRef} className="ac-input" readOnly={sending} rows={1} maxLength={100000} enterKeyHint={expanded ? 'enter' : 'send'} value={text}
          placeholder={placeholder}
          aria-label={t(`Message ${agent.label}`)}
          onChange={event => setText(event.target.value)}
          onPaste={event => {
            if (sending) return;
            const files = pastedImages(event);
            if (files.length) { event.preventDefault(); void addFiles(files); }
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            if (expanded) return; // a new line: no key sends from the expanded box
            event.preventDefault();
            void dispatch(event.metaKey || event.ctrlKey);
          }}
        />
        <button type="button" className="ac-expand" aria-pressed={expanded} aria-label={t(expanded ? 'Collapse the input box' : 'Expand the input box')} title={t(expanded ? 'Collapse the input box' : 'Expand the input box')}
          onClick={() => { setExpanded(value => !value); if (inputRef.current) inputRef.current.focus(); }}><Icon d={expanded ? ICONS.collapse : ICONS.expand} /></button>
        <Mic text={text} setText={value => { if (!submitting.current) setText(value); }} notify={notify} />
        {filled ? <button type="submit" className="ac-send" disabled={sending} aria-label={t(running && !state.canSteer ? 'Queue for later' : 'Send')}><Icon d={ICONS.up} /></button> : null}
        {running ? <button type="button" className="ac-stop" aria-label={t('Stop')} onClick={() => void store.stop()}><Icon d={ICONS.stop} fill /></button> : null}
      </div>
      <input ref={picker} type="file" multiple hidden accept={ACCEPT} onChange={event => { void addFiles([...event.target.files]); event.target.value = ''; }} />
    </form>
    {/* Between the input box and the access level: the translation switch on the left, the plan usage on the right. */}
    <div className="ac-meta">
      <button type="button" role="switch" aria-checked={translate} aria-label={t('Translate to English')}
        title={t('Translate to English')} className="ac-translate" disabled={sending} onClick={() => void store.setTranslate(!translate)}>
        <span>{t('Translate')}</span><span className="ac-switch-track" aria-hidden="true"><span /></span>
      </button>
      <Limits limits={state.limits} />
    </div>
    </>
  );
}

// The agent's mark (Claude's glyph, the OpenAI logo for Codex) is drawn by agent-chat.js, which the pages load before this bundle.
function AgentIcon({ agent }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && typeof AgentChat !== 'undefined') ref.current.replaceChildren(AgentChat.icon(agent)); }, [agent]);
  return <span ref={ref} className={`ac-badge ${agent}`} aria-hidden="true" />;
}

// Closes a popover when the person clicks elsewhere or presses Escape.
function useDismiss(open, close, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const away = event => { if (ref.current && !ref.current.contains(event.target)) close(); };
    const escape = event => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
}

// The model and thinking effort in the footer; it opens a list of both. A choice applies from the next message.
function ModelPicker({ store, state }) {
  const [open, setOpen] = useState(false);
  const holder = useRef(null);
  useDismiss(open, () => setOpen(false), holder);
  const shown = [modelName(state.model), capitalize(state.effort)].filter(Boolean).join(' ');
  if (!state.canChoose) return shown ? <span className="ac-model" translate="no">{shown}</span> : null;
  const { status, list } = state.models;
  const selected = list.find(entry => entry.value === state.choice.model) || list[0];
  const efforts = selected ? selected.efforts : [];
  const pick = entry => {
    // An effort the new model does not offer goes back to its default.
    const keep = !state.choice.effort || entry.efforts.includes(state.choice.effort);
    void store.choose({ model: entry.value, ...(keep ? {} : { effort: '' }) });
  };
  return (
    <div className="ac-picker-holder" ref={holder}>
      <button type="button" className="ac-model ac-picker-button" aria-haspopup="menu" aria-expanded={open} translate="no"
        onClick={() => { setOpen(value => !value); void store.loadModels(); }}>
        <span>{shown || t('Model')}</span>
        <Icon d={ICONS.chevron} />
      </button>
      {open ? (
        <div className="ac-picker" role="menu" aria-label={t('Model')}>
          {status === 'loading' || status === 'idle' ? <p className="ac-picker-note">{t('Loading…')}</p> : null}
          {status === 'error' ? <p className="ac-picker-note">{t('Could not load the models')} <button type="button" className="ac-link" onClick={() => { void store.loadModels(); }}>{t('Retry')}</button></p> : null}
          {list.length ? (
            <>
              <div className="ac-picker-title">{t('Model')}</div>
              <div className="ac-picker-list">
                {list.map(entry => (
                  <button type="button" role="menuitemradio" aria-checked={entry.value === (selected && selected.value)} key={entry.value || 'default'} className="ac-picker-item" onClick={() => pick(entry)}>
                    <span className="ac-picker-name">{entry.value ? entry.label : t(entry.label)}</span>
                    {entry.description ? <span className="ac-picker-desc" translate="no">{entry.description}</span> : null}
                  </button>
                ))}
              </div>
              {efforts.length ? (
                <>
                  <div className="ac-picker-title">{t('Thinking effort')}</div>
                  <div className="ac-picker-efforts">
                    {['', ...efforts].map(effort => (
                      <button type="button" role="menuitemradio" aria-checked={effort === state.choice.effort} key={effort || 'default'} className="ac-picker-effort" onClick={() => void store.choose({ effort })}>
                        {effort ? t(capitalize(effort)) : t('Default')}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <p className="ac-picker-note">{t('Applies from the next message')}</p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// What is left of the plan windows (5 hours, 7 days) and when each resets, in one unit with decimals: "62.5% · 4.2h".
function Limits({ limits }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const shown = visibleLimits(limits, now);
  if (!shown.length) return null;
  return (
    <span className="ac-limits" translate="no">
      {shown.map(entry => {
        const { left, reset, text } = limitText(entry, now);
        const title = t(`${entry.label} limit: ${left}% left${reset ? `, resets in ${reset}` : ''}`);
        return <span className={`ac-limit${100 - entry.usedPercent <= 10 ? ' low' : ''}`} key={entry.id} title={title} aria-label={title}>{text}</span>;
      })}
    </span>
  );
}

// How much of the model's context window the conversation fills; it turns amber and red as the window runs out.
function ContextRing({ context }) {
  if (!context || !context.window) return null;
  const ratio = Math.min(1, Math.max(0, context.used / context.window));
  const percent = Math.round(ratio * 100);
  const circumference = 2 * Math.PI * 8;
  const label = t(`Context: ${percent}% used (${tokens(context.used)} of ${tokens(context.window)} tokens)`);
  return (
    <span className={`ac-context${ratio >= 0.92 ? ' full' : ratio >= 0.8 ? ' high' : ''}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 22 22" width="18" height="18" aria-hidden="true">
        <circle className="ac-context-track" cx="11" cy="11" r="8" />
        <circle className="ac-context-value" cx="11" cy="11" r="8" strokeDasharray={`${circumference * ratio} ${circumference}`} transform="rotate(-90 11 11)" />
      </svg>
    </span>
  );
}

// The title with a menu: rename the chat, or close it.
function TitleMenu({ title, store, onClose }) {
  const [open, setOpen] = useState(false);
  const holder = useRef(null);
  useDismiss(open, () => setOpen(false), holder);
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
            <div className="ac-requests">{state.pending.map(request => <Request key={request.id} request={request} store={store} agent={agent} />)}</div>
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
        <span className="ac-status">
          <ModelPicker store={store} state={state} />
          <ContextRing context={state.context} />
        </span>
      </div>
    </section>
  );
});
