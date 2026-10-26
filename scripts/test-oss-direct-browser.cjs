// Browser test of the shared direct-to-OSS uploader: type sniffing, the signed form POST, and every way the upload can fail.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const calls = [];
    let oss = route => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '' });
    let policy = route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ host: 'https://bucket.oss.test', fields: { key: 'a/b.png', policy: 'p' }, url: 'https://images.example/a/b.png', expiresAt: '2026-10-27T00:00:00.000Z' }) });
    await page.route('http://app.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title>' }));
    await page.route('http://app.test/api/oss/upload-policy', route => { calls.push(['policy', route.request().postDataJSON(), route.request().headers()['x-requested-with']]); return policy(route); });
    await page.route('https://bucket.oss.test/**', route => { calls.push(['oss', route.request().method()]); return oss(route); });
    await page.goto('http://app.test/');
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/oss-direct.js'), 'utf8') });
    const run = (bytes, extra = {}) => page.evaluate(async ([bytes, extra]) => {
      const log = { status: [], progress: [] };
      const file = new File([new Uint8Array(bytes)], extra.name || 'x.png', { type: extra.type || 'image/png' });
      try { return { ok: await OssDirect.upload(file, { status: text => log.status.push(text), progress: value => log.progress.push(value) }), log }; }
      catch (error) { return { error: error.message, log }; }
    }, [bytes, extra]);
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];

    // The type comes from the bytes, whatever the file says.
    const sniffed = await page.evaluate(async () => {
      const kinds = {};
      for (const [name, bytes] of Object.entries({
        png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], jpeg: [0xff, 0xd8, 0xff, 0xe0], gif: [...'GIF89a'].map(c => c.charCodeAt(0)),
        webp: [...'RIFF\0\0\0\0WEBP'].map(c => c.charCodeAt(0)), svg: [...'<svg xmlns="x"/>'].map(c => c.charCodeAt(0)), text: [...'hello'].map(c => c.charCodeAt(0)),
      })) kinds[name] = await OssDirect.sniff(new File([new Uint8Array(bytes)], 'f'));
      return kinds;
    });
    assert.deepEqual(sniffed, { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: null, text: null });

    // A good upload: the Client is asked to sign (type and size, no bytes), then the browser posts to OSS.
    const good = await run(PNG);
    assert.deepEqual(good.ok, { url: 'https://images.example/a/b.png', expiresAt: '2026-10-27T00:00:00.000Z' });
    assert.deepEqual(calls, [['policy', { type: 'image/png', size: PNG.length }, 'XMLHttpRequest'], ['oss', 'POST']]);
    assert.equal(good.log.status[0], 'Preparing the upload…');
    assert.ok(good.log.status.includes('Uploading image to OSS…'));
    assert.deepEqual(good.log.progress.slice(0, 2), [null, 0], 'indeterminate while the policy is fetched, then 0% for the transfer');

    // A file that is not an image never leaves the page, even when it is named .png and typed image/png.
    calls.length = 0;
    assert.match((await run([60, 115, 118, 103, 62])).error, /PNG, JPEG, GIF or WebP/);
    assert.match((await page.evaluate(async () => { try { await OssDirect.upload(new File([], 'e.png', { type: 'image/png' }), { status() {}, progress() {} }); } catch (error) { return error.message; } })), /up to 10 MiB/);
    assert.deepEqual(calls, []);

    // The Client refuses (disabled, too large ...): its message is shown and OSS is not contacted.
    policy = route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'OSS image upload is not enabled yet' }) });
    assert.equal((await run(PNG)).error, 'OSS image upload is not enabled yet');
    policy = route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ host: 'http://insecure.example', fields: {}, url: 'https://x.example/a.png' }) });
    assert.match((await run(PNG)).error, /invalid upload policy/);
    assert.deepEqual(calls.filter(call => call[0] === 'oss'), []);

    // OSS answers with an error code; a blocked or failed request names the CORS rule to check.
    policy = route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ host: 'https://bucket.oss.test', fields: { key: 'k' }, url: 'https://images.example/k.png' }) });
    oss = route => route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/xml', body: '<Error><Code>AccessDenied</Code></Error>' });
    assert.match((await run(PNG)).error, /OSS rejected the upload \(AccessDenied\)/);
    oss = route => route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: 'bad gateway' });
    assert.match((await run(PNG)).error, /HTTP 502/);
    oss = route => route.abort('failed');
    assert.match((await run(PNG)).error, /CORS rules allow POST from http:\/\/app\.test/);
    console.log('Direct OSS upload: byte sniffing, signed form POST, Client refusals, OSS error codes and CORS/network failures passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
