const fs = require('fs');
const path = require('path');

function normalizeAgentPath(file) {
  return file && path.basename(file) === 'AGENT.md' ? path.join(path.dirname(file), 'AGENTS.md') : file;
}

function migrateAgentFile(file) {
  if (path.basename(file) !== 'AGENTS.md') return;
  const legacy = path.join(path.dirname(file), 'AGENT.md');
  try {
    // Copy exclusively before removing the legacy file; an existing AGENTS.md wins.
    try { fs.copyFileSync(legacy, file, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    fs.unlinkSync(legacy);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function ensureClaude(root) {
  const file = path.join(root, 'CLAUDE.md');
  try { fs.writeFileSync(file, '@AGENTS.md\n', { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const content = fs.readFileSync(file, 'utf8');
    if (!/^\s*@AGENTS\.md\s*$/m.test(content)) fs.appendFileSync(file, '\n@AGENTS.md\n');
  }
}

function pathOverrides(input, previous = {}) {
  const values = {};
  for (const field of ['technical_path', 'readme_path', 'agent_path']) {
    const raw = input[field] === undefined ? previous[field] : input[field];
    if (raw != null && typeof raw !== 'string') throw Object.assign(new Error(`${field} must be an absolute Markdown path`), { statusCode: 400 });
    const value = raw?.trim() || null;
    if (value && (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.md')) {
      throw Object.assign(new Error(`${field} must be an absolute Markdown path`), { statusCode: 400 });
    }
    values[field] = field === 'agent_path' ? normalizeAgentPath(value) : value;
  }
  return values;
}

function documentPath(task, kind) {
  const field = { technical: 'technical_path', readme: 'readme_path', agent: 'agent_path' }[kind];
  if (field && task[field]) return kind === 'agent' ? normalizeAgentPath(task[field]) : task[field];
  const root = task.work_dir || (task.md_path && path.dirname(task.md_path));
  if (kind === 'technical') {
    if (root && (!task.md_path || path.basename(task.md_path) === 'DESIGN.md')) return path.join(root, 'DESIGN.md');
    return task.md_path || null;
  }
  if (!root) return null;
  if (kind === 'readme') return path.join(root, 'README.md');
  if (kind === 'agent') return path.join(root, 'AGENTS.md');
  return null;
}

function ensureDocument(task, kind) {
  const file = documentPath(task, kind);
  if (!file) return null;
  const initial = kind === 'technical' ? `# ${task.title}\n`
    : kind === 'readme' ? `# ${task.title}\n\n## 项目说明\n\n` : '# AGENTS.md\n\n## 工作约定\n\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (kind === 'agent') migrateAgentFile(file);
  // Exclusive creation prevents overwriting a file created concurrently.
  try { fs.writeFileSync(file, initial, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (kind === 'agent') {
    const root = task.work_dir || (task.md_path && path.dirname(task.md_path)) || path.dirname(file);
    const standard = path.join(root, 'AGENTS.md');
    if (file !== standard) ensureDocument({ ...task, work_dir: root, agent_path: null }, 'agent');
    else ensureClaude(root);
  }
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
  return task ? { ...task, agent_path: normalizeAgentPath(task.agent_path), md_path: documentPath(task, 'technical') } : task;
}
module.exports = { pathOverrides, resolveTask, documentPath, ensureDocument, ensureDocuments, updatedTechnicalPath };
