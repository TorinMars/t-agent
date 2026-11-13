// The home view of T-Attention: the sections Needs you, Working and To do with whole trees in them, and the number of finished tasks. One pure
// function for the two places that draw it, so they always agree: the `t-attention list --tree` command (scripts/t-attention.js, whose JSON the
// t-attention agent skill turns into its "Home view") and the phone list of the page (scripts/h5-shell/attention-model.mjs `homeGroups`, bundled
// by esbuild). Node built-ins only, no dependencies (the CLI runs without node_modules). See "T-Attention" in DESIGN.md.
//
// Rules (the "Home view" of rules/skills/t-attention/SKILL.md):
// - A tree stays together: a sub-task is always drawn under its parent, whatever their statuses, and each row keeps its own status.
// - A tree goes to the section of its most urgent open task: Needs you (waiting_user, review) > Working > To do. Inside Needs you the trees with a
//   waiting_user task come first, then the ones with a review task.
// - Finished tasks (done, failed, cancelled) are only counted, except a finished task that has an open task under it: it is drawn to keep that
//   task under it. A tree with no open task at all is not drawn.
// - Siblings (and the trees of a section) come by their status (waiting_user, review, working, todo, finished), then in the list order (`compare`:
//   the server's sort_order, the highest first, then the highest id).
// - A parent that is not in the list makes its child a top-level row; a loop in the data is broken where it was first met. Never loops.
'use strict';

const HOME_SECTIONS = Object.freeze([
  Object.freeze({ key: 'needs_you', label: 'Needs you', statuses: Object.freeze(['waiting_user', 'review']) }),
  Object.freeze({ key: 'working', label: 'Working', statuses: Object.freeze(['working']) }),
  Object.freeze({ key: 'todo', label: 'To do', statuses: Object.freeze(['todo']) }),
]);
const FINISHED_STATUSES = Object.freeze(['done', 'failed', 'cancelled']);
// The urgency of a status; an unknown status counts as To do (as the page lists it).
const STATUS_RANK = { waiting_user: 0, review: 1, working: 2, todo: 3 };
const FINISHED_RANK = 4;
const isFinished = item => FINISHED_STATUSES.includes(item && item.status);
const statusRank = item => (isFinished(item) ? FINISHED_RANK : item && item.status in STATUS_RANK ? STATUS_RANK[item.status] : STATUS_RANK.todo);
const sectionOfRank = rank => (rank <= STATUS_RANK.review ? 'needs_you' : rank === STATUS_RANK.working ? 'working' : 'todo');

const orderOf = item => (item && typeof item.sort_order === 'number' && Number.isFinite(item.sort_order) ? item.sort_order : 0);
// The order of GET /api/attention: sort_order, the highest first, then the highest id.
const serverOrder = (a, b) => orderOf(b) - orderOf(a) || (Number(b.id) || 0) - (Number(a.id) || 0);
const plainParent = item => (item && item.parent_id !== undefined && item.parent_id !== null && item.parent_id !== '' ? Number(item.parent_id) : null);

// items: every task (open and finished). Options: keyOf(item) and parentOf(item) (the key of its parent, or null) name the tasks (default: id and
// parent_id), compare(a, b) is the list order. -> { sections: [{ key, label, statuses, nodes }], done } where a node is { item, depth, children }
// (children are nodes) and `done` is the number of finished tasks in `items`.
function homeView(items, { keyOf = item => item.id, parentOf = plainParent, compare = serverOrder } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(item => item && item.id !== undefined && item.id !== null);
  const known = new Map(list.map(item => [keyOf(item), item]));
  const kids = new Map();
  const parentKey = item => {
    const parent = parentOf(item);
    return parent !== null && parent !== undefined && parent !== keyOf(item) && known.has(parent) ? parent : null;
  };
  for (const item of list) {
    const parent = parentKey(item);
    if (parent === null) continue;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(item);
  }
  const bySiblingOrder = (a, b) => statusRank(a) - statusRank(b) || compare(a, b);
  const seen = new Set();
  // A node and its best (lowest) open rank; null for a tree without an open task.
  const build = (item, depth) => {
    seen.add(keyOf(item));
    const children = [];
    let best = isFinished(item) ? null : statusRank(item);
    for (const child of (kids.get(keyOf(item)) || []).slice().sort(bySiblingOrder)) {
      if (seen.has(keyOf(child))) continue;
      const built = build(child, depth + 1);
      if (built.best === null) continue; // only finished tasks below: counted, not drawn
      children.push(built.node);
      best = best === null ? built.best : Math.min(best, built.best);
    }
    return { node: { item, depth, children }, best };
  };
  const roots = [];
  for (const item of list) if (parentKey(item) === null) roots.push(item);
  const trees = roots.map(item => build(item, 0));
  // A loop in the data: rows no root reached are top-level rows, in the list order.
  for (const item of list.slice().sort(compare)) if (!seen.has(keyOf(item))) trees.push(build(item, 0));
  const placed = trees.filter(tree => tree.best !== null)
    .sort((a, b) => a.best - b.best || statusRank(a.node.item) - statusRank(b.node.item) || compare(a.node.item, b.node.item));
  const sections = HOME_SECTIONS.map(section => ({ key: section.key, label: section.label, statuses: [...section.statuses], nodes: [] }));
  const byKey = new Map(sections.map(section => [section.key, section]));
  for (const tree of placed) byKey.get(sectionOfRank(tree.best)).nodes.push(tree.node);
  return { sections, done: list.filter(isFinished).length };
}

// The rows of some nodes, top to bottom, with the tree branches of the CLI and the skill (`├ `, `└ `, two more spaces per deeper level, `│ ` under a
// sibling that has more after it). -> [{ item, depth, prefix }]
function homeRows(nodes) {
  const out = [];
  const visit = (node, lead, last) => {
    out.push({ item: node.item, depth: node.depth, prefix: node.depth === 0 ? '' : `${lead}${last ? '└ ' : '├ '}` });
    const next = node.depth === 0 ? '' : `${lead}${last ? '  ' : '│ '}`;
    node.children.forEach((child, index) => visit(child, next, index === node.children.length - 1));
  };
  for (const node of nodes || []) visit(node, '', true);
  return out;
}

module.exports = { HOME_SECTIONS, FINISHED_STATUSES, homeView, homeRows, serverOrder };
