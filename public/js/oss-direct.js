// Uploads an image or any other file from the browser straight to Alibaba Cloud OSS (a form POST), used by the page's upload button.
// The Client only signs what the upload may contain (POST /api/oss/upload-policy); the bytes never pass through it and the AccessKey
// secret never reaches the browser. The bucket needs a CORS rule that allows POST from this page's origin.
// An image (PNG, JPEG, GIF, WebP, told from its first bytes) is shown inline, up to 10 MiB; any other file is a download (attachment)
// under its original name, up to 100 MiB.
const OssDirect = (() => {
  const MAX_BYTES = 10 * 1024 * 1024;
  const MAX_FILE_BYTES = 100 * 1024 * 1024;
  const NAME_CHARS = 255; // the server keeps at most 200; this only keeps the request small
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

  async function policyFor(request) {
    let response;
    try {
      response = await fetch('/api/oss/upload-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(request),
      });
    } catch { throw new Error('Could not reach the client to prepare the upload. Check your network and retry'); }
    const body = await readJson(response);
    if (!response.ok) throw new Error((typeof I18n !== 'undefined' ? I18n.errorOf(body) : body.error) || 'Could not prepare the upload');
    const safe = value => typeof value === 'string' && value.startsWith('https://') && !/[\s\x00-\x1f\x7f]/.test(value);
    if (!safe(body.host) || !safe(body.url) || !body.fields || typeof body.fields !== 'object') throw new Error('Upload failed: the server returned an invalid upload policy');
    return body;
  }

  // OSS answers a rejected form POST with an XML error; its code (AccessDenied, EntityTooLarge ...) tells what to fix.
  function failure(xhr) {
    const code = /<Code>([A-Za-z]+)<\/Code>/.exec(xhr.responseText || '');
    return new Error(code ? `OSS rejected the upload (${code[1]}). Check the bucket permissions and the AccessKey` : `OSS rejected the upload (HTTP ${xhr.status})`);
  }

  function post(policy, file, ui, noun) {
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
        ui.status(noun === 'image' ? `Uploading image to OSS: ${percent}%` : `Uploading file to OSS: ${percent}%`);
      };
      xhr.upload.onload = () => { ui.progress(null); ui.status(noun === 'image' ? 'OSS is processing the image…' : 'OSS is processing the file…'); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(failure(xhr)));
      // A blocked cross-origin request and a lost connection look the same to the page.
      xhr.onerror = () => reject(new Error(`Could not upload to OSS. Check your network, and that the bucket's CORS rules allow POST from ${location.origin}`));
      xhr.ontimeout = () => reject(new Error('Upload timed out. Please retry'));
      xhr.onabort = () => reject(new Error('Upload cancelled'));
      xhr.send(form);
    });
  }

  // ui: { status(text), progress(percent | null) }. Resolves { url, expiresAt, image } once the object is in the bucket.
  async function upload(file, ui) {
    if (!file || file.size <= 0) throw new Error('The file is empty');
    const type = await sniff(file);
    if (type && file.size > MAX_BYTES) throw new Error('The image cannot exceed 10 MiB');
    if (!type && file.size > MAX_FILE_BYTES) throw new Error('The file cannot exceed 100 MiB');
    ui.status('Preparing the upload…');
    ui.progress(null);
    // An image keeps the request it always had; a file says so and sends the browser's type and its name (the server checks both).
    const request = type ? { type, size: file.size }
      : { kind: 'file', type: typeof file.type === 'string' ? file.type : '', size: file.size, name: [...String(file.name || '')].slice(-NAME_CHARS).join('') };
    const policy = await policyFor(request);
    const noun = type ? 'image' : 'file';
    ui.progress(0);
    ui.status(type ? 'Uploading image to OSS…' : 'Uploading file to OSS…');
    await post(policy, file, ui, noun);
    return { url: policy.url, expiresAt: policy.expiresAt || null, image: Boolean(type) };
  }

  return { upload, sniff, MAX_BYTES, MAX_FILE_BYTES };
})();
