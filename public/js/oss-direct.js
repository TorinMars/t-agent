// Uploads an image from the browser straight to Alibaba Cloud OSS (a form POST), shared by the desktop and the phone page.
// The Client only signs what the upload may contain (POST /api/oss/upload-policy); the image bytes never pass through it and the
// AccessKey secret never reaches the browser. The bucket needs a CORS rule that allows POST from this page's origin.
const OssDirect = (() => {
  const MAX_BYTES = 10 * 1024 * 1024;
  const TIMEOUT_MS = 120000;
  const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));
  const same = (bytes, pattern) => pattern.every((value, index) => bytes[index] === value);

  // The type from the first bytes of the file: the picker's and the clipboard's `file.type` come from the name or the source app.
  async function sniff(file) {
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (same(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (same(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return 'image/gif';
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }

  async function readJson(response) {
    try { return await response.json(); } catch { return {}; }
  }

  async function policyFor(type, size) {
    let response;
    try {
      response = await fetch('/api/oss/upload-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ type, size }),
      });
    } catch { throw new Error('Could not reach the client to prepare the upload. Check your network and retry'); }
    const body = await readJson(response);
    if (!response.ok) throw new Error(body.error || 'Could not prepare the image upload');
    const safe = value => typeof value === 'string' && value.startsWith('https://') && !/[\s\x00-\x1f\x7f]/.test(value);
    if (!safe(body.host) || !safe(body.url) || !body.fields || typeof body.fields !== 'object') throw new Error('Upload failed: the server returned an invalid upload policy');
    return body;
  }

  // OSS answers a rejected form POST with an XML error; its code (AccessDenied, EntityTooLarge ...) tells what to fix.
  function failure(xhr) {
    const code = /<Code>([A-Za-z]+)<\/Code>/.exec(xhr.responseText || '');
    return new Error(code ? `OSS rejected the upload (${code[1]}). Check the bucket permissions and the AccessKey` : `OSS rejected the upload (HTTP ${xhr.status})`);
  }

  function post(policy, file, ui) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(policy.fields)) form.append(name, String(value));
      form.append('file', file); // OSS requires the file to be the last field
      const xhr = new XMLHttpRequest();
      xhr.open('POST', policy.host);
      xhr.timeout = TIMEOUT_MS;
      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) { ui.progress(null); return; }
        const percent = Math.min(100, Math.round(event.loaded / event.total * 100));
        ui.progress(percent);
        ui.status(`Uploading image to OSS: ${percent}%`);
      };
      xhr.upload.onload = () => { ui.progress(null); ui.status('OSS is processing the image…'); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(failure(xhr)));
      // A blocked cross-origin request and a lost connection look the same to the page.
      xhr.onerror = () => reject(new Error(`Could not upload to OSS. Check your network, and that the bucket's CORS rules allow POST from ${location.origin}`));
      xhr.ontimeout = () => reject(new Error('Image upload timed out. Please retry'));
      xhr.onabort = () => reject(new Error('Image upload cancelled'));
      xhr.send(form);
    });
  }

  // ui: { status(text), progress(percent | null) }. Resolves { url, expiresAt } once the object is in the bucket.
  async function upload(file, ui) {
    if (!file || file.size <= 0 || file.size > MAX_BYTES) throw new Error('Choose a PNG, JPEG, GIF or WebP image up to 10 MiB');
    const type = await sniff(file);
    if (!type) throw new Error('Choose a PNG, JPEG, GIF or WebP image up to 10 MiB');
    ui.status('Preparing the upload…');
    ui.progress(null);
    const policy = await policyFor(type, file.size);
    ui.progress(0);
    ui.status('Uploading image to OSS…');
    await post(policy, file, ui);
    return { url: policy.url, expiresAt: policy.expiresAt || null };
  }

  return { upload, sniff, MAX_BYTES };
})();
