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
      const files = path => ({ path, local_path: '/home/test/' + path.slice(2), default_path: '/home/test/' + path.slice(2), path_override: null, exists: true, version: 1 });
      let syncState = { role: 'master', master_id: null, master_url: null, files: [], error: null,
        children: [{ id: 'node-123456', name: '从服务器节点', online: true, last_sync_at: '2026-10-10T07:00:00Z', last_seen_at: '2026-10-10T07:00:01Z', error: null }] };
      const calls = window.calls = [];
      const waitingState = { role: 'child', master_id: null, master_url: null, files: [], children: [], error: null };
      const API = {
        get: async () => syncState,
        put: async (url, body) => {
          calls.push(['PUT', url, body]);
          if (url.endsWith('/role')) syncState = body.role === 'slave' ? waitingState : { ...syncState, role: 'master', children: [] };
          else if (url.endsWith('/path')) syncState = { ...syncState, files: syncState.files.map(file => file.path === body.path ? { ...file, path_override: body.local_path || null, local_path: body.local_path || file.default_path } : file) };
          else syncState = { ...syncState, files: body.files.map(files) };
          return syncState;
        },
        post: async (url, body) => {
          calls.push(['POST', url, body]);
          if (url.endsWith('/invite')) return { connection_string: 'TAFS1:eyJ2IjoxfQ', expires_at: new Date(Date.now() + 600000).toISOString(), expires_in_seconds: 600 };
          if (url.endsWith('/join')) syncState = { role: 'child', master_id: null, master_url: 'http://203.0.113.9:3000', children: [], error: null, files: [files('~/.claude/settings.json')] };
          if (url.endsWith('/unpair')) syncState = waitingState;
          return syncState;
        },
      };
      const Modal = { show(title, html) { document.getElementById('modal-title').textContent = title; document.getElementById('modal-body').innerHTML = html; }, hide() { document.getElementById('modal-body').replaceChildren(); } };
    ` });
    await page.addScriptTag({ path: path.join(root, 'public/js/file-sync.js') });
    await page.evaluate(() => { document.getElementById('file-sync-panel').hidden = false; FileSyncUI.setEngine({ base: '/api/file-sync', label: '默认', unavailable: null }); FileSyncUI.setActive(true); });
    await page.waitForFunction(() => document.getElementById('file-sync-role').textContent.includes('主服务器'));
    assert.equal(await page.locator('#file-sync-role-select').inputValue(), 'master');
    assert.equal(await page.locator('#file-sync-join-box').isVisible(), false);
    assert.match(await page.locator('#file-sync-children-body').textContent(), /从服务器节点.*在线/);
    await page.click('#file-sync-add');
    await page.fill('#sync-new-path', '~/.claude/settings.json');
    await page.click('#sync-new-save');
    await page.waitForFunction(() => document.querySelectorAll('#file-sync-body tr').length === 1);
    assert.match(await page.locator('#file-sync-body').textContent(), /\/home\/test\/\.claude\/settings.json/);

    // 主服务器：填写自己的外网地址，生成包含全部连接信息的字符串。
    assert.equal(await page.locator('#file-sync-invite').isVisible(), true);
    await page.click('#file-sync-invite');
    await page.waitForFunction(() => document.getElementById('sync-invite-string')?.value === 'TAFS1:eyJ2IjoxfQ');
    assert.deepEqual(await page.evaluate(() => ({ sent: window.calls.find(call => call[1].endsWith('/invite'))[2], origin: location.origin })).then(r => r.sent), { master_url: await page.evaluate(() => location.origin) }, '点一下就生成，默认用当前地址');

    // 切换为从服务器：出现粘贴框，没有主服务器才有的操作。
    await page.selectOption('#file-sync-role-select', 'slave');
    await page.waitForFunction(() => document.getElementById('file-sync-role').textContent.includes('尚未关联'));
    assert.equal(await page.locator('#file-sync-join-box').isVisible(), true);
    assert.equal(await page.locator('#file-sync-invite').isVisible(), false);
    assert.equal(await page.locator('#file-sync-add').isVisible(), false);
    assert.equal(await page.locator('#file-sync-children').isVisible(), false);
    assert.equal(await page.locator('#file-sync-disconnect').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.calls.find(call => call[1].endsWith('/role'))[2]), { role: 'slave' });

    // 粘贴连接字符串并连接（带换行和空白也原样交给服务端处理）。
    await page.click('#file-sync-connect');
    assert.equal(await page.evaluate(() => window.calls.some(call => call[1].endsWith('/join'))), false, '没有内容时不发请求');
    await page.fill('#file-sync-join-input', '  TAFS1:eyJ2IjoxfQ\n');
    await page.click('#file-sync-connect');
    await page.waitForFunction(() => document.getElementById('file-sync-role').textContent.includes('http://203.0.113.9:3000'));
    assert.deepEqual(await page.evaluate(() => window.calls.find(call => call[1].endsWith('/join'))[2]), { connection_string: 'TAFS1:eyJ2IjoxfQ' });
    assert.equal(await page.locator('#file-sync-join-box').isVisible(), false);
    assert.equal(await page.locator('#file-sync-disconnect').isVisible(), true);

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

    // 解除关联后回到粘贴框；再切回主服务器。
    await page.click('#file-sync-disconnect');
    await page.waitForFunction(() => !document.getElementById('file-sync-join-box').hidden);
    assert.equal(await page.locator('#file-sync-disconnect').isVisible(), false);
    await page.selectOption('#file-sync-role-select', 'master');
    await page.waitForFunction(() => document.getElementById('file-sync-role').textContent.includes('主服务器'));
    assert.equal(await page.locator('#file-sync-invite').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('File sync UI browser test passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
