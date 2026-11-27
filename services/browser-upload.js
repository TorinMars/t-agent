// The files of `tcli browser upload` ("Upload" in docs/design/browser-extension.md), checked by the bridge before input.upload reaches the
// extension: Chrome runs on this computer and reads the files itself (CDP DOM.setFileInputFiles takes paths, no bytes pass the socket), so
// the server makes sure each path is an absolute path to a regular file (symlinks resolved), within the size limits, and not a credential
// (an SSH or cloud key, a .env file): a website must never get those through an agent. tcli sends only the files named on its command line.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_FILES = 20;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
// Folders under the home folder and file names that hold credentials.
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', path.join('.config', 'gh'), '.tagent'];
const SECRET_NAME = /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.*\.(pem|p12|pfx)|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

class UploadError extends Error {}

// Returns the real paths, or throws an UploadError whose message names the file.
function checkUploadFiles(files, { home = os.homedir() } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new UploadError(`files must be a list of 1 to ${MAX_FILES} paths`);
  let total = 0;
  const homeReal = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
  return files.map(file => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\u0000') || file.length > 4096) throw new UploadError('files must be absolute paths');
    let real;
    let stat;
    try {
      real = fs.realpathSync(file);
      stat = fs.statSync(real);
    } catch { throw new UploadError(`${file} does not exist`); }
    if (!stat.isFile()) throw new UploadError(`${file} is not a file`);
    if (stat.size > MAX_FILE_BYTES) throw new UploadError(`${file} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);
    total += stat.size;
    if (total > MAX_TOTAL_BYTES) throw new UploadError(`The files are larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MiB together`);
    const inside = path.relative(homeReal, real);
    const secretDir = !inside.startsWith('..') && !path.isAbsolute(inside) && SECRET_DIRS.some(dir => inside === dir || inside.startsWith(`${dir}${path.sep}`));
    if (secretDir || SECRET_NAME.test(path.basename(real)) || SECRET_NAME.test(path.basename(file))) throw new UploadError(`${file} looks like a credential; T-Agent does not upload it to a website`);
    return real;
  });
}

module.exports = { checkUploadFiles, UploadError, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
