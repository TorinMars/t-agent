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
      REMOTE_TIMEOUT: '连接对方超时', REMOTE_CONNECTION_FAILED: '连不上主服务器，请检查连接字符串里的地址和本机网络',
      SYNC_PAIRING_CODE_INVALID: '配对码格式不对，应为 TA-XXXX-XXXX-XXXX', SYNC_MASTER_URL_INVALID: '地址不正确',
      SYNC_CONNECTION_STRING_INVALID: '连接字符串不正确，请完整复制主服务器生成的内容', SYNC_NOT_CHILD: '只有从服务器可以这样操作', SYNC_ROLE_INVALID: '角色无效',
      PAIRING_RATE_LIMITED: '尝试过于频繁，请稍后再试',
      PAIRING_CODE_INVALID_OR_EXPIRED: '连接字符串已过期或已被使用（10 分钟内有效，只能使用一次），请在主服务器重新生成', PAIRING_CODE_ALREADY_USED: '配对码已被使用，请重新生成',
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
      $('file-sync-invite').hidden = !master;
      $('file-sync-disconnect').hidden = master || waiting;
      $('file-sync-run').hidden = waiting;
      $('file-sync-master-actions').hidden = !master;
      $('file-sync-role').textContent = master ? '当前角色：主服务器'
        : waiting ? '当前角色：从服务器（尚未关联主服务器）' : `当前角色：从服务器（主服务器：${next.master_url || `连接 #${next.master_id}`}）`;
      $('file-sync-join-box').hidden = !waiting;
      $('file-sync-children').hidden = !master;
      const children = Array.isArray(next.children) ? next.children : [];
      $('file-sync-children-hint').textContent = !Array.isArray(next.children)
        ? '当前引擎需要升级后才能显示从服务器。'
        : children.length ? `已登记 ${children.length} 台从服务器；超过约 15 秒没有心跳会显示离线。` : '暂无已登记的从服务器。点“生成连接字符串”，复制到从服务器上连接。';
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
    for (const id of ['file-sync-role-select', 'file-sync-invite', 'file-sync-connect', 'file-sync-disconnect', 'file-sync-run', 'file-sync-add']) {
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
      ? '切换为从服务器？本节点的同步清单会清空（本地文件保留），然后粘贴主服务器的连接字符串来连接。'
      : '切换为主服务器？与当前主服务器的关联会解除，同步清单会清空（本地文件保留）。';
    if (!confirm(text)) { refresh(); return; }
    await run(() => API.put(`${endpoint}/role`, { role }));
  });
  async function copyText(input, okText) {
    input.select();
    try { await navigator.clipboard.writeText(input.value); message(okText); }
    catch { message('请手动复制选中的内容'); }
  }
  $('file-sync-invite').addEventListener('click', () => {
    const local = endpoint === '/api/file-sync';
    Modal.show('生成连接字符串', `<label>主服务器地址（从服务器用它来连接）<input id="sync-invite-url" type="text" placeholder="http://主服务器公网地址:3000" autocomplete="off"></label><div class="form-hint">填写从服务器能访问到的本主服务器地址（公网 IP、域名或隧道地址，带 <code>/web</code> 也行）。连接字符串包含这个地址和一个 10 分钟内有效、只能使用一次的配对码；每台从服务器各生成一个。字符串相当于一次性的访问凭据，只发给自己的服务器，跨公网请使用 HTTPS 地址。</div><div class="form-actions"><button type="button" class="btn-submit" id="sync-invite-make">生成</button></div><div id="sync-invite-result" hidden><label>连接字符串<textarea class="form-input" id="sync-invite-string" rows="4" readonly spellcheck="false"></textarea></label><div class="form-hint" id="sync-invite-hint"></div><div class="form-actions"><button type="button" class="btn-submit" id="sync-invite-copy">复制</button></div></div>`);
    if (local) $('sync-invite-url').value = location.origin;
    $('sync-invite-make').addEventListener('click', async () => {
      const master_url = $('sync-invite-url').value.trim();
      if (!master_url) return;
      try {
        const invite = await API.post(`${endpoint}/invite`, { master_url });
        $('sync-invite-string').value = invite.connection_string;
        $('sync-invite-hint').textContent = `到 ${new Date(invite.expires_at).toLocaleTimeString()} 过期，只能使用一次。`;
        $('sync-invite-result').hidden = false;
        $('sync-invite-string').select();
      } catch (error) { message(`生成失败：${errorText(error)}`); }
    });
    $('sync-invite-copy').addEventListener('click', () => copyText($('sync-invite-string'), '连接字符串已复制'));
  });
  $('file-sync-connect').addEventListener('click', async () => {
    const connection_string = $('file-sync-join-input').value.trim();
    if (!connection_string) return;
    await run(() => API.post(`${endpoint}/join`, { connection_string }));
    $('file-sync-join-input').value = '';
  });
  $('file-sync-disconnect').addEventListener('click', () => {
    if (confirm('解除与主服务器的关联？同步清单会清空，本地文件保留；之后可粘贴新的连接字符串重新连接。')) run(() => API.post(`${endpoint}/unpair`, {}));
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
