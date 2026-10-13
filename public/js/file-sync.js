// 节点文件同步：当前引擎拥有自己的主/从角色与文件清单。
const FileSyncUI = (() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let endpoint = '/api/file-sync', active = false, timer = null, generation = 0, state = null, blocked = null;
  const errorText = error => {
    let code = error.message;
    try { code = JSON.parse(code).error || code; } catch {}
    return ({ SYNC_NOT_MASTER: '只有主服务器能修改文件清单', SYNC_MASTER_NOT_FOUND: '找不到主服务器连接',
      SYNC_PATH_INVALID: '请输入用户目录下的路径或绝对路径', SYNC_PATH_DUPLICATE: '这个本地路径已经被其他同步文件使用',
      SYNC_CONFLICT: '文件版本冲突，请检查两端内容', SYNC_FILE_INVALID: '文件不是普通文件或超过 1 MB',
      SYNC_CONTENT_INVALID: '文件内容无效', REMOTE_HTTP_404: '目标节点版本过旧，请先更新',
      REMOTE_TIMEOUT: '连接对方超时', REMOTE_CONNECTION_FAILED: '连不上对方，请检查地址和网络（从服务器也必须能访问到主服务器地址）',
      SYNC_PAIRING_CODE_INVALID: '配对码格式不对，应为 TA-XXXX-XXXX-XXXX', SYNC_MASTER_URL_INVALID: '地址不正确',
      SYNC_NOT_AWAITING_PAIRING: '对方当前不是等待关联的从服务器，请先在对方把角色设为“从服务器”', SYNC_NOT_CHILD: '只有从服务器可以这样操作', SYNC_ROLE_INVALID: '角色无效',
      PAIRING_RATE_LIMITED: '尝试过于频繁，请稍后再试',
      PAIRING_CODE_INVALID_OR_EXPIRED: '配对码无效或已过期（10 分钟内有效，只能使用一次，猜错多次会自动换新）', PAIRING_CODE_ALREADY_USED: '配对码已被使用，请重新生成',
      REMOTE_HTTP_429: '尝试过于频繁，请稍后再试', SYNC_SELF_CONNECTION: '不能加入自己' })[code] || code;
  };
  function message(text) { $('file-sync-status').textContent = text || ''; }
  async function refresh() {
    if (blocked) { message(blocked); return; }
    const current = ++generation;
    try {
      const next = await API.get(endpoint);
      if (current !== generation) return;
      state = next;
      const master = next.role === 'master';
      const waiting = !master && next.master_id == null && !next.master_url;
      $('file-sync-role-select').value = master ? 'master' : 'slave';
      $('file-sync-associate').hidden = !master;
      $('file-sync-disconnect').hidden = master || waiting;
      $('file-sync-run').hidden = waiting;
      $('file-sync-master-actions').hidden = !master;
      $('file-sync-role').textContent = master ? '当前角色：主服务器'
        : waiting ? '当前角色：从服务器（尚未关联主服务器）' : `当前角色：从服务器（主服务器：${next.master_url || `连接 #${next.master_id}`}）`;
      $('file-sync-code-box').hidden = !waiting;
      if (waiting && next.pairing) {
        const address = endpoint === '/api/file-sync' ? `（本机地址：${location.origin}，以主服务器能访问到的为准）` : '';
        $('file-sync-code').value = next.pairing.code;
        $('file-sync-code-hint').textContent = `在主服务器的“文件同步”页点“关联从服务器”，填入本机地址和下面的配对码${address}。配对码只能使用一次，到 ${new Date(next.pairing.expires_at).toLocaleTimeString()} 过期后自动更换。`;
      }
      $('file-sync-children').hidden = !master;
      const children = Array.isArray(next.children) ? next.children : [];
      $('file-sync-children-hint').textContent = !Array.isArray(next.children)
        ? '当前引擎需要升级后才能显示从服务器。'
        : children.length ? `已登记 ${children.length} 台从服务器；超过约 15 秒没有心跳会显示离线。` : '暂无已登记的从服务器。点“关联从服务器”，填入从服务器的地址和配对码。';
      $('file-sync-children-table').hidden = !children.length;
      const childrenBody = $('file-sync-children-body');
      childrenBody.replaceChildren();
      for (const child of children) {
        const tr = document.createElement('tr');
        const values = [`${child.name} · ${child.id.slice(0, 8)}`, child.online ? '在线' : '离线',
          child.last_sync_at ? new Date(child.last_sync_at).toLocaleString() : '尚未同步',
          child.last_seen_at ? new Date(child.last_seen_at).toLocaleString() : '未知',
          child.error || '—'];
        values.forEach((value, index) => {
          const td = document.createElement('td');
          td.textContent = value;
          if (index === 0) td.title = child.id;
          tr.append(td);
        });
        childrenBody.append(tr);
      }
      const body = $('file-sync-body');
      body.replaceChildren();
      for (const file of next.files) {
        const tr = document.createElement('tr');
        for (const value of [file.path, file.local_path, file.path_required ? '需要设置本地路径' : file.backup ? `已存在 · 原文件备份：${file.backup}` : file.exists ? '已存在' : '缺失', String(file.version)]) {
          const td = document.createElement('td'); td.textContent = value; tr.append(td);
        }
        const action = document.createElement('td');
        if (master) {
          const remove = document.createElement('button'); remove.className = 'btn-logout'; remove.textContent = '移除';
          remove.addEventListener('click', async () => {
            if (!confirm(`从同步清单移除 ${file.path}？本地文件不会删除。`)) return;
            await run(() => API.put(`${endpoint}/files`, { files: state.files.filter(item => item.path !== file.path).map(item => item.path) }));
          });
          action.append(remove);
        } else {
          const edit = document.createElement('button'); edit.className = 'btn-logout'; edit.textContent = '修改本地路径';
          edit.addEventListener('click', () => {
            Modal.show('修改本地路径', `<label>本地路径<input id="sync-local-path" type="text" autocomplete="off"></label><div class="form-hint">主服务器路径：${escapeHtml(file.path)}。留空恢复默认路径；默认路径在本节点为 ${escapeHtml(file.default_path)}。切换路径后，首次下载会备份目标位置已有的不同内容。</div><div class="form-actions"><button type="button" class="btn-submit" id="sync-local-save">保存</button></div>`);
            const input = $('sync-local-path');
            input.value = file.path_override || file.default_path;
            $('sync-local-save').addEventListener('click', async () => {
              const value = input.value.trim();
              Modal.hide();
              await run(() => API.put(`${endpoint}/path`, { path: file.path, local_path: value === file.default_path ? '' : value }));
            });
          });
          action.append(edit);
        }
        tr.append(action); body.append(tr);
      }
      message(next.error ? `同步错误：${next.error}` : next.registration_error ? `主服务器节点登记失败：${next.registration_error}` : next.last_sync_at ? `上次检查：${new Date(next.last_sync_at).toLocaleString()}` : '等待首次检查');
      const conflict = next.error?.startsWith('SYNC_CONFLICT:') ? next.error.slice('SYNC_CONFLICT:'.length) : null;
      if (conflict) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn-logout';
        button.textContent = '备份本地冲突文件并使用主服务器版本';
        button.addEventListener('click', () => {
          if (confirm(`将备份 ${conflict} 的本地内容，然后使用主服务器版本。继续吗？`)) {
            run(() => API.post(`${endpoint}/resolve`, { path: conflict }));
          }
        });
        $('file-sync-status').append(' ', button);
      }
    } catch (error) { if (current === generation) message(`读取失败：${errorText(error)}`); }
  }
  async function run(action) {
    try { message('处理中…'); await action(); await refresh(); }
    catch (error) { message(`操作失败：${errorText(error)}`); }
  }
  function setEngine({ base, label, unavailable }) {
    endpoint = base;
    blocked = unavailable;
    $('file-sync-engine').textContent = `当前引擎：${label}${unavailable ? ` · ${unavailable}` : ''}`;
    for (const id of ['file-sync-role-select', 'file-sync-associate', 'file-sync-code-refresh', 'file-sync-disconnect', 'file-sync-run', 'file-sync-add']) {
      $(id).disabled = Boolean(unavailable);
    }
    generation++;
    if (active) { if (unavailable) { message(unavailable); $('file-sync-body').replaceChildren(); } else refresh(); }
  }
  function setActive(value) {
    active = value;
    clearInterval(timer);
    if (active) { refresh(); timer = setInterval(refresh, 5000); }
  }
  $('file-sync-run').addEventListener('click', () => run(() => API.post(`${endpoint}/run`, {})));
  $('file-sync-role-select').addEventListener('change', async event => {
    const role = event.target.value;
    const text = role === 'slave'
      ? '切换为从服务器？本节点的同步清单会清空（本地文件保留），并生成配对码等待主服务器关联。'
      : '切换为主服务器？与当前主服务器的关联会解除，同步清单会清空（本地文件保留）。';
    if (!confirm(text)) { refresh(); return; }
    await run(() => API.put(`${endpoint}/role`, { role }));
  });
  $('file-sync-code-copy').addEventListener('click', async () => {
    const input = $('file-sync-code');
    input.select();
    try { await navigator.clipboard.writeText(input.value); message('配对码已复制'); }
    catch { message('请手动复制选中的配对码'); }
  });
  $('file-sync-code-refresh').addEventListener('click', () => run(() => API.post(`${endpoint}/refresh-code`, {})));
  $('file-sync-associate').addEventListener('click', () => {
    const local = endpoint === '/api/file-sync';
    Modal.show('关联从服务器', `<label>从服务器地址<input id="sync-slave-url" type="text" placeholder="http://192.168.1.8:3000" autocomplete="off"></label><label>从服务器上显示的配对码<input id="sync-slave-code" type="text" placeholder="TA-XXXX-XXXX-XXXX" autocomplete="off"></label><label>本主服务器地址（从服务器用它来同步）<input id="sync-master-url" type="text" placeholder="http://192.168.1.5:3000" autocomplete="off"></label><div class="form-hint">先在从服务器的“文件同步”页把角色设为“从服务器”，那里会显示配对码。两个地址都以对方能访问到的为准（局域网 IP、域名或隧道地址）；从服务器必须能访问到主服务器地址。关联后，从服务器现有的同步清单由本主服务器的清单替换，并下载文件内容；与本地不同的文件会先备份。</div><div class="form-actions"><button type="button" class="btn-submit" id="sync-associate-save">关联</button></div>`);
    if (local) $('sync-master-url').value = location.origin;
    $('sync-associate-save').addEventListener('click', async () => {
      const slave_url = $('sync-slave-url').value.trim();
      const code = $('sync-slave-code').value.trim();
      const master_url = $('sync-master-url').value.trim();
      if (!slave_url || !code || !master_url) return;
      Modal.hide();
      await run(() => API.post(`${endpoint}/associate`, { slave_url, code, master_url }));
    });
  });
  $('file-sync-disconnect').addEventListener('click', () => {
    if (confirm('解除与主服务器的关联？同步清单会清空，本地文件保留，并生成新的配对码。')) run(() => API.post(`${endpoint}/unpair`, {}));
  });
  $('file-sync-add').addEventListener('click', () => {
    Modal.show('添加同步文件', `<label>文件路径<input id="sync-new-path" type="text" placeholder="~/.claude/settings.json" autocomplete="off"></label><div class="form-hint">用户目录路径会在各节点解析为各自的用户目录。绝对路径在所有节点按原样使用。</div><div class="form-actions"><button type="button" class="btn-submit" id="sync-new-save">添加</button></div>`);
    $('sync-new-save').addEventListener('click', async () => {
      const path = $('sync-new-path').value.trim();
      if (!path) return;
      Modal.hide();
      await run(() => API.put(`${endpoint}/files`, { files: [...state.files.map(file => file.path), path] }));
    });
  });
  return { setEngine, setActive };
})();
