'use strict';
// The working directory of the single user (`users.work_dir`): the root folder for the md files of new tasks. One place for the browser's
// PUT /auth/settings (routes/auth.js) and a linked device's PUT /v1/device-settings/auth/settings (routes/device-settings.js), so both check,
// create and save it the same way. Nothing here knows about sessions.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The folder in effect: the saved one, else TASKS_BASE_DIR, else ~/tasks.
const effectiveWorkDir = workDir => workDir || process.env.TASKS_BASE_DIR || path.join(os.homedir(), 'tasks');

const fault = (status, error) => Object.assign(new Error(error), { status, body: { error } });

// `value`: a path, or null / undefined / '' for the default. Returns the saved value (a trimmed path or null). Throws an error with `status` and
// `body` for a value that is not a string, or a folder that cannot be created.
function saveWorkDir(db, username, value) {
  if (value !== null && value !== undefined && typeof value !== 'string') throw fault(400, 'INVALID_WORK_DIRECTORY');
  const workDir = value ? value.trim() || null : null;
  if (workDir) {
    try { fs.mkdirSync(workDir, { recursive: true }); }
    catch (error) { throw fault(400, `Failed to create the working directory: ${error.message}`); }
  }
  db.prepare('UPDATE users SET work_dir = ? WHERE username = ?').run(workDir, username);
  return workDir;
}

module.exports = { effectiveWorkDir, saveWorkDir };
