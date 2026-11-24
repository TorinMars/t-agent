// The parts of the English coach on the Learn page that need no DOM (pure functions with unit tests): the lines of the coach's answer stream, the
// proposal cards (plan, settings, cards, reminder, memory) as the page draws them, the divider of a practice result, the suggestion buttons, the
// "Remembered" line and the rows of the notes list. See docs/design/learn-english-coach-page.md.
import { mergeChat } from './learn-chat.mjs';

export const COACH_PAGE = 50;
export const COACH_TEXT_MAX = 4000;
export const NOTE_MAX = 200;
export const NOTES_MAX = 40;
// How long "Changed · Undo" and "Remembered: … · Undo" offer Undo.
export const UNDO_MS = 10000;
export const STATUS_TEXT = 'Looking at your answers…';
// The starters of an empty conversation (English dictionary keys; a tap sends the shown text).
export const COACH_STARTERS = ["Give me today's spelling practice", 'Analyze my practice. Where am I weak?', 'How many words have I learned so far?', 'I want to practise my wrong answers'];
export const NO_TOOLS = 'This service cannot look up your data; she answers from a short summary.';

// One line of the coach's answer stream (POST /coach/send and /coach/practice-result), as the page uses it:
// { kind: 'delta', text } | { kind: 'status', text } | { kind: 'proposals', proposals } | { kind: 'remembered', note } |
// { kind: 'done', messages, tools } | { kind: 'error', message, status } | null (a line the page does not know).
// The answer lines of POST /chats/send are read the same way (`{ delta }`, `{ done }`, `{ error, status }`); `done` may carry the stored messages as
// `messages`, or `message` (the answer) with `user` / `practice` (the stored question or result).
export function coachLine(line) {
  if (!line || typeof line !== 'object') return null;
  const type = typeof line.type === 'string' ? line.type : '';
  if (line.error && type !== 'done') return { kind: 'error', message: String(line.error), status: Number(line.status) || 502 };
  if (type === 'delta' || (!type && typeof line.delta === 'string')) return { kind: 'delta', text: String(typeof line.delta === 'string' ? line.delta : line.text || '') };
  if (type === 'status') return { kind: 'status', text: String(line.text || '') };
  if (type === 'proposals') return { kind: 'proposals', proposals: Array.isArray(line.proposals) ? line.proposals.filter(isObject) : [] };
  if (type === 'remembered') return isObject(line.note) ? { kind: 'remembered', note: line.note } : null;
  // Claude could not answer and the translation service did (services/learn-coach.js): one line above the answer.
  if (type === 'notice') return line.text ? { kind: 'notice', text: String(line.text) } : null;
  if (type === 'done' || line.done === true) {
    const messages = [];
    if (Array.isArray(line.messages)) messages.push(...line.messages.filter(isObject));
    for (const key of ['user', 'practice', 'message']) if (isObject(line[key]) && line[key].uid) messages.push(line[key]);
    return { kind: 'done', messages, tools: line.tools !== false, usage: isObject(line.usage) ? line.usage : null };
  }
  return null;
}
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The messages of the conversation after a page was read or an answer came: a union by uid, oldest first; `meta` as an object.
export function mergeCoach(...lists) {
  // A copy without `meta` (a temporary message) keeps the meta it had.
  const read = message => (message.meta === undefined ? message : { ...message, meta: metaOf(message) });
  return mergeChat(...lists.map(list => (list || []).filter(isObject).map(read))).map(message => ({ ...message, meta: metaOf(message) }));
}
export function metaOf(message) {
  const meta = message && message.meta;
  if (isObject(meta)) return meta;
  if (typeof meta === 'string' && meta) { try { const parsed = JSON.parse(meta); return isObject(parsed) ? parsed : {}; } catch { return {}; } }
  return {};
}

