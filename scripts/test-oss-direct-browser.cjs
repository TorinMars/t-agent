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
    const posted = [];
    await page.route('https://bucket.oss.test/**', route => { calls.push(['oss', route.request().method()]); posted.push(route.request().postDataBuffer()); return oss(route); });
    await page.goto('http://app.test/');
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'public/js/oss-direct.js'), 'utf8') });
    const run = (bytes, extra = {}) => page.evaluate(async ([bytes, extra]) => {
      const log = { status: [], progress: [] };
      const file = new File([new Uint8Array(bytes)], extra.name || 'x.png', { type: 'type' in extra ? extra.type : 'image/png' });
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
    assert.deepEqual(good.ok, { url: 'https://images.example/a/b.png', expiresAt: '2026-10-27T00:00:00.000Z', image: true });
    assert.deepEqual(calls, [['policy', { type: 'image/png', size: PNG.length }, 'XMLHttpRequest'], ['oss', 'POST']]);
    assert.equal(good.log.status[0], 'Preparing the upload…');
    assert.ok(good.log.status.includes('Uploading image to OSS…'));
    assert.deepEqual(good.log.progress.slice(0, 2), [null, 0], 'indeterminate while the policy is fetched, then 0% for the transfer');

    // Any other file goes up as a file: the request says so and carries the browser's type and the name; the server decides the rest
    // (attachment, a safe type). The bytes go to OSS as the last form field, after the signed fields.
    calls.length = 0;
    posted.length = 0;
    const disposition = "attachment; filename=\"__.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf";
    policy = route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ host: 'https://bucket.oss.test', fields: { key: 'a/c.pdf', 'Content-Type': 'application/pdf', 'Content-Disposition': disposition, policy: 'p' }, url: 'https://images.example/a/c.pdf', expiresAt: null }) });
    const PDF = [...'%PDF-1.7 file body'].map(c => c.charCodeAt(0));
    const doc = await run(PDF, { name: 'docs/\u62a5\u544a.pdf', type: 'application/pdf' });
    assert.deepEqual(doc.ok, { url: 'https://images.example/a/c.pdf', expiresAt: null, image: false });
    assert.deepEqual(calls, [['policy', { kind: 'file', type: 'application/pdf', size: PDF.length, name: 'docs/\u62a5\u544a.pdf' }, 'XMLHttpRequest'], ['oss', 'POST']]);
    const form = posted[0].toString('utf8');
    assert.ok(form.includes(disposition) && form.indexOf('name="Content-Disposition"') < form.indexOf('name="file"'), 'the signed disposition is sent before the file');
    assert.ok(form.includes('%PDF-1.7 file body'), 'the file bytes are in the form');
    assert.ok(doc.log.status.includes('Uploading file to OSS…'));
    assert.ok(!doc.log.status.some(text => /image/.test(text)), 'a file upload never says image');
    // A file named .png and typed image/png that holds other bytes (here SVG) is a file, not an inline image.
    calls.length = 0;
    await run([60, 115, 118, 103, 62]);
    assert.deepEqual(calls[0], ['policy', { kind: 'file', type: 'image/png', size: 5, name: 'x.png' }, 'XMLHttpRequest']);
    // A file without a type is sent with an empty type (the server stores it as application/octet-stream); a very long name is cut to its last 255 characters.
    calls.length = 0;
    await run([1, 2, 3], { name: 'n'.repeat(400) + '.bin', type: '' });
    assert.equal(calls[0][1].type, '');
    assert.equal(calls[0][1].name.length, 255);
    assert.ok(calls[0][1].name.endsWith('.bin'));
    policy = route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ host: 'https://bucket.oss.test', fields: { key: 'a/b.png', policy: 'p' }, url: 'https://images.example/a/b.png', expiresAt: '2026-10-27T00:00:00.000Z' }) });

    // Empty files and files over the limit never leave the page: images up to 10 MiB, other files up to 100 MiB.
    calls.length = 0;
    const limit = (parts, header, name, type) => page.evaluate(async ([parts, header, name, type]) => {
      const chunk = new Uint8Array(1024 * 1024);
      const file = new File([new Uint8Array(header), ...Array.from({ length: parts }, () => chunk)], name, { type });
      try { await OssDirect.upload(file, { status() {}, progress() {} }); return 'ok'; } catch (error) { return error.message; }
    }, [parts, header, name, type]);
    assert.equal(await page.evaluate(async () => { try { await OssDirect.upload(new File([], 'e.png', { type: 'image/png' }), { status() {}, progress() {} }); } catch (error) { return error.message; } }), 'The file is empty');
    assert.equal(await limit(10, PNG, 'big.png', 'image/png'), 'The image cannot exceed 10 MiB');
    assert.equal(await limit(100, [1], 'big.bin', 'application/octet-stream'), 'The file cannot exceed 100 MiB');
    assert.deepEqual(calls, []);
    assert.equal(await limit(11, [1], 'eleven.bin', 'application/octet-stream'), 'ok', 'a file above the image limit is fine');
    assert.deepEqual(calls.map(call => call[0]), ['policy', 'oss']);
    assert.equal(calls[0][1].size, 11 * 1024 * 1024 + 1);

    // The Client refuses (disabled, too large ...): its message is shown and OSS is not contacted.
    calls.length = 0;
    policy = route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'OSS upload is not enabled yet' }) });
    assert.equal((await run(PNG)).error, 'OSS upload is not enabled yet');
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
    console.log('Direct OSS upload: byte sniffing, images and other files, size limits, signed form POST, Client refusals, OSS error codes and CORS/network failures passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
