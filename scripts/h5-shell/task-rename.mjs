// The rules of the Rename dialog of a task (TaskDialogs.jsx): the default folder name of a title and the parts of a folder path.

// The folder name a new task gets from its title: `titleToSlug` of routes/tasks.js and services/engine-tasks.js (spaces become '-', characters other than
// letters, digits, CJK ideographs, '-', '_' and '.' go, no '-' at either end; 'task' when nothing is left).
export function titleToSlug(title) {
  return String(title || '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_.]/g, '')
    .replace(/^-+|-+$/g, '') || 'task';
}

// { parent, name, separator } of an absolute folder path (POSIX or Windows), without a trailing separator; null for anything else.
export function folderParts(workDir) {
  let text = String(workDir || '');
  while (text.length > 1 && /[\\/]$/.test(text)) text = text.slice(0, -1);
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (cut < 0 || cut === text.length - 1) return null;
  const separator = text[cut];
  return { parent: text.slice(0, cut) || separator, name: text.slice(cut + 1), separator };
}

// The new path: the same parent, the given name.
export function joinFolder(parts, name) {
  if (!parts) return '';
  return parts.parent.endsWith(parts.separator) ? `${parts.parent}${name}` : `${parts.parent}${parts.separator}${name}`;
}

// Whether the folder still has the name its title gave it, so renaming it with the title is offered at once (otherwise it is one tap further away).
export function folderFollowsTitle(workDir, title) {
  const parts = folderParts(workDir);
  return Boolean(parts) && parts.name === titleToSlug(String(title || '').trim());
}

// What the server takes as a folder name: one plain segment (services/task-rename.js `checkName`); the text of the problem, or '' when it is fine.
export function folderNameProblem(name) {
  const value = String(name || '');
  if (!value.trim()) return 'Enter a folder name';
  if (value !== value.trim()) return 'Remove the spaces at the start and end';
  if (value === '.' || value === '..' || /[/\\]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return 'Enter a folder name without / or \\';
  if (new TextEncoder().encode(value).length > 255) return 'The folder name is too long';
  return '';
}
