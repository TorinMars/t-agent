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

// 下载固定版本的 frp 发行包，用发行页的 SHA-256 清单校验后，只取出 frpc 放到 <binDir>/frpc。
async function installFrpc({
  binDir, version = FRP_VERSION, base = process.env.T_AGENT_FRP_DOWNLOAD_BASE || DEFAULT_BASE,
  platform = process.platform, arch = process.arch, download = fetchBuffer, extract = runTar,
}) {
  const osName = OS_NAMES[platform];
  const archName = ARCH_NAMES[arch];
  if (!osName || !archName) throw new FrpInstallError('FRP_INSTALL_UNSUPPORTED', `暂不支持自动安装到 ${platform}/${arch}，请手动安装 frpc`);
  const root = `${String(base).replace(/\/+$/, '')}/v${version}`;
  const name = `frp_${version}_${osName}_${archName}`;
  const archiveName = `${name}.tar.gz`;

  let archive, sums;
  try {
    sums = String(await download(`${root}/frp_sha256_checksums.txt`));
    archive = await download(`${root}/${archiveName}`);
  } catch {
    throw new FrpInstallError('FRP_INSTALL_DOWNLOAD_FAILED', '下载 frp 失败，请检查网络；无法访问 GitHub 时可设置 T_AGENT_FRP_DOWNLOAD_BASE 指向镜像');
  }
  const line = sums.split(/\r?\n/).map(item => item.trim().split(/\s+/)).find(parts => parts[1] === archiveName);
  const expected = line && /^[0-9a-f]{64}$/i.test(line[0]) ? line[0].toLowerCase() : '';
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (!expected || expected !== actual) throw new FrpInstallError('FRP_INSTALL_CHECKSUM_FAILED', 'frp 安装包校验失败，已放弃安装');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-install-'));
  try {
    const file = path.join(work, archiveName);
    fs.writeFileSync(file, archive);
    try {
      await extract(['-xzf', file, '-C', work, '--strip-components=1', `${name}/frpc`]);
    } catch {
      throw new FrpInstallError('FRP_INSTALL_EXTRACT_FAILED', '解压 frp 安装包失败');
    }
    const extracted = path.join(work, 'frpc');
    if (!fs.existsSync(extracted)) throw new FrpInstallError('FRP_INSTALL_EXTRACT_FAILED', '安装包里没有 frpc');
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, 'frpc');
    // 先写临时文件再改名，避免覆盖正在运行的 frpc 时出现半截文件。
    fs.copyFileSync(extracted, `${target}.new`);
    fs.chmodSync(`${target}.new`, 0o755);
    fs.renameSync(`${target}.new`, target);
    return { path: target, version };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 发布包名里的系统/架构；不支持自动安装的平台返回 null。
function platformTarget(platform = process.platform, arch = process.arch) {
  return OS_NAMES[platform] && ARCH_NAMES[arch] ? { os: OS_NAMES[platform], arch: ARCH_NAMES[arch] } : null;
}

module.exports = { installFrpc, platformTarget, FrpInstallError, FRP_VERSION, DEFAULT_BASE };
