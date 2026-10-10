const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const panel = index.match(/<section class="file-sync-panel"[\s\S]*?<\/section>/)[0];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.setContent(`<body>${panel}<div id="modal-title"></div><div id="modal-body"></div></body>`);
    await page.addScriptTag({ content: `
      let syncState = { role: 'master', master_id: null, files: [], error: null,
        children: [{ id: 'node-123456', name: '附属节点', online: true, last_sync_at: '2026-10-10T07:00:00Z', last_seen_at: '2026-10-10T07:00:01Z', error: null }] };
      const servers = [{ id: 7, name: '远程节点', base_url: 'https://node.example' }];
      const API = {
        get: async url => url.endsWith('/servers') ? servers : syncState,
        put: async (url, body) => {
          if (url.endsWith('/path')) syncState = { ...syncState, files: syncState.files.map(file => file.path === body.path ? { ...file, path_override: body.local_path || null, local_path: body.local_path || file.default_path } : file) };
          else syncState = { ...syncState, files: body.files.map(path => ({ path, local_path: '/home/test/' + path.slice(2), default_path: '/home/test/' + path.slice(2), path_override: null, exists: true, version: 1 })) };
          return syncState;
        },
        post: async (url, body) => { if (url.endsWith('/connect')) syncState = { ...syncState, role: 'child', master_id: body.server_id }; return syncState; },
      };
      const Modal = { show(title, html) { document.getElementById('modal-title').textContent = title; document.getElementById('modal-body').innerHTML = html; }, hide() { document.getElementById('modal-body').replaceChildren(); } };
    ` });
    await page.addScriptTag({ path: path.join(root, 'public/js/file-sync.js') });
    await page.evaluate(() => { document.getElementById('file-sync-panel').hidden = false; FileSyncUI.setEngine({ base: '/api/file-sync', label: '默认', unavailable: null }); FileSyncUI.setActive(true); });
    await page.waitForFunction(() => document.getElementById('file-sync-role').textContent.includes('主服务器'));
    assert.match(await page.locator('#file-sync-children-body').textContent(), /附属节点.*在线/);
    await page.click('#file-sync-add');
    await page.fill('#sync-new-path', '~/.claude/settings.json');
    await page.click('#sync-new-save');
    await page.waitForFunction(() => document.querySelectorAll('#file-sync-body tr').length === 1);
    assert.match(await page.locator('#file-sync-body').textContent(), /\/home\/test\/\.claude\/settings.json/);
    await page.click('#file-sync-connect');
    await page.waitForFunction(() => document.getElementById('file-sync-role').textContent.includes('附属服务器'));
    assert.equal(await page.locator('#file-sync-add').isVisible(), false);
    assert.equal(await page.locator('#file-sync-children').isVisible(), false);
    await page.click('button:text("修改本地路径")');
    assert.equal(await page.locator('#sync-local-path').inputValue(), '/home/test/.claude/settings.json');
    await page.fill('#sync-local-path', '/srv/claude/settings.json');
    await page.click('#sync-local-save');
    await page.waitForFunction(() => document.getElementById('file-sync-body').textContent.includes('/srv/claude/settings.json'));
    await page.click('button:text("修改本地路径")');
    assert.equal(await page.locator('#sync-local-path').inputValue(), '/srv/claude/settings.json');
    await page.fill('#sync-local-path', '');
    await page.click('#sync-local-save');
    await page.waitForFunction(() => document.getElementById('file-sync-body').textContent.includes('/home/test/.claude/settings.json'));
    assert.deepEqual(errors, []);
    console.log('File sync UI browser test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
