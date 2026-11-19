// Starter word lists of English learning ("Starter list" in docs/design/learn-english.md). English only: the Chinese meanings are fetched through the
// configured translator (POST /api/learn/meaning) when a word first comes up, never stored here (Chinese lives only in the i18n dictionaries).
// The words are in a rough order of how early a developer meets them; POST /api/learn/starter imports a list once, STARTER_PER_DAY new words a day.

const DEV = [
  // Everyday work on code
  'deploy', 'merge', 'commit', 'branch', 'rebase', 'refactor', 'review', 'release', 'build', 'compile',
  'debug', 'test', 'fix', 'bug', 'issue', 'feature', 'patch', 'update', 'upgrade', 'install',
  'configure', 'setting', 'default', 'option', 'argument', 'parameter', 'variable', 'constant', 'function', 'method',
  'class', 'object', 'instance', 'property', 'attribute', 'value', 'type', 'interface', 'module', 'package',
  'library', 'framework', 'dependency', 'version', 'repository', 'directory', 'folder', 'file', 'path', 'extension',
  // Running and failing
  'run', 'execute', 'launch', 'start', 'stop', 'restart', 'crash', 'hang', 'freeze', 'fail',
  'failure', 'error', 'warning', 'exception', 'stack', 'trace', 'log', 'output', 'input', 'message',
  'timeout', 'retry', 'latency', 'throughput', 'bottleneck', 'overhead', 'leak', 'memory', 'performance', 'regression',
  'workaround', 'root', 'cause', 'reproduce', 'symptom', 'flaky', 'intermittent', 'deadlock', 'race', 'condition',
  // Data and storage
  'database', 'table', 'column', 'row', 'index', 'query', 'schema', 'migration', 'backup', 'restore',
  'record', 'field', 'key', 'cache', 'storage', 'persist', 'serialize', 'parse', 'format', 'encode',
  'decode', 'encrypt', 'decrypt', 'hash', 'token', 'credential', 'secret', 'permission', 'access', 'authenticate',
  'authorize', 'session', 'cookie', 'header', 'payload', 'request', 'response', 'endpoint', 'route', 'redirect',
  // Systems and networks
  'server', 'client', 'service', 'process', 'thread', 'task', 'queue', 'worker', 'scheduler', 'job',
  'network', 'connection', 'socket', 'port', 'host', 'domain', 'address', 'proxy', 'tunnel', 'firewall',
  'bandwidth', 'traffic', 'load', 'balancer', 'cluster', 'node', 'container', 'image', 'volume', 'environment',
  'production', 'staging', 'rollback', 'rollout', 'pipeline', 'artifact', 'monitor', 'alert', 'metric', 'dashboard',
  'scale', 'capacity', 'availability', 'reliability', 'redundancy', 'failover', 'outage', 'incident', 'downtime', 'uptime',
  // Design and quality
  'design', 'architecture', 'component', 'layer', 'abstraction', 'implementation', 'requirement', 'specification', 'constraint', 'trade-off',
  'scope', 'estimate', 'priority', 'milestone', 'deadline', 'backlog', 'sprint', 'iteration', 'prototype', 'proposal',
  'readable', 'maintainable', 'consistent', 'robust', 'scalable', 'compatible', 'deprecated', 'obsolete', 'redundant', 'duplicate',
  'coverage', 'assertion', 'fixture', 'mock', 'stub', 'benchmark', 'profile', 'lint', 'formatter', 'snippet',
  // Verbs of changing code
  'add', 'remove', 'delete', 'rename', 'replace', 'move', 'extract', 'inline', 'split', 'combine',
  'wrap', 'unwrap', 'expose', 'hide', 'enable', 'disable', 'toggle', 'override', 'inherit', 'implement',
  'validate', 'verify', 'ensure', 'handle', 'ignore', 'skip', 'throw', 'catch', 'return', 'yield',
  'invoke', 'trigger', 'dispatch', 'emit', 'subscribe', 'listen', 'notify', 'poll', 'fetch', 'sync',
  'render', 'mount', 'resize', 'scroll', 'focus', 'select', 'submit', 'upload', 'download', 'export',
  // Words of discussion
  'approach', 'assumption', 'behavior', 'context', 'detail', 'edge', 'case', 'example', 'impact', 'issue',
  'limitation', 'overview', 'pattern', 'risk', 'solution', 'step', 'summary', 'suggestion', 'feedback', 'concern',
  'clarify', 'confirm', 'mention', 'propose', 'investigate', 'analyze', 'compare', 'measure', 'document', 'explain',
  'straightforward', 'tricky', 'optional', 'mandatory', 'explicit', 'implicit', 'temporary', 'permanent', 'manual', 'automatic',
  'asynchronous', 'synchronous', 'concurrent', 'sequential', 'recursive', 'immutable', 'nullable', 'idempotent', 'atomic', 'granular',
];

// The same word must not be listed twice (it would be imported once anyway); kept as a list in order.
const unique = list => [...new Set(list.map(word => word.toLowerCase()))];

const STARTER_LISTS = {
  dev: { id: 'dev', title: 'Programmer English', words: unique(DEV) },
};
const STARTER_PER_DAY = 10;

module.exports = { STARTER_LISTS, STARTER_PER_DAY };
