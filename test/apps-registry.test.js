const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAppsRegistry, AppsError } = require('../services/apps-registry');

function setup(t) {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
  t.after(() => db.close());
  return createAppsRegistry({ db });
}
const code = fn => { try { fn(); } catch (error) { return error instanceof AppsError ? error.code : `OTHER:${error.message}`; } return null; };

test('创建、更新、删除手动登记的应用，字段按规则规范化', t => {
  const apps = setup(t);
  const created = apps.create({ name: '  博客  ', port: '8080', host: '10.0.0.5', domain: 'blog.example.com', scheme: 'https', path: '/admin', description: '个人博客' });
  assert.equal(created.name, '博客');
  assert.equal(created.port, 8080);
  assert.equal(created.source, 'manual');
  assert.equal(created.hidden, false);
  assert.equal(apps.get(created.id).domain, 'blog.example.com');

  const updated = apps.update(created.id, { port: 9090, description: '' });
  assert.equal(updated.port, 9090);
  assert.equal(updated.description, null);
  assert.equal(updated.host, '10.0.0.5', '没传的字段保持原值');

  assert.deepEqual(apps.remove(created.id), { deleted: true, hidden: false });
  assert.equal(apps.get(created.id), null);
  assert.equal(code(() => apps.remove(created.id)), 'APP_NOT_FOUND');
  assert.equal(code(() => apps.update(999, { port: 1 })), 'APP_NOT_FOUND');
});

test('拒绝不安全或格式错误的输入：地址会变成可点击的链接，必须只允许 http(s)', t => {
  const apps = setup(t);
  const bad = (input, expected) => assert.equal(code(() => apps.create({ name: 'x', ...input })), expected, JSON.stringify(input));
  bad({ url: 'javascript:alert(1)' }, 'APP_URL_INVALID');
  bad({ url: 'file:///etc/passwd' }, 'APP_URL_INVALID');
  bad({ url: 'data:text/html,<script>' }, 'APP_URL_INVALID');
  bad({ url: 'https://user:pass@example.com' }, 'APP_URL_INVALID');
  bad({ url: 'not a url' }, 'APP_URL_INVALID');
  bad({ domain: 'javascript:alert(1)' }, 'APP_DOMAIN_INVALID');
  bad({ domain: 'exa mple.com' }, 'APP_DOMAIN_INVALID');
  bad({ domain: 'ftp://example.com' }, 'APP_DOMAIN_INVALID');
  bad({ domain: 'https://u:p@example.com' }, 'APP_URL_INVALID');
  bad({ host: 'a b' }, 'APP_HOST_INVALID');
  bad({ host: 'http://1.2.3.4' }, 'APP_HOST_INVALID');
  bad({ port: 0 }, 'APP_PORT_INVALID');
  bad({ port: 70000 }, 'APP_PORT_INVALID');
  bad({ port: 'abc' }, 'APP_PORT_INVALID');
  bad({ port: 80.5 }, 'APP_PORT_INVALID');
  bad({ scheme: 'javascript' }, 'APP_SCHEME_INVALID');
  bad({ path: 'no-slash' }, 'APP_PATH_INVALID');
  bad({ path: '/a b' }, 'APP_PATH_INVALID');
  bad({ description: 'x'.repeat(501) }, 'APP_FIELD_TOO_LONG');
  bad({ name: 'a\nb' }, 'APP_FIELD_INVALID');
  assert.equal(code(() => apps.create({ name: '' })), 'APP_FIELD_REQUIRED');
  assert.equal(code(() => apps.create({ name: 'n'.repeat(65) })), 'APP_FIELD_TOO_LONG');
  assert.equal(code(() => apps.create(null)), 'APP_BODY_INVALID');
  assert.equal(code(() => apps.create([])), 'APP_BODY_INVALID');
  // 合法的写法都能通过
  apps.create({ name: 'ok1', domain: 'https://app.example.com/base', url: 'http://10.0.0.1:3000/x?y=1' });
  apps.create({ name: 'ok2', domain: 'app.example.com:8443', host: '::1' });
});

