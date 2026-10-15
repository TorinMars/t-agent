// 英文词典：应用列表、Agent 配置、内网穿透 / SSH 隧道、文件同步、引擎（远程连接）、工作目录工具。
I18n.add({
  // ---- 应用列表 ----
  '这台机器上的服务清单。PM2 里的进程会自动登记；其他服务可以手动新增，也可以让程序启动时通过接口自注册（见下方说明）。端口和 IP 尽量自动检测，域名需要手动填写。': 'Services on this machine. PM2 processes are registered automatically; other services can be added manually or register themselves through the API at startup (see below). Ports and IPs are detected automatically where possible; domains must be entered by hand.',
  '找不到这个应用': 'App not found', '已有同名应用': 'An app with this name already exists', '这个 PM2 进程已经关联了别的应用': 'This PM2 process is already linked to another app', '名称不能为空': 'Name cannot be empty', '内容太长': 'Content is too long', '内容含有不允许的字符': 'Content contains disallowed characters',
  '端口必须是 1-65535 的整数': 'Port must be an integer between 1 and 65535', 'IP 格式不正确': 'Invalid IP format', '域名格式不正确，例如 app.example.com': 'Invalid domain format, e.g. app.example.com', '地址只支持不含账号密码的 http:// 或 https://': 'Only http:// or https:// addresses without credentials are supported',
  '协议只能是 http 或 https': 'Protocol must be http or https', '路径必须以 / 开头且不含空白': 'Path must start with / and contain no whitespace', '该引擎版本过旧，暂不支持应用列表，请先升级该引擎': 'This engine is too old to support the app list. Please upgrade it', '应用列表服务暂时不可用': 'The app list service is temporarily unavailable',
  '未检测到 pm2': 'pm2 not detected', 'PM2 守护进程没有运行': 'The PM2 daemon is not running', '该引擎版本过旧，暂不支持 PM2 管理': 'This engine is too old to support PM2 management', 'pm2 命令执行失败': 'pm2 command failed', 'PM2 管理服务暂时不可用': 'PM2 management is temporarily unavailable',
  '这个远程连接已不存在': 'This remote connection no longer exists', '该引擎的认证已失效': 'This engine\'s authentication has expired', '无法连接该引擎': 'Cannot connect to this engine', '连接该引擎超时': 'Connecting to this engine timed out',
  '程序注册': 'Self-registered', '在新标签页打开': 'Open in a new tab:', '进程不存在': 'Process not found', 'PM2 里没有': 'PM2 has no process', '」': '"', '「': '"', 'PM2 不可用': 'PM2 unavailable', '未关联 PM2': 'Not linked to PM2', '已设置': 'Set', '另有 ': 'Also: ', '未检测到': 'Not detected',
  'IP · 仅本机监听': 'IP · listening on localhost only', '暂无（可编辑补充端口或域名）': 'None (edit to add a port or domain)', '恢复已隐藏的': 'Restore hidden',
  '还没有应用。点击“新增应用”手动登记，或让程序通过接口自注册；PM2 里的进程会自动出现在这里。': 'No apps yet. Click "Add app" to register one manually, or let programs register themselves through the API; PM2 processes appear here automatically.',
  '更新于': 'Updated at', '读取失败：': 'Read failed: ', '确定停止': 'Stop', '就是当前正在提供本页面的 t-agent。': 'is the t-agent currently serving this page. ', '后页面会中断': ' will interrupt the page', '，并且需要在这台机器上手动启动才能恢复': ' and you will need to start it manually on this machine to recover', '几秒': ' for a few seconds', '继续吗？': 'Continue?',
  '请求已发出，页面可能会短暂断开': 'Request sent; the page may disconnect briefly', '日志类型': 'Log type', '标准输出': 'Standard output', '错误输出': 'Error output', '行数': 'Lines', '最近 100 行': 'Last 100 lines', '最近 300 行': 'Last 300 lines', '最近 1000 行': 'Last 1000 lines', '读取日志失败：': 'Could not read logs: ',
  '编辑应用：': 'Edit app: ', '自动：': 'Auto: ', '留空则自动检测': 'Leave empty to auto-detect', '留空则使用本机局域网 IP': 'Leave empty to use this machine\'s LAN IP', '例如 博客': 'e.g. Blog', '这个服务是做什么的（可选）': 'What this service does (optional)', 'PM2 进程名': 'PM2 process name', '关联 PM2 进程（可选）': 'Link a PM2 process (optional)',
  '填写后可以在这里直接启动、停止、重启和看日志。名称与 PM2 进程同名时会自动关联。': 'Once set, you can start, stop, restart and view logs here. The app is linked automatically when its name matches a PM2 process.', '手动填写会覆盖自动检测到的端口。': 'A manual value overrides the auto-detected port.',
  '访问地址（IP）': 'Address (IP)', '其他设备访问时用的 IP；IPv6 不要加方括号。': 'IP used when other devices connect; do not add brackets for IPv6.', '访问地址（域名）': 'Address (domain)', '有域名才填；可以直接写完整地址。': 'Only if you have a domain; a full address is fine.',
  '用于“IP:端口”访问；域名只写主机名时也用它。域名写成完整地址（如 https://app.example.com）则以写的为准，这样 IP 走 http、域名走 https 也可以。': 'Used for "IP:port" access, and also when the domain is just a hostname. If the domain is a full address (such as https://app.example.com), that wins, so IP over http and domain over https works too.',
  '/（默认）': '/ (default)', '例如 /admin，点击访问时会带上。': 'e.g. /admin; appended when you click to open.', '自定义完整地址': 'Custom full address', '填了就优先用它作为点击跳转的地址（可选）。': 'If set, this address is used first when clicking through (optional).',
  '已新增': 'Added', '（只是从列表里移除，PM2 进程本身不会被停止或删除；之后可以用“恢复已隐藏”找回。）': '(This only removes it from the list; the PM2 process itself is not stopped or deleted. You can bring it back with "Restore hidden".)', '确定删除应用': 'Delete app', '已从列表隐藏': 'Hidden from the list:', '（PM2 进程未受影响）': '(the PM2 process is unaffected)', '恢复失败：': 'Restore failed: ',
  '（选中远程引擎时，请在该引擎所在机器上，用它自己的地址调用同样的接口）': '(With a remote engine selected, call the same endpoint on that engine\'s machine using its own address)',
  '该引擎版本过旧，暂不支持 PM2 管理，请先升级该引擎。': 'This engine is too old to support PM2 management. Please upgrade it.', '该引擎版本过旧，暂不支持应用列表，请先升级该引擎。': 'This engine is too old to support the app list. Please upgrade it.', '该引擎版本过旧，暂不支持文件同步，请先升级该引擎。': 'This engine is too old to support file sync. Please upgrade it.',
  '该引擎当前无法连接，请先在顶部引擎栏处理连接问题。': 'This engine cannot be reached right now. Fix the connection in the engine bar at the top first.', '正在读取该引擎的能力…': 'Reading this engine\'s capabilities…', '当前引擎：': 'Current engine: ', '（运行 Client 的这台机器）': '(the machine running the Client)', '（远程引擎所在机器）': '(the machine running the remote engine)',
  '复制失败，请检查浏览器剪贴板权限': 'Copy failed. Check the browser clipboard permission', '服务说明': 'service description', '访问令牌': 'access-token',

  // ---- Agent 配置 ----
  '该服务器的 Engine 版本过旧，请先升级': 'This server\'s engine is too old. Please upgrade it first', '该机器上的配置文件格式不对，已跳过': 'The configuration file on that machine has an invalid format; skipped', '令牌无效或已被撤销': 'Token is invalid or has been revoked',
  '跟随全局默认': 'Follow global default', '这台不管': 'Leave unmanaged on this server', '不设置（保持原样）': 'Not set (keep as is)', '常用：': 'Common: ', '留空 = 跟随全局默认': 'Empty = follow global default', '留空 = 不设置': 'Empty = not set', '本机（运行 Client 的这台）': 'This machine (running the Client)',
  '尚未推送': 'Not pushed yet', '失败：': 'failed: ', '覆盖': 'Override', '查看当前': 'View current', '推送': 'Push', '的覆盖': ' override', '的当前配置': ' current configuration',
  '只填这台服务器需要不同的项；留空的项沿用全局默认。选“这台不管”表示推送时不改这台的该项。': 'Only fill in items that should differ on this server; empty items use the global default. "Leave unmanaged" means that item is not changed on this server when pushing.',
  '保存覆盖': 'Save override', '覆盖已保存，推送后生效': 'Override saved; it takes effect after pushing', '正在读取…': 'Reading…', '正在推送…': 'Pushing…', '全局默认已保存，推送后才会写到各服务器': 'Global defaults saved; they reach each server only after pushing', '（见列表）': '(see the list)',
  '已推送到': 'Pushed to', '台服务器': 'servers', '已推送': 'Pushed', '台失败': 'failed',

  // ---- 内网穿透（frp） ----
  '未找到 frpc：请先安装 frp（0.52 及以上），或用 T_AGENT_FRPC_BIN 指定路径': 'frpc not found: install frp (0.52 or later) or set its path with T_AGENT_FRPC_BIN', '请先填写 frps 服务器 IP 或域名': 'Enter the frps server IP or domain first', '服务器地址必须是 IP 或域名': 'The server address must be an IP or domain',
  '服务端口必须是 1-65535 的整数': 'The server port must be an integer between 1 and 65535', '本地端口必须是 1-65535 的整数': 'The local port must be an integer between 1 and 65535', 'Token 含有不允许的字符': 'Token contains disallowed characters', '随机端口范围不正确': 'Invalid random port range',
  '隧道已经在运行': 'The tunnel is already running', '无法启动 frpc': 'Cannot start frpc', '远程端口必须是 1-65535 的整数': 'The remote port must be an integer between 1 and 65535', 'frpc 版本过旧，需要 0.52 及以上': 'frpc is too old; 0.52 or later is required', '正在安装 frpc': 'Installing frpc', '已经安装了 frpc': 'frpc is already installed',
  '内网穿透服务暂时不可用': 'The tunnel service is temporarily unavailable', '已停止': 'Stopped', '启动中…': 'Starting…', '运行中': 'Running', '正在安装 frpc…': 'Installing frpc…', '未检测到 frpc': 'frpc not detected', '公网地址': 'Public address', '（反向代理到 ': '(reverse proxy to ',
  '未检测到 frpc（已查找 PATH、Homebrew 和 Client 的 data/bin）': 'frpc not detected (searched PATH, Homebrew and the Client\'s data/bin)', '版本过旧，需要 0.52 及以上': 'Version too old; 0.52 or later is required', '远程端口（手动）': 'Remote port (manual)', '远程端口（自动随机）': 'Remote port (auto random)',
  '已手动指定：被占用时不会自动换端口，且需在 frps 的 allowPorts 内。清空后保存恢复自动随机。': 'Set manually: if the port is taken it is not changed automatically, and it must be within frps allowPorts. Clear it and save to return to auto random.', '已手动指定：被占用时不会自动换端口。清空后保存恢复自动随机。': 'Set manually: if the port is taken it is not changed automatically. Clear it and save to return to auto random.',
  '生成后保持稳定；也可直接填写固定端口。': 'stays stable once generated; you can also enter a fixed port.', '自动随机（': 'Auto random (', '已保存（留空保持不变）': 'Saved (leave empty to keep)', '没有则留空': 'Leave empty if none', '（本 Client 端口）': '(this Client\'s port)', '正在安装…': 'Installing…', '保存并重启': 'Save and restart',
  '开始安装 frpc，请稍候': 'Installing frpc, please wait', '是否让 Agent 帮你安装 frpc？选“是”会复制安装提示词，粘贴给 Agent（例如本机终端里的 Claude Code / Codex）即可。': 'Have an Agent install frpc for you? Choosing "Yes" copies an install prompt; paste it to an Agent (for example Claude Code / Codex in a local terminal).',
  '否，由 Client 直接下载': 'No, let the Client download it', '是，复制 Agent 提示词': 'Yes, copy the Agent prompt', '已复制。粘贴给 Agent 执行，完成后回到本页等待自动检测到 frpc。': 'Copied. Paste it to an Agent; when it is done, return to this page and wait for frpc to be detected.', '正在检测…': 'Detecting…', '已检测到 frpc': 'frpc detected', '仍未检测到 frpc': 'frpc still not detected',
  '检测失败：': 'Detection failed: ', '停止失败：': 'Stop failed: ', '重新生成远程端口会重启隧道，之前的反向代理目标需要同步修改。继续吗？': 'Regenerating the remote port restarts the tunnel, and your reverse proxy target must be updated to match. Continue?', '已生成新的远程端口': 'New remote port generated',
  // ---- 书签 ----
  '图标（emoji 或图片 URL，留空自动用 favicon）': 'Icon (emoji or image URL; leave empty to use the favicon)', '自动取 hostname': 'Defaults to the hostname', '🚀 或 https://...': '🚀 or https://...', 'app.example.com 或 https://app.example.com': 'app.example.com or https://app.example.com', 'TA-XXXX-XXXX-XXXX 或 tae_…': 'TA-XXXX-XXXX-XXXX or tae_…',
  // ---- SSH 隧道 ----
  '未找到 ssh 命令，请先安装 OpenSSH 客户端': 'ssh command not found. Please install the OpenSSH client', '请先填写服务器 IP 或域名': 'Enter the server IP or domain first', '请先填写用户名': 'Enter a username first', '用户名格式不正确': 'Invalid username format', 'SSH 端口必须是 1-65535 的整数': 'The SSH port must be an integer between 1 and 65535',
  '私钥路径必须是绝对路径或以 ~/ 开头': 'The private key path must be absolute or start with ~/', '找不到私钥文件，请检查路径；留空则使用 ssh 默认逻辑': 'Private key file not found. Check the path; leave empty to use ssh defaults', '无法启动 ssh': 'Cannot start ssh', 'SSH 隧道服务暂时不可用': 'The SSH tunnel service is temporarily unavailable',
  '连接中…': 'Connecting…', '未检测到 ssh 命令': 'ssh command not detected', '服务器上监听': 'Listening on the server at', '转发到本机': 'forwarding to this machine at',

  // ---- 文件同步 ----
  '只有主服务器能修改文件清单': 'Only the master can edit the file list', '找不到主服务器连接': 'Master connection not found', '请输入用户目录下的路径或绝对路径': 'Enter a path under the home directory or an absolute path', '这个本地路径已经被其他同步文件使用': 'This local path is already used by another synced file',
  '文件版本冲突，请检查两端内容': 'File version conflict. Check both sides', '文件不是普通文件或超过 1 MB': 'The file is not a regular file or exceeds 1 MB', '文件内容无效': 'Invalid file content', '目标节点版本过旧，请先更新': 'The target node is too old. Please update it first', '连接对方超时': 'Timed out connecting to the peer',
  '连不上主服务器，请检查连接字符串里的地址和本机网络': 'Cannot reach the master. Check the address in the connection string and this machine\'s network', '配对码格式不对，应为 TA-XXXX-XXXX-XXXX': 'Invalid pairing code format; it should look like TA-XXXX-XXXX-XXXX', '地址不正确': 'Invalid address',
  '连接字符串不正确，请完整复制主服务器生成的内容': 'Invalid connection string. Copy the full text generated by the master', '只有从服务器可以这样操作': 'Only a slave can do this', '角色无效': 'Invalid role', '尝试过于频繁，请稍后再试': 'Too many attempts. Please try again later',
  '连接字符串已过期或已被使用（10 分钟内有效，只能使用一次），请在主服务器重新生成': 'The connection string has expired or was already used (valid for 10 minutes, single use). Generate a new one on the master', '配对码已被使用，请重新生成': 'The pairing code was already used. Generate a new one', '不能加入自己': 'A node cannot join itself',
  '当前角色：主服务器': 'Current role: master', '当前角色：从服务器（尚未关联主服务器）': 'Current role: slave (not linked to a master yet)', '当前角色：从服务器（主服务器：': 'Current role: slave (master: ', '当前引擎需要升级后才能显示从服务器。': 'This engine must be upgraded before it can list slaves.',
  '已登记': 'Registered', '台从服务器；超过约 15 秒没有心跳会显示离线。': 'slave(s); a slave shows as offline after about 15 seconds without a heartbeat.', '暂无已登记的从服务器。点“生成连接字符串”，复制到从服务器上连接。': 'No slaves registered yet. Click "Generate connection string" and copy it to a slave to connect.',
  '在线': 'Online', '离线': 'Offline', '尚未同步': 'Not synced yet', '需要设置本地路径': 'Local path required', '已存在': 'Exists', '原文件备份：': 'original backed up: ', '缺失': 'Missing', '移除': 'Remove', '从同步清单移除': 'Remove from the sync list:', '？本地文件不会删除。': '? The local file is not deleted.',
  '修改本地路径': 'Change local path', '本地路径': 'Local path', '主服务器路径：': 'Master path: ', '。留空恢复默认路径；默认路径在本节点为 ': '. Leave empty to restore the default path; the default on this node is ', '。切换路径后，首次下载会备份目标位置已有的不同内容。': '. After changing the path, the first download backs up differing content already at the target.',
  '主服务器节点登记失败：': 'Registering this node on the master failed: ', '上次检查：': 'Last check: ', '等待首次检查': 'Waiting for the first check', '备份本地冲突文件并使用主服务器版本': 'Back up the conflicting local file and use the master version', '将备份': 'This backs up', '的本地内容，然后使用主服务器版本。继续吗？': ' local content, then uses the master version. Continue?',
  '切换为从服务器？本节点的同步清单会清空（本地文件保留），然后粘贴主服务器的连接字符串来连接。': 'Switch to slave? This node\'s sync list is cleared (local files are kept); then paste the master\'s connection string to connect.', '切换为主服务器？与当前主服务器的关联会解除，同步清单会清空（本地文件保留）。': 'Switch to master? The link to the current master is removed and the sync list is cleared (local files are kept).',
  '请手动复制选中的内容': 'Copy the selected content manually', '高级：修改主服务器地址': 'Advanced: change the master address', '从服务器用它来连接': 'Slaves use this to connect', '默认使用当前访问的地址，例如 https://主服务器域名': 'Defaults to the address you are using now, e.g. https://master.example.com', '按此地址重新生成': 'Regenerate with this address',
  '字符串含一个 10 分钟内有效、只能使用一次的配对码，每台从服务器各生成一个，只发给自己的服务器，跨公网请使用 HTTPS 地址。': 'The string contains a pairing code valid for 10 minutes and single use. Generate one per slave, send it only to your own server, and use an HTTPS address across the public internet.',
  '到 ': 'Expires at ', ' 过期，只能使用一次。': ', single use.', '生成失败：': 'Generation failed: ', '连接字符串已复制': 'Connection string copied', '解除与主服务器的关联？同步清单会清空，本地文件保留；之后可粘贴新的连接字符串重新连接。': 'Unlink from the master? The sync list is cleared and local files are kept; you can paste a new connection string to reconnect later.',
  '添加同步文件': 'Add sync file', '文件路径': 'File path', '用户目录路径会在各节点解析为各自的用户目录。绝对路径在所有节点按原样使用。': 'Home-directory paths resolve to each node\'s own home directory. Absolute paths are used as-is on every node.',

  // ---- 引擎 / 远程连接 ----
  'URL 格式不正确': 'Invalid URL format', '端口不正确': 'Invalid port', '请输入 Token': 'Enter a token', 'Token 无效或已撤销': 'Token is invalid or has been revoked', '该远程服务已连接': 'This remote service is already connected', '远程服务连接失败': 'Failed to connect to the remote service',
  'URL 只填写协议和主机，不要包含路径': 'Enter only the scheme and host in the URL, without a path', '配对码格式不正确': 'Invalid pairing code format', '配对码无效或已过期': 'The pairing code is invalid or has expired', '当前连接 Token 没有 Engine 管理权限，请改用 owner Token': 'This connection token has no engine management permission. Use an owner token instead',
  '远程 Engine 版本过旧，需要先手动升级一次': 'The remote engine is too old and needs one manual upgrade first', '远程 Engine 未配置版本来源': 'The remote engine has no version source configured', '远程 Engine 工作区有未提交修改': 'The remote engine workspace has uncommitted changes', '远程 Engine 的 Git 分支已经分叉': 'The remote engine\'s Git branch has diverged',
  '远程 Engine 已经是最新版本': 'The remote engine is already up to date', '远程 Engine 正在执行其他更新': 'The remote engine is running another update', '远程 Engine 检查更新失败': 'The remote engine failed to check for updates', '远程 Engine 安装依赖失败': 'The remote engine failed to install dependencies',
  '远程 Engine 构建资源失败': 'The remote engine failed to build assets', '远程 Engine 的终端原生模块校验失败': 'The remote engine\'s terminal native module check failed', '该 Engine 由 Docker 管理，请在宿主机更新镜像': 'This engine is managed by Docker. Update the image on the host', '版本未知': 'Unknown version',
  '编辑连接': 'Edit connection', '移除连接': 'Remove connection', '无法连接「': 'Cannot connect to "', '认证失效': 'Authentication expired', '服务无响应': 'No response from the service', '地址：': 'Address: ', '请检查服务状态：': 'Check the service status:', '连接使用的 Token 已失效或被撤销，请在目标 Client 的“设置”中重新生成配对码': 'The token used by this connection has expired or been revoked. Generate a new pairing code under "Settings" on the target Client',
  '然后点击“编辑连接”，填入新的配对码或 Token': 'then click "Edit connection" and enter the new pairing code or token', '目标 Client / Engine 服务是否正在运行': 'whether the target Client / Engine service is running', '地址和端口是否正确，防火墙、安全组或反向代理是否放行': 'whether the address and port are correct and the firewall, security group or reverse proxy allows it', '在目标机器上确认服务可访问，例如：curl': 'on the target machine, check that the service is reachable, for example: curl',
  '重试连接': 'Retry connection', '正在更新': 'Updating', '发现新版本': 'Update available', '更新被阻断': 'Update blocked', '需要重启服务': 'Service restart needed', 'Docker 镜像更新': 'Docker image update', ' · Engine 更新': ' · Engine update', ' · 检查更新': ' · Check for updates', '目标分支': 'Target branch',
  'Docker Engine 将由宿主机更新脚本拉取新镜像并重建容器。': 'The host update script will pull a new image and recreate the Docker engine container.', '重新检查': 'Check again', '正在让远程 Engine 检查 GitHub 更新…': 'Asking the remote engine to check GitHub for updates…', '更新 ': 'Update ',
  '更新期间远程终端会断开。Engine 完成依赖安装后将自动重启，Client 会等待它恢复。': 'Remote terminals disconnect during the update. The engine restarts automatically after installing dependencies, and the Client waits for it to come back.', '确认更新': 'Confirm update', '正在启动远程更新流程…': 'Starting the remote update…', '更新未启动': 'Update did not start', '远程 Engine 更新失败': 'Remote engine update failed',
  '已升级到': 'upgraded to', '，正在刷新页面…': ', refreshing the page…', 'Engine 正在重启…': 'Engine restarting…', 'Engine 正在更新…': 'Engine updating…', 'Engine 暂时离线，正在等待重启…': 'Engine is offline for now, waiting for it to restart…', '等待 Engine 恢复超时': 'Timed out waiting for the engine to recover', '请检查远程服务进程和日志；更新可能仍在后台执行。': 'Check the remote service process and logs; the update may still be running in the background.',
  '确认移除这个远程连接？远程数据不会被删除。': 'Remove this remote connection? Remote data is not deleted.', '例如 http://192.168.1.20': 'e.g. http://192.168.1.20', '例如 14002': 'e.g. 14002', '配对码或访问 Token': 'Pairing code or access token', '配对码只使用一次；换取的 Token 会加密保存在 Client 服务端。': 'A pairing code is single-use; the token obtained is stored encrypted on the Client server.',
  '测试连接': 'Test connection', '连接成功': 'Connected', '连接成功，Token 有效': 'Connected; the token is valid', '编辑远程连接': 'Edit remote connection', '例如 https://tasks.example.com': 'e.g. https://tasks.example.com', 'HTTPS 默认可留空': 'May be left empty for HTTPS', '允许其他客户端连接本机': 'Allow other clients to connect to this machine',
  '撤销': 'Revoke', '尚未创建 Token': 'No tokens created yet', '撤销后，使用它的远程连接会立即失效。': 'Once revoked, remote connections using it stop working immediately.', '配对码已创建': 'Pairing code created',
  // ---- 工作目录工具 ----
  '当前引擎版本较旧，不支持导入或清理工作目录，请先更新该引擎。': 'This engine is too old to import or clean up the workspace. Please update it first.', '导入工作目录下': 'Import', '个未管理的目录': 'unmanaged directories from the workspace', '导入工作目录下的目录（暂无未管理的目录）': 'Import directories from the workspace (none unmanaged)',
  '以下目录在工作目录里，但还不是任务。勾选后批量导入，只登记任务，不会在目录里创建文件。': 'These directories are in the working directory but are not tasks yet. Tick them to import in bulk; only tasks are registered and no files are created in the directories.', '全选': 'Select all', '导入所选': 'Import selected', '已选 ': 'Selected ',
  '正在扫描各任务的目录大小和 Git 状态，目录多时可能要几十秒…': 'Scanning each task directory\'s size and Git status; this can take tens of seconds with many directories…', '个仓库': 'repos', '天没动': 'days untouched', '已于 ': 'Cleaned on ', ' 清理，释放 ': ', freed ', '从仓库恢复': 'Restore from repo',
  '任务目录一般不是 Git 仓库，这里列出每个任务目录里（最多 3 层内）的所有仓库，勾选后批量删除本地的仓库目录，任务目录里的其他文件、任务和待办都保留。只有该仓库没有未提交修改、没有未推送提交、没有 stash 时才能勾选，删除后可凭仓库地址恢复。按占用从大到小排列；超过': 'Task directories are usually not Git repos. This lists all repos inside each task directory (up to 3 levels deep); tick them to delete the local repo directories in bulk. Other files, tasks and to-dos in the task directory are kept. A repo can only be ticked if it has no uncommitted changes, no unpushed commits and no stash, and it can be restored from its remote address. Sorted by size, largest first; repos untouched for more than',
  '天没动的建议优先清理。': 'days are suggested for cleanup first.', '任务目录里没有找到 Git 仓库。': 'No Git repos were found in the task directories.', '已选': 'Selected', '预计释放': 'about to free', '确认删除': 'Delete', '个仓库的本地目录，释放约': 'repo directories locally, freeing about', '内容在远程仓库里，之后可以恢复。': 'The content is in the remote repositories and can be restored later.',
  '清理中…': 'Cleaning…', '已清理': 'Cleaned', '释放': 'freed', '清理所选': 'Clean selected', '恢复中…': 'Restoring…', '工作目录下没有未被任务管理的目录。': 'There are no directories in the working directory that are not managed by tasks.',
});
I18n.addPattern(/^PM2 里没有「(.+)」$/, (m) => `PM2 has no process "${m[1]}"`);
I18n.addPattern(/^确定停止 (.+)？$/, (m) => `Stop ${m[1]}?`);
I18n.addPattern(/^确定删除应用「(.+?)」？([\s\S]*)$/, (m, tr) => `Delete app "${m[1]}"? ${tr(m[2].trim())}`.trim());
I18n.addPattern(/^(\S+) 的日志$/, (m) => `${m[1]} logs`);
I18n.addPattern(/^(.+?)的覆盖$/, (m, tr) => `${tr(m[1])} override`);
I18n.addPattern(/^(.+?) 的覆盖$/, (m) => `${m[1]} override`);
I18n.addPattern(/^(.+?) 的当前配置$/, (m) => `${m[1]} current configuration`);
I18n.addPattern(/^已推送 (\d+) 台，(\d+) 台失败（见列表）$/, (m) => `Pushed to ${m[1]}, ${m[2]} failed (see the list)`);
I18n.addPattern(/^已推送到 (\d+) 台服务器$/, (m) => `Pushed to ${m[1]} servers`);
I18n.addPattern(/^已保存 (.+)$/, (m) => `Saved ${m[1]}`);
I18n.addPattern(/^已新增 (.+)$/, (m) => `Added ${m[1]}`);
I18n.addPattern(/^已删除 (.+)$/, (m) => `Deleted ${m[1]}`);
I18n.addPattern(/^已恢复 (\d+) 个$/, (m) => `Restored ${m[1]}`);
I18n.addPattern(/^恢复已隐藏的 (\d+) 个$/, (m) => `Restore ${m[1]} hidden`);
I18n.addPattern(/^已创建 (.+)$/, (m) => `Created ${m[1]}`);
I18n.addPattern(/^已重命名为 (.+)$/, (m) => `Renamed to ${m[1]}`);
I18n.addPattern(/^已重新加载 (.+)$/, (m) => `Reloaded ${m[1]}`);
I18n.addPattern(/^正在打开 (.+)…$/, (m) => `Opening ${m[1]}…`);
I18n.addPattern(/^正在保存 (.+)…$/, (m) => `Saving ${m[1]}…`);
I18n.addPattern(/^正在加载 (.+)…$/, (m) => `Loading ${m[1]}…`);
I18n.addPattern(/^(.+?) 暂无任务$/, (m) => `${m[1]} has no tasks`);
I18n.addPattern(/^(.+?) · 只读连接$/, (m) => `${m[1]} · read-only connection`);
I18n.addPattern(/^更新于 (.+)$/, (m) => `Updated at ${m[1]}`);
I18n.addPattern(/^正在(启动|停止|重启) (.+)…$/, (m, tr) => `${tr('正在' + m[1])} ${m[2]}…`);
I18n.addPattern(/^已(启动|停止|重启) (.+)$/, (m) => `${{ 启动: 'Started', 停止: 'Stopped', 重启: 'Restarted' }[m[1]]} ${m[2]}`);
I18n.addPattern(/^(启动|停止|重启)失败：(.+)$/, (m) => `${{ 启动: 'Start', 停止: 'Stop', 重启: 'Restart' }[m[1]]} failed: ${m[2]}`);
I18n.addPattern(/^自动：(.+)$/, (m) => `Auto: ${m[1]}`);
I18n.addPattern(/^自动随机（(\d+)-(\d+)），生成后保持稳定；也可直接填写固定端口。$/, (m) => `Auto random (${m[1]}-${m[2]}); stays stable once generated. You can also enter a fixed port.`);
I18n.addPattern(/^默认 (\d+)（本 Client 端口）$/, (m) => `Default ${m[1]} (this Client's port)`);
I18n.addPattern(/^版本 (.+)$/, (m) => `Version ${m[1]}`);
I18n.addPattern(/^公网地址 (.+?)（反向代理到 (.+)）$/, (m) => `Public address ${m[1]} (reverse proxy to ${m[2]})`);
I18n.addPattern(/^服务器上监听 (.+?)，转发到本机 (.+)$/, (m) => `Listening on the server at ${m[1]}, forwarding to this machine at ${m[2]}`);
I18n.addPattern(/^CPU (.+?) · (.+?) · (.+?) · 重启 (\d+)$/, (m, tr) => `CPU ${m[1]} · ${m[2]} · ${tr(m[3])} · ${m[4]} restarts`);
I18n.addPattern(/^已登记 (\d+) 台从服务器；超过约 15 秒没有心跳会显示离线。$/, (m) => `${m[1]} slave(s) registered; a slave shows as offline after about 15 seconds without a heartbeat.`);
I18n.addPattern(/^已存在 · 原文件备份：(.+)$/, (m) => `Exists · original backed up: ${m[1]}`);
I18n.addPattern(/^从同步清单移除 (.+)？本地文件不会删除。$/, (m) => `Remove ${m[1]} from the sync list? The local file is not deleted.`);
I18n.addPattern(/^将备份 (.+?) 的本地内容，然后使用主服务器版本。继续吗？$/, (m) => `This backs up the local content of ${m[1]}, then uses the master version. Continue?`);
I18n.addPattern(/^到 (.+?) 过期，只能使用一次。$/, (m) => `Expires at ${m[1]}, single use.`);
I18n.addPattern(/^上次检查：(.+)$/, (m) => `Last check: ${m[1]}`);
I18n.addPattern(/^同步错误：(.+)$/, (m) => `Sync error: ${m[1]}`);
I18n.addPattern(/^当前引擎：(.+)$/, (m, tr) => `Current engine: ${tr(m[1])}`);
I18n.addPattern(/^无法连接「(.+?)」$/, (m) => `Cannot connect to "${m[1]}"`);
I18n.addPattern(/^(认证失效|服务无响应)：(.+)$/, (m, tr) => `${tr(m[1])}: ${tr(m[2])}`);
I18n.addPattern(/^更新 (.+)$/, (m) => `Update ${m[1]}`);
I18n.addPattern(/^正在更新 (.+)$/, (m) => `Updating ${m[1]}`);
I18n.addPattern(/^(.+?) 已升级到 (.+?)，正在刷新页面…$/, (m) => `${m[1]} upgraded to ${m[2]}, refreshing the page…`);
I18n.addPattern(/^(.+?) · Engine 更新$/, (m) => `${m[1]} · Engine update`);
I18n.addPattern(/^(.+?) · 检查更新$/, (m) => `${m[1]} · Check for updates`);
I18n.addPattern(/^导入工作目录下 (\d+) 个未管理的目录$/, (m) => `Import ${m[1]} unmanaged directories from the workspace`);
I18n.addPattern(/^已选 (\d+) \/ (\d+)$/, (m) => `Selected ${m[1]} / ${m[2]}`);
I18n.addPattern(/^(\d+) 个仓库 · (.+)$/, (m) => `${m[1]} repos · ${m[2]}`);
I18n.addPattern(/^(\d+) 天没动$/, (m) => `${m[1]} days untouched`);
I18n.addPattern(/^已于 (.+?) 清理，释放 (.+)$/, (m) => `Cleaned on ${m[1]}, freed ${m[2]}`);
I18n.addPattern(/^已选 (\d+) 个，预计释放 (.+)$/, (m) => `Selected ${m[1]}, about ${m[2]} to be freed`);
I18n.addPattern(/^已清理 (\d+) 个，释放 (.+?)(（.*）)?$/, (m) => `Cleaned ${m[1]}, freed ${m[2]}`);
I18n.addPattern(/^确认删除 (\d+) 个仓库的本地目录，释放约 (.+?)？([\s\S]*?)内容在远程仓库里，之后可以恢复。$/, (m) => `Delete the local directories of ${m[1]} repos, freeing about ${m[2]}?${m[3]}The content is in the remote repositories and can be restored later.`);
I18n.addPattern(/^确认删除任务「(.+?)」？任务记录和待办会被删除。$/, (m) => `Delete task "${m[1]}"? The task record and its to-dos will be deleted.`);
I18n.addPattern(/^确认删除分组“(.+?)”？分组内必须没有任务。$/, (m) => `Delete group "${m[1]}"? The group must contain no tasks.`);
I18n.addPattern(/^确认删除「(.+?)」？$/, (m) => `Delete "${m[1]}"?`);
I18n.addPattern(/^(.+?) 的任务菜单$/, (m) => `${m[1]} task menu`);
I18n.addPattern(/^点击切换状态（当前：(.+)）$/, (m, tr) => `Click to change status (current: ${tr(m[1])})`);
I18n.addPattern(/^当前：(.+)$/, (m, tr) => `Current: ${tr(m[1])}`);
I18n.addPattern(/^移到「(.+?)」$/, (m) => `Move to "${m[1]}"`);
I18n.addPattern(/^关闭 (.+)$/, (m) => `Close ${m[1]}`);
I18n.addPattern(/^(.+?) 不存在$/, (m) => `${m[1]} does not exist`);
I18n.addPattern(/^打开链接？\s+(.+)$/, (m) => `Open link?\n\n${m[1]}`);
I18n.addPattern(/^请求失败（(.+)）$/, (m, tr) => `Request failed (${tr(m[1])})`);
I18n.addPattern(/^保存失败：(.+)$/, (m) => `Save failed: ${m[1]}`);
I18n.addPattern(/^读取失败：(.+)$/, (m) => `Read failed: ${m[1]}`);
I18n.addPattern(/^操作失败：(.+)$/, (m) => `Operation failed: ${m[1]}`);
I18n.addPattern(/^安装失败：(.+)$/, (m) => `Install failed: ${m[1]}`);
I18n.addPattern(/^删除失败：(.+)$/, (m) => `Delete failed: ${m[1]}`);
I18n.addPattern(/^终端操作失败：(.+)$/, (m) => `Terminal action failed: ${m[1]}`);
I18n.addPattern(/^失败：(.+)$/, (m) => `failed: ${m[1]}`);
I18n.addPattern(/^(.+?) · 成功$/, (m) => `${m[1]} · succeeded`);
I18n.addPattern(/^(.+?) · 失败：(.+)$/, (m) => `${m[1]} · failed: ${m[2]}`);
I18n.addPattern(/^删除“(.+?)”会终止其中的程序，并永久移除该终端标签和历史记录，确认删除吗？$/, (m) => `Deleting "${m[1]}" ends the programs in it and permanently removes the terminal tab and its history. Continue?`);
I18n.addPattern(/^复制选中内容：(.+)$/, (m, tr) => `Copy selection: ${tr(m[1])}`);
I18n.addPattern(/^没有客户端选区；(.+?)，或查看程序复制请求$/, (m, tr) => `No selection in the client; ${tr(m[1])}, or review the program copy request`);
I18n.addPattern(/^正在传送图片到 Client：(.+)$/, (m) => `Sending image to the client: ${m[1]}`);
I18n.addPattern(/^图片已上传；原终端已切换或断开，请手动复制链接：([\s\S]*)$/, (m) => `Image uploaded; the original terminal was switched or disconnected. Copy the link manually: ${m[1]}`);
I18n.addPattern(/^切换失败：(.+)$/, (m) => `Switch failed: ${m[1]}`);
I18n.addPattern(/^等 (\d+) 个文件$/, (m) => `and ${m[1]} files in total`);
I18n.addPattern(/^(.+?) 有未保存的修改。$/, (m) => `${m[1]} has unsaved changes.`);
I18n.addPattern(/^(.+?) 在其他位置发生了变化。重新加载会丢弃当前草稿；强制保存会覆盖远端内容。$/, (m) => `${m[1]} changed elsewhere. Reloading discards your draft; a forced save overwrites the remote content.`);
I18n.addPattern(/^将删除 (.+?)(，其中.*?)?。此操作无法撤销。$/, (m) => `This will delete ${m[1]}${m[2] ? ', including unsaved changes' : ''}. This cannot be undone.`);
I18n.addPattern(/^请先关闭已打开的目标文件 (.+)$/, (m) => `Close the open target file first: ${m[1]}`);
I18n.addPattern(/^任务已删除，但目录删除失败：(.+)$/, (m) => `Task deleted, but deleting the directory failed: ${m[1]}`);
I18n.addPattern(/^(.+?)（离线）$/, (m) => `${m[1]} (offline)`);
I18n.addPattern(/^留空使用工作目录下的 (.+)$/, (m) => `Leave empty to use ${m[1]} in the working directory`);
I18n.addPattern(/^在新标签页打开 (.+)$/, (m) => `Open ${m[1]} in a new tab`);
I18n.addPattern(/^编辑应用：(.+)$/, (m) => `Edit app: ${m[1]}`);
I18n.addPattern(/^(.+?)的日志$/, (m) => `${m[1]} logs`);
