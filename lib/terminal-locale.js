const { execFileSync } = require('child_process');

// Locales tried in order. Which ones exist differs per machine: macOS has no
// C.UTF-8 on older releases, minimal Linux installs often lack en_US/zh_CN.
const PREFERRED = ['C.UTF-8', 'en_US.UTF-8', 'zh_CN.UTF-8', 'en_GB.UTF-8', 'POSIX.UTF-8'];

const canon = name => String(name || '').toLowerCase().replace(/utf-8/g, 'utf8');
const isUtf8 = name => /utf-?8/i.test(String(name || ''));

let installed;
function installedLocales() {
  if (installed) return installed;
  try {
    const out = execFileSync('locale', ['-a'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    installed = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    installed = [];
  }
  return installed;
}

// Returns the best UTF-8 locale name for a terminal on this machine.
// `available` and `platform` are injectable for tests.
function pickUtf8Locale(env = process.env, available = installedLocales(), platform = process.platform) {
  const byCanon = new Map(available.map(name => [canon(name), name]));
  const existing = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8);
  if (existing && (!byCanon.size || byCanon.has(canon(existing)))) return existing;
  for (const name of PREFERRED) if (byCanon.has(canon(name))) return byCanon.get(canon(name));
  const anyUtf8 = available.find(isUtf8);
  if (anyUtf8) return anyUtf8;
  // `locale -a` unavailable or empty: macOS always ships en_US.UTF-8, glibc >= 2.35 ships C.UTF-8.
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

function utf8LocaleEnv(env, available, platform) {
  const name = pickUtf8Locale(env, available, platform);
  return { LANG: name, LC_ALL: name, LC_CTYPE: name };
}

module.exports = { pickUtf8Locale, utf8LocaleEnv };
