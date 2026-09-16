const { isDeepStrictEqual } = require('node:util');

function runtimeMetadata(file, text) {
  const value = JSON.parse(text);
  if (file === 'VERSION.json') {
    delete value.app_version;
    delete value.published_at;
    delete value.release_url;
  } else {
    delete value.version;
    if (file === 'package-lock.json' && value.packages?.['']) delete value.packages[''].version;
  }
  return value;
}

// Compare against the running process's startup commit, not just the current
// checkout: an earlier failed update may already have changed server files.
async function requiresRestart(execGit, runningCommit, target) {
  if (!runningCommit) return true;
  const files = (await execGit(['diff', '--name-only', '-z', runningCommit, target])).split('\0').filter(Boolean);
  for (const file of files) {
    if (/^(public\/|docs\/|test\/|scripts\/test-)/.test(file) || /^[^/]+\.md$/i.test(file)) continue;
    if (!['VERSION.json', 'package.json', 'package-lock.json'].includes(file)) return true;
    try {
      const previous = runtimeMetadata(file, await execGit(['show', `${runningCommit}:${file}`]));
      const next = runtimeMetadata(file, await execGit(['show', `${target}:${file}`]));
      if (!isDeepStrictEqual(previous, next)) return true;
    } catch { return true; }
  }
  return false;
}

module.exports = { requiresRestart };
