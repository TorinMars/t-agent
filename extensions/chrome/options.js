const saved = await chrome.storage.local.get(['server_url', 'name']);
const server = document.querySelector('#server'),
  name = document.querySelector('#name'),
  status = document.querySelector('#status');
server.value = saved.server_url || 'http://127.0.0.1:3000';
name.value = saved.name || `Chrome on ${navigator.platform}`;
status.textContent = (await chrome.runtime.sendMessage({
  type: 'status'
})).status;
document.querySelector('#pair').addEventListener('submit', async e => {
  e.preventDefault();
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const base = new URL(server.value);
    if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Use a loopback HTTP or HTTPS server URL');
    const response = await fetch(new URL('/api/browser-ext/pair', base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        code: document.querySelector('#code').value.trim(),
        name: name.value,
        version: '1.0.0',
        user_agent: navigator.userAgent
      })
    });
    if (!response.ok) throw new Error(response.status === 400 ? 'PAIR_CODE_INVALID' : 'Pairing failed');
    const data = await response.json();
    if (!data.token?.startsWith('tab_')) throw new Error('Invalid pairing response');
    await chrome.storage.local.set({
      server_url: base.origin,
      name: name.value,
      token: data.token,
      browser_id: data.browser_id,
      server_name: data.server_name
    });
    document.querySelector('#code').value = '';
    status.textContent = 'Paired';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
