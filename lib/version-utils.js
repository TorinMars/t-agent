const GITHUB_VERSION_HOSTS = new Set(['raw.githubusercontent.com', 'api.github.com']);

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error('INVALID_SEMVER');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    if (a.prerelease[i] === b.prerelease[i]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[i]);
    const bNumber = /^\d+$/.test(b.prerelease[i]);
    if (aNumber && bNumber) return Number(a.prerelease[i]) > Number(b.prerelease[i]) ? 1 : -1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[i] > b.prerelease[i] ? 1 : -1;
  }
  return 0;
}

function validateVersionManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_MANIFEST');
  if (!parseSemver(value.app_version)) throw new Error('INVALID_APP_VERSION');
  for (const key of ['api_version', 'schema_version', 'min_remote_api_version', 'max_remote_api_version']) {
    if (!Number.isInteger(value[key]) || value[key] < 0) throw new Error(`INVALID_${key.toUpperCase()}`);
  }
  if (value.min_remote_api_version > value.max_remote_api_version) throw new Error('INVALID_REMOTE_API_RANGE');
  if (value.published_at !== undefined && (typeof value.published_at !== 'string' || Number.isNaN(Date.parse(value.published_at)))) {
    throw new Error('INVALID_PUBLISHED_AT');
  }
  if (value.release_url !== undefined) {
    let releaseUrl;
    try { releaseUrl = new URL(value.release_url); } catch { throw new Error('INVALID_RELEASE_URL'); }
    if (releaseUrl.protocol !== 'https:' || releaseUrl.hostname !== 'github.com') throw new Error('INVALID_RELEASE_URL');
  }
  return value;
}

function validateGithubVersionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_VERSION_URL'); }
  if (url.protocol !== 'https:' || !GITHUB_VERSION_HOSTS.has(url.hostname)) throw new Error('UNTRUSTED_VERSION_URL');
  if (url.username || url.password || url.port) throw new Error('UNTRUSTED_VERSION_URL');
  return url;
}

function githubVersionUrlFromRemote(remote, branch = 'main') {
  if (!remote || !/^[A-Za-z0-9._/-]+$/.test(branch)) return null;
  const match = String(remote).match(/^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/refs/heads/${branch}/VERSION.json`;
}

function githubVersionUrlFromRepository(repository, ref = 'main') {
  const repositoryValue = String(repository || '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repositoryValue)) return null;
  if (repositoryValue.split('/').some(part => part === '.' || part === '..')) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(String(ref || '')) || String(ref).includes('..')) return null;
  return `https://raw.githubusercontent.com/${repositoryValue}/refs/heads/${ref}/VERSION.json`;
}

module.exports = {
  compareSemver,
  githubVersionUrlFromRemote,
  githubVersionUrlFromRepository,
  parseSemver,
  validateGithubVersionUrl,
  validateVersionManifest,
};
