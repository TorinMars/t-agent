// Import of a SELF-ATTENTION task list (its TASKS.md) into T-Attention: `t-attention import-tasks-md <file> [--dry-run] [--source S]`.
// See "T-Attention: CLI and Claude listener" in DESIGN.md. Node built-ins only, like lib/attention-client.js, and it talks to the server only
// through that client (so it runs on any machine with the CLI's URL and token).
//
// TASKS.md: tables (## Needs Your Attention, ## Open, ## Completed — Confirmed) with the columns
// | ID | Task | Status | Updated | Notes | Attention | Custom Status | Result | Parent |, cells with \| for a literal pipe, rows that may miss
// trailing columns, and below a line "## Status history" one line per change: "- YYYY-MM-DD HH:MM · <ID> · <what>".
//
// Each row becomes the item with external_ref "<source>:<ID>" (PUT by-ref, so a second run updates instead of duplicating). Parents are set in a
// second pass, once every row exists. The history lines of a task become timeline notes the first time it is imported (meta.history_imported).

const SOURCE = 'self-attention';
const HISTORY_HEADING = '## Status history';
const DEFAULT_COLUMNS = ['id', 'task', 'status', 'updated', 'notes', 'attention', 'custom_status', 'result', 'parent'];
const COLUMN_KEYS = { id: 'id', task: 'task', status: 'status', updated: 'updated', notes: 'notes', attention: 'attention', customstatus: 'custom_status', result: 'result', parent: 'parent' };
// The prompt SELF-ATTENTION sets on every task that enters "Completed — Awaiting Confirmation" ("please confirm it is done"); on a review row
// it says nothing the review status does not, so it is dropped.
const CONFIRM_PROMPT = '\u8bf7\u786e\u8ba4\u662f\u5426\u5b8c\u6210';
const STATUS_MAP = { notstarted: 'todo', inprogress: 'working', awaitingresponse: 'working', completedawaitingconfirmation: 'review', completedconfirmed: 'done' };
// The server's limits (services/attention.js LIMITS); longer values are cut with an ellipsis instead of failing the row.
const LIMITS = { title: 300, notes: 20000, attentionReason: 500, customStatus: 100, result: 500, note: 500 };
const HISTORY_CAP = 50; // history notes per task (the newest are kept)
const HISTORY_LINE = /^-\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)\s+\u00b7\s+([A-Za-z]*\d+)\s+\u00b7\s+(.+)$/;

const letters = value => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const flat = value => String(value || '').replace(/\s+/g, ' ').trim();

// Cuts to max UTF-16 units (the server counts String length), never inside a surrogate pair.
function cut(value, max) {
  const text = String(value || '');
  if (text.length <= max) return text;
  let out = text.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return `${out}\u2026`;
}

// The cells of one table line: | splits, \| is a literal pipe, the pieces outside the outer pipes are dropped.
function splitRow(line) {
  const cells = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { current += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(current); current = ''; continue; }
    current += ch;
  }
  cells.push(current);
  if (line.trimStart().startsWith('|')) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map(cell => cell.trim());
}

