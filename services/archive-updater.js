const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { validateVersionManifest } = require('../lib/version-utils');

const PRESERVED_ROOT_ENTRIES = new Set(['.env', '.git', 'data', 'logs', 'node_modules', 'tasks']);

function validateRepository(repository) {
  const value = String(repository || '');
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('INVALID_UPDATE_REPOSITORY');
  }
  return value;
}

function validateRef(ref) {
  const value = String(ref || '');
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.startsWith('/') || value.endsWith('/')) {
    throw new Error('INVALID_UPDATE_REF');
  }
  return value;
}

function githubArchiveUrl(repository, ref) {
  return `https://github.com/${validateRepository(repository)}/archive/refs/heads/${validateRef(ref)}.tar.gz`;
}

function run(command, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(`ARCHIVE_${command.toUpperCase()}_FAILED`);
        wrapped.details = String(stderr || stdout || '').trim().slice(-2000);
        reject(wrapped);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function stageGithubArchive({ repository, ref, expectedVersion }) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-update-'));
  const archivePath = path.join(temporaryRoot, 'release.tar.gz');
  const extractPath = path.join(temporaryRoot, 'release');
  fs.mkdirSync(extractPath);
  try {
    await run('curl', ['-fsSL', '--retry', '2', githubArchiveUrl(repository, ref), '-o', archivePath]);
    await run('tar', ['-xzf', archivePath, '-C', extractPath]);
    const roots = fs.readdirSync(extractPath, { withFileTypes: true }).filter(entry => entry.isDirectory());
    if (roots.length !== 1) throw new Error('INVALID_UPDATE_ARCHIVE');
    const sourceRoot = path.join(extractPath, roots[0].name);
    for (const required of ['VERSION.json', 'package.json', 'server.js']) {
      if (!fs.existsSync(path.join(sourceRoot, required))) throw new Error('INVALID_UPDATE_ARCHIVE');
    }
    const manifest = validateVersionManifest(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'VERSION.json'), 'utf8')));
    if (manifest.app_version !== expectedVersion) throw new Error('VERSION_SOURCE_MISMATCH');
    return {
      sourceRoot,
      manifest,
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function copyRelease(sourceRoot, projectRoot) {
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (PRESERVED_ROOT_ENTRIES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('UNSAFE_UPDATE_ARCHIVE');
    fs.cpSync(path.join(sourceRoot, entry.name), path.join(projectRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

module.exports = {
  PRESERVED_ROOT_ENTRIES,
  copyRelease,
  githubArchiveUrl,
  stageGithubArchive,
  validateRef,
  validateRepository,
};
