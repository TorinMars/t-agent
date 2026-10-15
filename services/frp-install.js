const axios = require('axios');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRP_VERSION = '0.61.1';
const DEFAULT_BASE = 'https://github.com/fatedier/frp/releases/download';
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const OS_NAMES = { darwin: 'darwin', linux: 'linux' };
const ARCH_NAMES = { x64: 'amd64', arm64: 'arm64', arm: 'arm' };

class FrpInstallError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function fetchBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: MAX_ARCHIVE_BYTES, maxRedirects: 5 });
  return Buffer.from(response.data);
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { timeout: 60_000 }, error => (error ? reject(error) : resolve()));
  });
}

// Download a pinned frp release, verify it against the SHA-256 list on the release page, and extract only frpc into <binDir>/frpc.
async function installFrpc({
  binDir, version = FRP_VERSION, base = process.env.T_AGENT_FRP_DOWNLOAD_BASE || DEFAULT_BASE,
  platform = process.platform, arch = process.arch, download = fetchBuffer, extract = runTar,
}) {
  const osName = OS_NAMES[platform];
  const archName = ARCH_NAMES[arch];
  if (!osName || !archName) throw new FrpInstallError('FRP_INSTALL_UNSUPPORTED', `Automatic install is not supported on ${platform}/${arch}; please install frpc manually`);
  const root = `${String(base).replace(/\/+$/, '')}/v${version}`;
  const name = `frp_${version}_${osName}_${archName}`;
  const archiveName = `${name}.tar.gz`;

  let archive, sums;
  try {
    sums = String(await download(`${root}/frp_sha256_checksums.txt`));
    archive = await download(`${root}/${archiveName}`);
  } catch {
    throw new FrpInstallError('FRP_INSTALL_DOWNLOAD_FAILED', 'Downloading frp failed; check the network. If GitHub is unreachable, set T_AGENT_FRP_DOWNLOAD_BASE to a mirror');
  }
  const line = sums.split(/\r?\n/).map(item => item.trim().split(/\s+/)).find(parts => parts[1] === archiveName);
  const expected = line && /^[0-9a-f]{64}$/i.test(line[0]) ? line[0].toLowerCase() : '';
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (!expected || expected !== actual) throw new FrpInstallError('FRP_INSTALL_CHECKSUM_FAILED', 'The frp package failed verification; installation aborted');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-install-'));
  try {
    const file = path.join(work, archiveName);
    fs.writeFileSync(file, archive);
    try {
      await extract(['-xzf', file, '-C', work, '--strip-components=1', `${name}/frpc`]);
    } catch {
      throw new FrpInstallError('FRP_INSTALL_EXTRACT_FAILED', 'Failed to extract the frp package');
    }
    const extracted = path.join(work, 'frpc');
    if (!fs.existsSync(extracted)) throw new FrpInstallError('FRP_INSTALL_EXTRACT_FAILED', 'The package does not contain frpc');
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, 'frpc');
    // Write a temporary file first and then rename, so overwriting a running frpc never leaves a half-written file.
    fs.copyFileSync(extracted, `${target}.new`);
    fs.chmodSync(`${target}.new`, 0o755);
    fs.renameSync(`${target}.new`, target);
    return { path: target, version };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// OS/architecture in the release package name; returns null for platforms that cannot be installed automatically.
function platformTarget(platform = process.platform, arch = process.arch) {
  return OS_NAMES[platform] && ARCH_NAMES[arch] ? { os: OS_NAMES[platform], arch: ARCH_NAMES[arch] } : null;
}

module.exports = { installFrpc, platformTarget, FrpInstallError, FRP_VERSION, DEFAULT_BASE };