// -> { rows: [{ id, task, status, updated, notes, attention, custom_status, result, parent, section, line }], history: Map(ID upper -> [{ at, text }]),
//      hasHistory, warnings }
function parseTasksMd(text) {
  const lines = String(text || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  const historyAt = lines.findIndex(line => line.trim() === HISTORY_HEADING);
  const tableLines = historyAt === -1 ? lines : lines.slice(0, historyAt);
  const rows = [];
  const warnings = [];
  const seen = new Set();
  let section = '';
  let columns = DEFAULT_COLUMNS;
  tableLines.forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('## ')) { section = line.slice(3).trim(); return; }
    if (!line.startsWith('|')) return;
    if (/^\|\s*:?-{2,}/.test(line)) return; // the rule under a header
    const cells = splitRow(line);
    if (/^\|\s*ID\s*\|/i.test(line)) { columns = cells.map(name => COLUMN_KEYS[letters(name)] || null); return; }
    const row = { section, line: index + 1 };
    for (const key of DEFAULT_COLUMNS) row[key] = '';
    columns.forEach((key, i) => { if (key) row[key] = cells[i] || ''; });
    if (!row.id) { warnings.push(`Line ${index + 1}: a row without an ID was skipped`); return; }
    if (seen.has(row.id.toUpperCase())) { warnings.push(`Line ${index + 1}: ${row.id} appears twice; the later row was skipped`); return; }
    seen.add(row.id.toUpperCase());
    rows.push(row);
  });
  const history = new Map();
  if (historyAt !== -1) {
    for (const raw of lines.slice(historyAt + 1)) {
      const match = HISTORY_LINE.exec(raw.trim());
      if (!match) continue;
      const key = match[2].toUpperCase();
      if (!history.has(key)) history.set(key, []);
      history.get(key).push({ at: match[1].replace('T', ' '), text: match[3].trim() });
    }
  }
  return { rows, history, hasHistory: historyAt !== -1, warnings };
}

// One row -> the fields of its item, or { skip: reason }.
function mapRow(row, { source = SOURCE } = {}) {
  const title = cut(flat(row.task), LIMITS.title);
  if (!title) return { skip: 'no task name' };
  const warnings = [];
  const statusKey = letters(row.status);
  let status = STATUS_MAP[statusKey];
  if (!status) { status = 'todo'; warnings.push(`${row.id}: unknown status "${row.status}", imported as todo`); }
  let customStatus = flat(row.custom_status);
  if (statusKey === 'awaitingresponse' && !customStatus) customStatus = 'Awaiting Response';
  let attention = flat(row.attention);
  if (status === 'review' && attention === CONFIRM_PROMPT) attention = '';
  if (attention && status !== 'done') status = 'waiting_user';
  return {
    fields: {
      title,
      status,
      notes: row.notes ? cut(row.notes, LIMITS.notes) : null,
      attention_reason: attention ? cut(attention, LIMITS.attentionReason) : null,
      custom_status: customStatus ? cut(customStatus, LIMITS.customStatus) : null,
      result: flat(row.result) ? cut(flat(row.result), LIMITS.result) : null,
      source,
    },
    warnings,
  };
}

