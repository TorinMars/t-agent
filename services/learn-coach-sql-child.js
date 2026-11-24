// The child process of the English coach's SQL tool (services/learn-coach-sql.js; "Security of the SQL tool" in docs/design/learn-english-coach.md).
// It gets the bytes of a snapshot that holds only the coach_* tables of one owner and one checked query, opens the snapshot read-only in memory,
// refuses a statement that does not only read, and answers { columns, rows, truncated } or { error }. The parent kills it
// after the time limit. It never opens a file.
const Database = require('better-sqlite3');

process.once('message', ({ snapshot, query, maxRows, maxChars, maxCell }) => {
  let answer;
  try {
    const db = new Database(Buffer.from(snapshot), { readonly: true });
    const statement = db.prepare(query);
    if (!statement.reader) throw new Error('Only a query that reads is allowed');
    const columns = statement.columns().map(column => column.name);
    const rows = [];
    let size = 2;
    let truncated = false;
    for (const raw of statement.raw(true).iterate()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const row = raw.map(value => {
        if (typeof value === 'bigint') return Number(value);
        if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
        if (typeof value === 'string' && value.length > maxCell) { truncated = true; return `${value.slice(0, maxCell)}…[cut]`; }
        return value;
      });
      size += JSON.stringify(row).length + 1;
      if (size > maxChars) { truncated = true; break; }
      rows.push(row);
    }
    answer = { columns, rows, truncated };
  } catch (error) {
    answer = { error: String((error && error.message) || error).slice(0, 300) };
  }
  process.send(answer, () => process.exit(0));
});
process.send({ ready: true });
