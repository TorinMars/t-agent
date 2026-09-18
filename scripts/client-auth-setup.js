const QRCode = require('qrcode');

// Run inside the Client container: the existing HTTP API enforces loopback
// enrollment and issues a normal session. No special remote bypass is added.
async function enroll({ baseUrl = `http://127.0.0.1:${process.env.PORT || 3000}`, ask, write = console.log,
  qr = uri => QRCode.toString(uri, { type: 'terminal', small: true }) } = {}) {
  let cookie = '';
  async function request(route, body) {
    const response = await fetch(baseUrl + route, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP_${response.status}`);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return result;
  }
  if ((await request('/auth/status')).bound) throw new Error('AUTHENTICATOR_ALREADY_BOUND：已绑定，请在网页设置中更换；此命令不会重置现有绑定。');
  const setup = await request('/auth/setup/start', {});
  write(await qr(setup.uri));
  write(`请用身份验证器扫描上方二维码，或手动添加密钥：${setup.secret}`);
  write('类型：基于时间（TOTP），6 位，30 秒。请勿分享此密钥。');
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = (await ask('输入身份验证器的 6 位验证码：')).trim();
    try {
      const result = await request('/auth/setup/confirm', { code });
      write('绑定完成。请立即保存以下一次性恢复码（仅显示一次）：');
      for (const recovery of result.recovery_codes) write(recovery);
      write('请打开配置的 HTTPS 域名登录；等待身份验证器生成下一组验证码。');
      return;
    } catch (error) {
      if (error.message !== 'AUTH_CODE_INVALID' || attempt === 2) throw error;
      write('验证码不正确，请重试。');
    }
  }
}

if (require.main === module) {
  const readline = require('node:readline/promises');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  enroll({ ask: question => terminal.question(question) })
    .catch(error => { console.error(`绑定失败：${error.message}`); process.exitCode = 1; })
    .finally(() => terminal.close());
}
module.exports = { enroll };