// What a proposal is, from its `kind` and its fields: 'plan' | 'settings' | 'cards' | 'reminder' | 'memory' | null.
const PLAN_KINDS = new Set(['practice', 'plan', 'today_spelling', 'review', 'mistakes_series', 'more_new_words', 'dictation', 'fill_gap']);
export function proposalType(proposal) {
  if (!isObject(proposal)) return null;
  const kind = String(proposal.kind || '');
  if (kind === 'settings' || isObject(proposal.changes)) return 'settings';
  if (kind === 'cards' || Array.isArray(proposal.add) || Array.isArray(proposal.update) || Array.isArray(proposal.remove)) return 'cards';
  if (kind === 'reminder' || (typeof proposal.time === 'string' && proposal.text !== undefined && !proposal.steps)) return 'reminder';
  if (kind === 'memory' || kind === 'remember' || kind === 'note') return 'memory';
  if (PLAN_KINDS.has(kind) || isObject(proposal.plan) || Array.isArray(proposal.steps)) return 'plan';
  return null;
}

// The plan of a practice proposal: { kind, title, steps: [{ mode, count }], words, minutes, notes } (the server's numbers).
export function planOf(proposal) {
  const plan = isObject(proposal && proposal.plan) ? proposal.plan : proposal || {};
  const steps = (Array.isArray(plan.steps) ? plan.steps : []).filter(isObject).map(step => ({
    mode: String(step.mode || ''), count: Array.isArray(step.card_ids) ? step.card_ids.length : Array.isArray(step.cards) ? step.cards.length : Number(step.count) || 0,
  }));
  return {
    kind: String(plan.kind && plan.kind !== 'practice' && plan.kind !== 'plan' ? plan.kind : proposal.practice || proposal.kind || ''),
    title: String(plan.title || ''), steps, words: Math.max(0, Number(plan.words) || 0), minutes: Math.max(0, Number(plan.minutes) || 0), notes: String(plan.notes || ''),
  };
}

// The line of a step in a plan card (English dictionary keys).
export const STEP_LABELS = { spell: 'Spell each word', review: 'Review the cards that are due', fill: 'Fill the gap inside a sentence', dictation: 'Dictation', retest: 'A final retest of the words you missed again' };
// The plan card's caption: "25 words · about 8 minutes" as [template, ...values].
export function planCaption(plan) {
  const words = plan.words === 1 ? ['1 word'] : ['{1} words', plan.words];
  if (!plan.minutes) return [words];
  return [words, plan.minutes === 1 ? ['about 1 minute'] : ['about {1} minutes', plan.minutes]];
}

// Labels of the learning settings a settings card may change (English dictionary keys); another key is shown as it is.
export const SETTING_LABELS = {
  new_per_day: 'New words a day', daily_goal: 'Daily goal', collect: 'Collect study material', pick_words: 'Pick words from my translations',
  analysis_auto: 'Analyze my mistakes every week', audio_words: 'Play words automatically', audio_sentences: 'Play sentences automatically',
  audio_sentences_at: 'Sentences play', audio_repeat: 'Repeat', audio_pause: 'Pause between repeats', audio_speed: 'Speed',
  audio_stop_on_typing: 'Stop when I start typing', desired_retention: 'Review schedule', coach_memory: 'Remember things about me',
  coach_read_answers: 'Let the coach read my learning answers', coach_read_text: 'Let the coach read my journal and chats',
};
const VALUE_LABELS = { slow: 'Slow', normal: 'Normal', after: 'After the answer', start: 'When the card appears' };
// A value as shown: { text, key } (`key`: an English dictionary key to translate; else the text is shown as it is).
export function settingValue(key, value) {
  if (typeof value === 'boolean') return { key: value ? 'On' : 'Off' };
  if (typeof value === 'string' && VALUE_LABELS[value]) return { key: VALUE_LABELS[value] };
  if (key === 'desired_retention' && typeof value === 'number') return { text: `${Math.round(value * 100)}%` };
  if (key === 'audio_repeat' && typeof value === 'number') return { text: `${value}×` };
  if (value === undefined || value === null || value === '') return null;
  return { text: String(value) };
}
// The rows of a settings card: [{ key, label (dictionary key or null), name (shown as is), from, to }]; `current`: the learning settings now.
export function settingRows(proposal, current = {}) {
  const changes = isObject(proposal && proposal.changes) ? proposal.changes : {};
  const before = isObject(proposal && proposal.before) ? proposal.before : {};
  return Object.keys(changes).map(key => ({
    key, label: SETTING_LABELS[key] || null, name: key,
    from: settingValue(key, before[key] !== undefined ? before[key] : current ? current[key] : undefined), to: settingValue(key, changes[key]),
  }));
}

