// 节点文件同步：当前引擎拥有自己的主/附属角色与文件清单。
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
      REMOTE_TIMEOUT: '连接主服务器超时', REMOTE_CONNECTION_FAILED: '连不上主服务器，请检查地址和网络',
      SYNC_PAIRING_CODE_INVALID: '配对码格式不对，应为 TA-XXXX-XXXX-XXXX', SYNC_MASTER_URL_INVALID: '主服务器地址不正确',
      PAIRING_CODE_INVALID_OR_EXPIRED: '配对码无效或已过期（10 分钟内有效，只能使用一次）', PAIRING_CODE_ALREADY_USED: '配对码已被使用，请重新生成',
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
      $('file-sync-pair').hidden = !master;
      $('file-sync-join').hidden = !master;
      $('file-sync-disconnect').hidden = master;
      $('file-sync-master-actions').hidden = !master;
      $('file-sync-role').textContent = master ? '当前角色：主服务器' : `当前角色：附属服务器（主服务器连接 #${next.master_id}）`;
      $('file-sync-children').hidden = !master;
      const children = Array.isArray(next.children) ? next.children : [];
      $('file-sync-children-hint').textContent = !Array.isArray(next.children)
        ? '当前引擎需要升级后才能显示附属服务器。'
        : children.length ? `已登记 ${children.length} 台附属服务器；超过约 15 秒没有心跳会显示离线。` : '暂无已登记的附属服务器。附属节点完成连接或下一轮同步后会显示在这里。';
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
    for (const id of ['file-sync-pair', 'file-sync-join', 'file-sync-disconnect', 'file-sync-run', 'file-sync-add']) {
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
  $('file-sync-pair').addEventListener('click', async () => {
    try {
      const paired = await API.post(`${endpoint}/pairing`, {});
      const address = endpoint === '/api/file-sync' ? location.origin : '';
      Modal.show('配对码', `<div class="form-hint">在要加入的服务器上打开“文件同步”→“加入主服务器”，填入下面的信息。配对码 ${Math.round(paired.expires_in_seconds / 60)} 分钟内有效，只能使用一次。</div>${address ? `<label>主服务器地址<input type="text" readonly value="${escapeHtml(address)}"></label>` : ''}<label>配对码<input id="sync-pair-code" type="text" readonly value="${escapeHtml(paired.code)}"></label><div class="form-hint">地址以对方服务器能访问到的为准（局域网 IP、域名或隧道地址）。配对码相当于一次性的管理权限，请只发给自己的服务器。</div>`);
      $('sync-pair-code').select();
    } catch (error) { message(`生成失败：${errorText(error)}`); }
  });
  $('file-sync-join').addEventListener('click', () => {
    Modal.show('加入主服务器', `<label>主服务器地址<input id="sync-join-url" type="text" placeholder="http://192.168.1.5:3000" autocomplete="off"></label><label>配对码<input id="sync-join-code" type="text" placeholder="TA-XXXX-XXXX-XXXX" autocomplete="off"></label><div class="form-hint">加入后，本节点现有同步清单由主服务器的清单替换，并下载其文件内容；与本地不同的文件会先备份。</div><div class="form-actions"><button type="button" class="btn-submit" id="sync-join-save">加入</button></div>`);
    $('sync-join-save').addEventListener('click', async () => {
      const url = $('sync-join-url').value.trim();
      const code = $('sync-join-code').value.trim();
      if (!url || !code) return;
      Modal.hide();
      await run(() => API.post(`${endpoint}/join`, { url, code }));
    });
  });
  $('file-sync-disconnect').addEventListener('click', () => {
    if (confirm('恢复为主服务器？同步清单会清空，本地文件保留。')) run(() => API.post(`${endpoint}/disconnect`, {}));
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