test('名称不区分大小写且唯一；同一个 PM2 进程只能关联一个应用', t => {
  const apps = setup(t);
  apps.create({ name: 'Web' });
  assert.equal(code(() => apps.create({ name: 'web' })), 'APP_NAME_TAKEN');
  const other = apps.create({ name: 'other', pm2_name: 'proc-a' });
  assert.equal(code(() => apps.create({ name: 'third', pm2_name: 'proc-a' })), 'APP_PM2_LINKED');
  assert.equal(code(() => apps.update(other.id, { name: 'WEB' })), 'APP_NAME_TAKEN');
});

test('程序自注册是幂等的：重复注册只更新，没传的字段保持原值', t => {
  const apps = setup(t);
  const first = apps.register({ name: 'api-server', port: 4000, description: 'v1' });
  assert.equal(first.created, true);
  assert.equal(first.app.source, 'api');
  apps.update(first.app.id, { domain: 'api.example.com' });

  const again = apps.register({ name: 'api-server', port: 4001 });
  assert.equal(again.created, false);
  assert.equal(again.app.id, first.app.id);
  assert.equal(again.app.port, 4001);
  assert.equal(again.app.domain, 'api.example.com', '程序只上报端口不会清空手填的域名');
  assert.equal(again.app.description, 'v1');
  assert.equal(apps.list().length, 1);

  const viaPm2 = apps.register({ name: 'renamed', pm2_name: 'api-proc' });
  assert.equal(viaPm2.created, true);
  const sameProc = apps.register({ name: 'renamed-again', pm2_name: 'api-proc' });
  assert.equal(sameProc.created, false, '带 pm2_name 时按进程名识别同一个应用');
  assert.equal(sameProc.app.name, 'renamed-again');
});

test('自动登记 PM2：新进程自动建行，同名的未关联应用直接关联，隐藏的不会再登记回来', t => {
  const apps = setup(t);
  const created = apps.ensurePm2('worker');
  assert.equal(created.source, 'pm2');
  assert.equal(created.pm2_name, 'worker');
  assert.equal(apps.ensurePm2('worker'), null, '已关联就不动');

  const manual = apps.create({ name: 'web', port: 8080 });
  const linked = apps.ensurePm2('web');
  assert.equal(linked.id, manual.id, '同名手动应用被关联而不是重复新建');
  assert.equal(linked.pm2_name, 'web');
  assert.equal(linked.source, 'manual');
  assert.equal(apps.list().length, 2);

  // 在 PM2 里仍存在的自动登记应用被删除时只隐藏
  assert.deepEqual(apps.remove(created.id, { pm2Present: true }), { deleted: false, hidden: true });
  assert.equal(apps.list().length, 1);
  assert.equal(apps.hiddenCount(), 1);
  assert.equal(apps.ensurePm2('worker'), null, '隐藏后不会被自动登记回来');
  assert.equal(apps.list().length, 1);
  assert.equal(apps.restoreHidden(), 1);
  assert.equal(apps.list().length, 2);

  // 进程已经不在 PM2 里时才真正删除；手动/API 登记的永远是真删除
  assert.deepEqual(apps.remove(created.id, { pm2Present: false }), { deleted: true, hidden: false });
  assert.deepEqual(apps.remove(manual.id, { pm2Present: true }), { deleted: true, hidden: false });
});

test('编辑被隐藏的应用会让它重新显示；注册同名程序也会', t => {
  const apps = setup(t);
  const row = apps.ensurePm2('cron');
  apps.remove(row.id, { pm2Present: true });
  assert.equal(apps.update(row.id, { description: '定时任务' }).hidden, false);
  apps.remove(row.id, { pm2Present: true });
  assert.equal(apps.register({ name: 'cron', port: 1234 }).app.hidden, false);
});