// The plan of an import, without any request: per row its ref, fields, parent and history notes.
function planImport(parsed, { source = SOURCE } = {}) {
  const byId = new Map(parsed.rows.map(row => [row.id.toUpperCase(), row]));
  const warnings = [...parsed.warnings];
  const entries = [];
  const skipped = [];
  for (const row of parsed.rows) {
    const mapped = mapRow(row, { source });
    if (mapped.skip) { skipped.push({ id: row.id, reason: mapped.skip }); continue; }
    warnings.push(...mapped.warnings);
    let parent = null;
    if (row.parent) {
      const parentRow = byId.get(row.parent.toUpperCase());
      if (!parentRow) warnings.push(`${row.id}: parent ${row.parent} is not in the file; imported without a parent`);
      else if (parentRow.id.toUpperCase() === row.id.toUpperCase()) warnings.push(`${row.id}: it names itself as parent; imported without a parent`);
      else parent = parentRow.id;
    }
    const lines = parsed.history.get(row.id.toUpperCase()) || [];
    const kept = lines.slice(-HISTORY_CAP);
    if (lines.length > kept.length) warnings.push(`${row.id}: only the newest ${HISTORY_CAP} of its ${lines.length} history lines are imported`);
    entries.push({
      id: row.id,
      ref: `${source}:${row.id}`,
      parent,
      parentRef: parent ? `${source}:${parent}` : null,
      fields: mapped.fields,
      meta: { self_attention_id: row.id, imported_updated: row.updated || null },
      history: kept.map(entry => cut(`History ${entry.at}: ${entry.text}`, LIMITS.note)),
    });
  }
  // A parent row that was skipped cannot be a parent.
  const planned = new Set(entries.map(entry => entry.id));
  for (const entry of entries) {
    if (entry.parent && !planned.has(entry.parent)) {
      warnings.push(`${entry.id}: parent ${entry.parent} was skipped; imported without a parent`);
      entry.parent = null;
      entry.parentRef = null;
    }
  }
  return { source, entries, skipped, warnings };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs the plan against the API (lib/attention-client.js createClient). A row the server refuses (400) is reported and the rest goes on; an
// auth, network or server error stops the import. 429 answers are waited out (Retry-After, at most 10 times per request).
async function runImport(api, plan, { wait = sleep } = {}) {
  const call = async fn => {
    for (let attempt = 0; ; attempt += 1) {
      try { return await fn(); } catch (error) {
        if (error && error.status === 429 && attempt < 10) { await wait(Math.max(1, error.retryAfter || 5) * 1000); continue; }
        throw error;
      }
    }
  };
  const refused = error => error && (error.kind === 'invalid' || error.kind === 'conflict');
  const existing = new Map();
  let top = 0;
  for (const item of await call(() => api.list({ include_done: 1, limit: 1000 }))) {
    if (item.external_ref) existing.set(item.external_ref, item);
    if (Number.isFinite(item.sort_order)) top = Math.max(top, item.sort_order);
  }
  const results = [];
  const skipped = [...plan.skipped];
  const warnings = [...plan.warnings];
  const count = plan.entries.length;
  // Pass 1: every row, without its parent. New rows get sort_order values above every item, in the file's order (the first row highest).
  for (const [index, entry] of plan.entries.entries()) {
    const before = existing.get(entry.ref) || null;
    const meta = { ...((before && before.meta) || {}), ...entry.meta };
    const body = { ...entry.fields, meta };
    if (!entry.parent) body.parent_id = null;
    if (!before) body.sort_order = top + (count - index);
    let answer;
    try { answer = await call(() => api.upsertByRef(entry.ref, body)); } catch (error) {
      if (!refused(error)) throw error;
      skipped.push({ id: entry.id, reason: error.message });
      continue;
    }
    results.push({ entry, item: answer.item, created: answer.created, history: !(before && before.meta && before.meta.history_imported), meta });
  }
  // Timeline notes of the history, oldest first, only for tasks whose history was not imported yet.
  let notes = 0;
  for (const result of results) {
    if (!result.history) continue;
    for (const text of result.entry.history) {
      await call(() => api.upsertByRef(result.entry.ref, { source: plan.source, activity: { kind: 'note', text } }));
      notes += 1;
    }
  }
  // Pass 2: parents (every item exists now) and the history mark.
  const imported = new Set(results.map(result => result.entry.id));
  for (const result of results) {
    const body = {};
    if (result.entry.parent) {
      if (imported.has(result.entry.parent)) body.parent_ref = result.entry.parentRef;
      else warnings.push(`${result.entry.id}: parent ${result.entry.parent} was not imported; left without a parent`);
    }
    if (result.history) body.meta = { ...result.meta, history_imported: true };
    if (!Object.keys(body).length) continue;
    try { result.item = (await call(() => api.upsertByRef(result.entry.ref, { source: plan.source, ...body }))).item; } catch (error) {
      if (!refused(error)) throw error;
      warnings.push(`${result.entry.id}: parent ${result.entry.parent} not set: ${error.message}`);
      if (body.meta) result.item = (await call(() => api.upsertByRef(result.entry.ref, { source: plan.source, meta: body.meta }))).item;
    }
  }
  return {
    created: results.filter(result => result.created).length,
    updated: results.filter(result => !result.created).length,
    skipped,
    notes,
    warnings,
    rows: results.map(result => ({ id: result.entry.id, ref: result.entry.ref, item_id: result.item.id, created: result.created, status: result.item.status, parent_id: result.item.parent_id ?? null, title: result.item.title })),
  };
}

module.exports = { SOURCE, CONFIRM_PROMPT, HISTORY_CAP, LIMITS, parseTasksMd, splitRow, mapRow, planImport, runImport };
