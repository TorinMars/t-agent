const fs = require('fs');
const path = require('path');

// Relative files referenced from a task's technical document (images, linked files).
// Returns { file } or { status, error }; messages match the original local route.
function resolveAsset(task, rel) {
  if (!task || !task.md_path) return { status: 404, error: 'No md_path' };
  if (!rel || typeof rel !== 'string' || rel.includes('..')) return { status: 400, error: 'Invalid path' };
  const dir = path.dirname(task.md_path);
  const file = path.join(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) return { status: 400, error: 'Invalid path' };
  if (!fs.existsSync(file)) return { status: 404, error: 'File not found' };
  return { file };
}

// Pre-flight check used by the task form: is this an existing absolute .md file?
function validateMdPath(mdPath) {
  if (!mdPath) return { status: 400, error: 'md_path is required' };
  if (!mdPath.startsWith('/') && !(/^[A-Za-z]:\\/.test(mdPath))) return { valid: false, error: 'Must be an absolute path' };
  if (!mdPath.endsWith('.md')) return { valid: false, error: 'Must end with .md' };
  if (!fs.existsSync(mdPath)) return { valid: false, error: 'File does not exist' };
  return { valid: true, filename: path.basename(mdPath, '.md'), work_dir: path.dirname(mdPath) };
}

module.exports = { resolveAsset, validateMdPath };
