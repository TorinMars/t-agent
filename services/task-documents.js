const fs = require('fs');
const path = require('path');

function pathOverrides(input, previous = {}) {
  const values = {};
  for (const field of ['technical_path', 'readme_path', 'agent_path']) {
    const raw = input[field] === undefined ? previous[field] : input[field];
    if (raw != null && typeof raw !== 'string') throw Object.assign(new Error(`${field} must be an absolute Markdown path`), { statusCode: 400 });
    const value = raw?.trim() || null;
    if (value && (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.md')) {
      throw Object.assign(new Error(`${field} must be an absolute Markdown path`), { statusCode: 400 });
    }
    values[field] = value;
  }
  return values;
}

function documentPath(task, kind) {
  const field = { technical: 'technical_path', readme: 'readme_path', agent: 'agent_path' }[kind];
  if (field && task[field]) return task[field];
  const root = task.work_dir || (task.md_path && path.dirname(task.md_path));
  if (kind === 'technical') {
    if (root && (!task.md_path || path.basename(task.md_path) === 'DESIGN.md')) return path.join(root, 'DESIGN.md');
    return task.md_path || null;
  }
  if (!root) return null;
  if (kind === 'readme') return path.join(root, 'README.md');
  if (kind === 'agent') return path.join(root, 'AGENT.md');
  return null;
}

function ensureDocument(task, kind) {
  const file = documentPath(task, kind);
  if (!file) return null;
  const initial = kind === 'technical' ? `# ${task.title}\n`
    : kind === 'readme' ? `# ${task.title}\n\n## 项目说明\n\n` : '# AGENT.md\n\n## 工作约定\n\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Exclusive creation prevents overwriting a file created concurrently.
  try { fs.writeFileSync(file, initial, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return file;
}
function ensureDocuments(task) {
  for (const kind of ['technical', 'readme', 'agent']) ensureDocument(task, kind);
}
function updatedTechnicalPath(task, workDir, requestedPath) {
  const followsWorkDir = !task.md_path || path.basename(task.md_path) === 'DESIGN.md';
  if (!requestedPath || path.basename(requestedPath) === 'DESIGN.md' || (requestedPath === task.md_path && followsWorkDir)) {
    return workDir ? path.join(workDir, 'DESIGN.md') : requestedPath || task.md_path;
  }
  return requestedPath;
}
function resolveTask(task) {
  return task ? { ...task, md_path: documentPath(task, 'technical') } : task;
}
module.exports = { pathOverrides, resolveTask, documentPath, ensureDocument, ensureDocuments, updatedTechnicalPath };
