// The environment page: which features of the machine running the Client will have problems, and what to do about each.
// The checks run on the server (GET /api/environment/check); this only draws the report. Everything is put in with textContent.
const EnvironmentCheck = (() => {
  const $ = id => document.getElementById(id);
  const ORDER = { fail: 0, warn: 1, ok: 2, info: 3 };
  const WORD = { fail: 'Will not work', warn: 'Needs attention', ok: 'Works', info: 'Not in use' };
  const ICON = { fail: '✕', warn: '!', ok: '✓', info: '–' };
  let active = false;
  let loaded = false;
  let running = false;
  let local = true;
  let label = '';

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Text with `code` pieces: the pieces between backticks are shown as code.
  function withCode(tag, className, text) {
    const node = el(tag, className);
    String(text).split('`').forEach((piece, index) => {
      if (!piece) return;
      node.append(index % 2 ? el('code', '', piece) : document.createTextNode(piece));
    });
    return node;
  }

  const badge = status => {
    const node = el('span', `env-badge ${status}`, ICON[status]);
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', WORD[status]);
    return node;
  };

  function renderCheck(check) {
    const row = el('li', `env-check ${check.status}`);
    const head = el('div', 'env-check-head');
    head.append(badge(check.status), el('span', 'env-check-name', check.name));
    row.append(head);
    if (check.detail) row.append(el('div', 'env-check-detail', check.detail));
    if (check.impact) { const line = el('div', 'env-impact'); line.append(el('strong', '', 'Affects: '), document.createTextNode(check.impact)); row.append(line); }
    if (check.fix) { const line = el('div', 'env-fix'); line.append(el('strong', '', 'What to do: '), withCode('span', '', check.fix)); row.append(line); }
    return row;
  }

  // A feature is open when something is wrong with it; the ones that work are folded.
  function renderFeature(feature) {
    const card = el('details', `tool-card tool-card-wide env-feature ${feature.status}`);
    card.open = feature.status === 'fail' || feature.status === 'warn';
    card.dataset.feature = feature.id;
    const head = el('summary', 'env-feature-head');
    head.append(badge(feature.status));
    const title = el('span', 'env-feature-title');
    title.append(el('span', 'env-feature-name', feature.name), el('span', 'env-feature-desc', feature.description));
    head.append(title, el('span', `env-feature-state ${feature.status}`, WORD[feature.status]));
    card.append(head);
    const problems = feature.checks.filter(check => check.status === 'fail' || check.status === 'warn');
    if (problems.length) {
      const list = el('ul', 'env-affects');
      for (const impact of new Set(problems.map(check => check.impact).filter(Boolean))) list.append(el('li', '', impact));
      if (list.children.length) { card.append(el('div', 'env-affects-title', feature.status === 'fail' ? 'What will not work' : 'What may not work'), list); }
    }
    const checks = el('ul', 'env-checks');
    for (const check of feature.checks) checks.append(renderCheck(check));
    card.append(checks);
    return card;
  }

  function render(report) {
    const features = report.features.map((feature, index) => ({ feature, index })).sort((x, y) => ORDER[x.feature.status] - ORDER[y.feature.status] || x.index - y.index).map(item => item.feature);
    const failed = features.filter(feature => feature.status === 'fail').length;
    const warned = features.filter(feature => feature.status === 'warn').length;
    const fine = features.length - failed - warned;
    const summary = $('env-summary');
    summary.replaceChildren();
    summary.className = `env-summary ${failed ? 'fail' : warned ? 'warn' : 'ok'}`;
    summary.append(
      el('span', 'env-headline', failed ? `${failed} ${failed === 1 ? 'feature' : 'features'} will not work` : warned ? `${warned} ${warned === 1 ? 'feature needs' : 'features need'} attention` : 'Everything checked works'),
    );
    if (failed || warned) summary.append(el('span', 'env-counts', `${failed} will not work · ${warned} need attention · ${fine} fine`));
    $('env-machine').textContent = `${report.machine.platform} · Node ${report.machine.node} · ${report.machine.arch} · user ${report.machine.user} · checked ${new Date(report.checked_at).toLocaleTimeString()}`;
    $('env-features').replaceChildren(...features.map(renderFeature));
  }

  async function load() {
    if (running) return;
    running = true;
    const button = $('env-recheck');
    button.disabled = true;
    button.textContent = 'Checking…';
    $('env-summary').className = 'env-summary';
    if (!loaded) $('env-summary').replaceChildren(el('span', 'env-headline', 'Checking this machine…'));
    try {
      render(await API.get('/api/environment/check'));
      loaded = true;
    } catch (error) {
      $('env-summary').className = 'env-summary fail';
      $('env-summary').replaceChildren(el('span', 'env-headline', 'The check could not be run'), el('span', 'env-counts', String(error.message || '').slice(0, 200)));
    } finally {
      running = false;
      button.disabled = false;
      button.textContent = 'Check again';
    }
  }

  function setEngine(engine) {
    local = engine.local;
    label = engine.label || '';
    const node = $('env-engine');
    node.replaceChildren();
    if (!local) node.append('This page checks the machine running the Client, not the remote engine ', el('strong', '', label));
  }

  function setActive(value) {
    active = value;
    if (active && !loaded) void load();
  }

  const button = $('env-recheck');
  if (button) button.addEventListener('click', () => void load());
  return { setActive, setEngine, load, render, get active() { return active; } };
})();