// The sections of a cards card: [{ part: 'add' | 'update' | 'remove', title: [template, n], items: [{ en, zh }] }].
export function cardSections(proposal) {
  const out = [];
  const add = (Array.isArray(proposal && proposal.add) ? proposal.add : []).filter(isObject);
  const update = (Array.isArray(proposal && proposal.update) ? proposal.update : []).filter(isObject);
  const remove = (Array.isArray(proposal && proposal.remove) ? proposal.remove : []).map(one => (isObject(one) ? one : { id: one }));
  const named = one => ({ en: String(one.en || one.word || (one.id !== undefined ? `#${one.id}` : '')), zh: String(one.zh || '') });
  if (add.length) {
    const words = add.every(one => one.kind !== 'sentence');
    out.push({ part: 'add', title: add.length === 1 ? [words ? 'Add 1 word' : 'Add 1 card'] : [words ? 'Add {1} words' : 'Add {1} cards', add.length], items: add.map(named) });
  }
  if (update.length) out.push({ part: 'update', title: update.length === 1 ? ['Change 1 meaning'] : ['Change {1} meanings', update.length], items: update.map(named) });
  if (remove.length) out.push({ part: 'remove', title: remove.length === 1 ? ['Remove 1 card'] : ['Remove {1} cards', remove.length], items: remove.map(named) });
  return out;
}
// The action of a cards card: 'Add all' | 'Change' | 'Remove' | 'Apply' (several kinds of change).
export function cardsAction(sections) {
  if (sections.length !== 1) return 'Apply';
  return { add: 'Add all', update: 'Change', remove: 'Remove' }[sections[0].part];
}
// The chips a section shows: the first `max` items and "+N" for the rest.
export function chipList(items, max = 3) {
  const shown = items.slice(0, items.length > max + 1 ? max : max + 1).map(one => one.en);
  return items.length > shown.length ? [...shown, `+${items.length - shown.length}`] : shown;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// A day of a reminder as a weekday number (0 Sunday … 6 Saturday), or -1.
export function weekdayOf(day) {
  if (typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 7) return day % 7;
  const text = String(day || '').trim().toLowerCase().slice(0, 3);
  return WEEKDAYS.indexOf(text);
}
// The text of a reminder card as [template, ...values]: every day, or on its weekdays (`dayName(n)` names weekday n); `zone`: the time zone label.
export function reminderLine(proposal, { zone = '', dayName = n => WEEKDAYS[n] } = {}) {
  const time = String((proposal && proposal.time) || '');
  const text = String((proposal && proposal.text) || '');
  const days = [...new Set((Array.isArray(proposal && proposal.days) ? proposal.days : []).map(weekdayOf).filter(n => n >= 0))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const daily = !days.length || days.length === 7;
  return daily ? ['Every day at {1} ({2} time): "{3}".', time, zone, text] : ['Every {1} at {2} ({3} time): "{4}".', days.map(dayName).join(', '), time, zone, text];
}
// The place of a reminder's time zone ("Taipei" for Asia/Taipei: the last part of the zone name; the card says "Taipei time"); 'UTC' for none.
export const zoneLabel = zone => String(zone || '').split('/').pop().replace(/_/g, ' ').trim() || 'UTC';

// The divider of a practice result message (role `practice`): [template, ...values] — "Spelling finished · 25 words · 8 min" or "Stopped after 9 of 25".
const SPELLING = new Set(['today_spelling', 'more_new_words', 'spell']);
export function practiceLine(result) {
  const data = isObject(result) ? result : {};
  const total = Math.max(0, Number(data.total) || 0);
  const done = Math.max(0, Number(data.done) || 0);
  if (data.stopped) return ['Stopped after {1} of {2}', done, total];
  const minutes = Math.max(1, Math.round((Number(data.seconds) || 0) / 60));
  const spelling = SPELLING.has(String(data.kind || data.plan_kind || ''));
  if (total === 1) return [spelling ? 'Spelling finished · 1 word · {1} min' : 'Practice finished · 1 word · {1} min', minutes];
  return [spelling ? 'Spelling finished · {1} words · {2} min' : 'Practice finished · {1} words · {2} min', total, minutes];
}
// The result of a practice message: its meta's `practice`, else the message's own fields.
export const practiceOf = message => {
  const meta = metaOf(message);
  return isObject(meta.practice) ? meta.practice : isObject(message && message.practice) ? message.practice : {};
};

// The suggestion buttons under the newest answer: `meta.suggestions` (texts or { text }), at most 4, each once.
export function suggestionsOf(message) {
  const list = metaOf(message).suggestions;
  const out = [];
  for (const one of Array.isArray(list) ? list : []) {
    const text = String(isObject(one) ? one.text || one.label || '' : one || '').trim().slice(0, 120);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= 4) break;
  }
  return out;
}

// The screens of Learn a coach answer opens with a button (the server's open_screen; "Screens the coach opens" in
// docs/design/learn-english-coach-page.md), with the coach Learn has no other way in to them. `view`: the Learn view (Learn.jsx) it opens; a
// practice mode `needs` speech output (tts) or a way to hear the person (voice). The names are the server's COACH_SCREENS (services/learn-merge.js).
export const COACH_SCREENS = {
  mistakes: { label: 'Mistakes', icon: 'learnMistakes', view: { kind: 'mistakes' } },
  reports: { label: 'Mistake reports', icon: 'learnMistakes', view: { kind: 'reports' } },
  progress: { label: 'Progress', icon: 'learnChart', view: { kind: 'progress' } },
  material: { label: 'Your material', icon: 'learnMaterial', view: { kind: 'material' } },
  settings: { label: 'Learn settings', icon: 'setting', view: { kind: 'settings' } },
  how: { label: 'How learning works', icon: 'learnHow', view: { kind: 'how' } },
  review: { label: 'Daily review', icon: 'learnHistory', view: { kind: 'session', mode: 'review' } },
  practice: { label: 'Practice', icon: 'learnSpell', view: { kind: 'session', mode: 'mixed' } },
  spell: { label: 'Spell the word', icon: 'learnSpell', view: { kind: 'session', mode: 'spell' } },
  dictation: { label: 'Dictation', icon: 'learnDictation', view: { kind: 'session', mode: 'dictation' }, needs: 'tts' },
  fill: { label: 'Fill the gap', icon: 'learnFill', view: { kind: 'session', mode: 'fill' } },
  say: { label: 'Say it', icon: 'voice', view: { kind: 'session', mode: 'say' }, needs: 'voice' },
};
// The Learn view of a screen name (also the links /h5?learn=<name> and ui.actions.openLearn(name)), or null: an unknown name, or a mode this
// browser cannot run. `coach` and `chat` are the coach itself.
export function screenView(name, { tts = false, voice = false } = {}) {
  if (name === 'chat' || name === 'coach') return { kind: 'chat' };
  const screen = Object.prototype.hasOwnProperty.call(COACH_SCREENS, name) ? COACH_SCREENS[name] : null;
  if (!screen || (screen.needs === 'tts' && !tts) || (screen.needs === 'voice' && !voice)) return null;
  return { ...screen.view };
}
// The screen buttons of an answer (meta.screens), each once, at most 3, only those this browser can open: [{ name, label, icon }].
export function screensOf(message, speech = {}) {
  const list = metaOf(message).screens;
  const out = [];
  for (const name of Array.isArray(list) ? list : []) {
    if (typeof name !== 'string' || out.some(one => one.name === name) || !screenView(name, speech)) continue;
    out.push({ name, label: COACH_SCREENS[name].label, icon: COACH_SCREENS[name].icon });
    if (out.length >= 3) break;
  }
  return out;
}

// The proposals of a message (meta.proposals), with the newest state the page knows (`states`: id -> state) put in.
export function proposalsOf(message, states = {}) {
  const list = metaOf(message).proposals;
  return (Array.isArray(list) ? list : []).filter(one => isObject(one) && one.id !== undefined && proposalType(one)).map(one => ({ ...one, state: states[one.id] || one.state || 'open' }));
}

// The notes Remembered in a message (meta.remembered: one note or a list).
export function rememberedOf(message) {
  const value = metaOf(message).remembered;
  return (Array.isArray(value) ? value : value ? [value] : []).filter(one => isObject(one) && one.text);
}
// "Remembered: job interview in March (until 31 Mar)" as [template, ...values]; `day(iso)` formats the end date.
export function rememberedLine(note, day = iso => iso) {
  const text = String((note && note.text) || '');
  return note && note.until ? ['Remembered: {1} (until {2})', text, day(note.until)] : ['Remembered: {1}', text];
}
// The second line of a note in the notes list: "11-24" or "11-24 · until 31 Mar", as { made, until: [template, value] | null }. The two parts are
// translated apart and joined with " · " by the caller: a template such as "{1} · until {2}" would swallow longer lines of other places that
// contain it ("Every day at 09:00 · until 2027-01-31 · ends after 5 times") and leave their last part untranslated.
export function noteLine(note, { short = iso => iso, day = iso => iso } = {}) {
  const made = short(note && (note.created_at || note.updated_at));
  return { made, until: note && note.until ? ['until {1}', day(note.until)] : null };
}
// A note as the person types it: one line, at most NOTE_MAX characters.
export const cleanNote = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

// The caption under an answer from its `usage` ({ calls, tool_rounds, prompt_tokens?, completion_tokens? }, in `done` and in meta.usage): a list of
// [template, ...values] parts joined with " · " — "Looked at your data 3 times", then "3 calls · 18,400 tokens" when the provider counted tokens.
// Empty (no caption) when the answer looked nothing up and no tokens were reported. `number(n)` writes a count with its separators.
export function usageParts(usage, number = n => String(n)) {
  if (!isObject(usage)) return [];
  const count = key => Math.max(0, Math.round(Number(usage[key]) || 0));
  const rounds = count('tool_rounds');
  const calls = count('calls');
  const tokens = count('prompt_tokens') + count('completion_tokens');
  const out = [];
  if (rounds) out.push(rounds === 1 ? ['Looked at your data once'] : ['Looked at your data {1} times', rounds]);
  if (tokens) {
    if (calls) out.push(calls === 1 ? ['1 call'] : ['{1} calls', calls]);
    out.push(['{1} tokens', number(tokens)]);
  }
  if (usage.engine === 'claude') out.push(['Answered by Claude']);
  return out;
}
export const usageOf = message => { const usage = metaOf(message).usage; return isObject(usage) ? usage : null; };

// The coach's engines in Learn settings (`coach_engine`, "The Claude engine" in docs/design/learn-english-coach.md).
export const ENGINES = Object.freeze(['translator', 'claude']);
export const engineOf = settings => (isObject(settings) && settings.coach_engine === 'claude' ? 'claude' : 'translator');
// The line under the Claude choice from GET /coach?claude=1 (`claude_ready`, `claude_reason`): an English dictionary key.
const CLAUDE_STATES = {
  checking: 'Checking Claude on the computer that keeps your coach…',
  away: 'The computer that keeps your coach cannot be reached right now',
  no_sdk: 'Claude Code is not installed on this computer',
  signed_out: 'Claude is not signed in on this computer',
  quota: 'Your Claude plan has reached its usage limit for now',
  unsafe: 'Claude offered tools the coach does not allow',
  failed: 'Claude could not answer',
};
export function claudeState(page) {
  if (!isObject(page)) return { state: 'checking', text: CLAUDE_STATES.checking };
  if (page.offline || page.home_older || page.claude_reason === 'away') return { state: 'away', text: CLAUDE_STATES.away };
  if (page.claude_ready === true) return { state: 'ready', text: 'Claude is ready on the computer that keeps your coach' };
  if (page.claude_ready === false) {
    const reason = CLAUDE_STATES[page.claude_reason] && page.claude_reason !== 'checking' && page.claude_reason !== 'away' ? page.claude_reason : 'failed';
    return { state: reason, text: CLAUDE_STATES[reason] };
  }
  return { state: 'checking', text: CLAUDE_STATES.checking };
}
