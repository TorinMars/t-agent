const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTerminalUser, lookupUser, userCanEnter, terminalEnvFor } = require('../lib/terminal-user');

const passwd = 'root:x:0:0:root:/root:/bin/bash\ndev:x:1001:1001::/home/dev:/bin/bash\nbad:x:0:0::/x:/bin/sh\n';
const root = { platform: 'linux', uid: 0, passwd };

test('lookupUser parses /etc/passwd entries', () => {
  assert.deepEqual(lookupUser('dev', passwd), { name: 'dev', uid: 1001, gid: 1001, home: '/home/dev', shell: '/bin/bash' });
  assert.equal(lookupUser('nobody-here', passwd), null);
});

test('only a root service on Linux drops privileges; default user is dev', () => {
  assert.equal(resolveTerminalUser({ ...root, env: {} }).user.name, 'dev');
  assert.equal(resolveTerminalUser({ ...root, env: { TERMINAL_USER: 'dev' } }).user.uid, 1001);
  assert.equal(resolveTerminalUser({ platform: 'darwin', uid: 0, passwd, env: {} }).user, null);
  assert.equal(resolveTerminalUser({ platform: 'linux', uid: 501, passwd, env: {} }).user, null);
});

test('empty TERMINAL_USER, root and uid-0 aliases disable dropping; missing users are reported', () => {
  assert.equal(resolveTerminalUser({ ...root, env: { TERMINAL_USER: '' } }).reason, 'disabled');
  assert.equal(resolveTerminalUser({ ...root, env: { TERMINAL_USER: 'root' } }).reason, 'root');
  assert.equal(resolveTerminalUser({ ...root, env: { TERMINAL_USER: 'bad' } }).reason, 'root');
  assert.equal(resolveTerminalUser({ ...root, env: { TERMINAL_USER: 'ghost' } }).reason, 'missing-explicit');
  assert.equal(resolveTerminalUser({ ...root, passwd: 'root:x:0:0:r:/root:/bin/sh\n', env: {} }).reason, 'missing-default');
});

test('directory access follows owner, group and other permission bits', () => {
  const user = { uid: 1001, gid: 1001 };
  const stat = (mode, uid, gid) => () => ({ isDirectory: () => true, mode, uid, gid });
  assert.equal(userCanEnter('/d', user, stat(0o40700, 1001, 0)), true);
  assert.equal(userCanEnter('/d', user, stat(0o40700, 0, 0)), false);
  assert.equal(userCanEnter('/d', user, stat(0o40750, 0, 1001)), true);
  assert.equal(userCanEnter('/d', user, stat(0o40755, 0, 0)), true);
  assert.equal(userCanEnter('/missing', user, () => { throw new Error('ENOENT'); }), false);
});

test('dropped terminals get the target user environment without the service secret', () => {
  const env = terminalEnvFor({ name: 'dev', home: '/home/dev' }, { SESSION_SECRET: 'x', PATH: '/bin', HOME: '/root', USER: 'root' });
  assert.equal(env.SESSION_SECRET, undefined);
  assert.deepEqual([env.HOME, env.USER, env.LOGNAME, env.PATH], ['/home/dev', 'dev', 'dev', '/bin']);
});
