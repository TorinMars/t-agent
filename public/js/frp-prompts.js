// 生成“让 Agent 安装 frpc / frps”的提示词。纯函数，页面和测试共用。
const FrpPrompts = (() => {
  const RELEASES = 'https://github.com/fatedier/frp/releases/download';

  // 提示词是复制给 Agent 的纯文本，不经过 DOM，所以按界面语言直接生成。Node 测试里没有 I18n，保持中文。
  const english = () => typeof I18n !== 'undefined' && I18n.get() === 'en';

  function packageName(version, target) {
    return target ? `frp_${version}_${target.os}_${target.arch}` : `frp_${version}_<系统>_<架构>`;
  }

  // 本机安装 frpc：只放到 Client 会自动检测的 data/bin，不启动、不改别的。
  function frpc({ binDir, version, target }) {
    const name = packageName(version, target);
    if (english()) {
      return [
        'Please install frpc (the frp client) on this machine for t-agent\'s tunnel feature. Requirements:',
        '',
        `1. Download ${RELEASES}/v${version}/${name}.tar.gz and frp_sha256_checksums.txt from the same directory; if GitHub is unreachable, use a trusted mirror (same layout).${target ? '' : ' This system or architecture is not supported for automatic install; confirm the system and architecture first, then pick the matching release package.'}`,
        '2. Verify the archive\'s SHA-256 against frp_sha256_checksums.txt; if it does not match, stop and tell me, do not continue.',
        `3. Put only the frpc binary from the archive at ${binDir}/frpc (create the directory if missing) with mode 755. t-agent detects this location automatically.`,
        `4. Run ${binDir}/frpc --version and confirm it prints ${version}.`,
        '5. Do not start frpc, do not use sudo and do not modify other files; delete temporary files when done.',
        '',
        'When done, tell me the frpc path and version.',
      ].join('\n');
    }
    return [
      '请在这台机器上安装 frpc（frp 客户端），供 t-agent 的“内网穿透”使用。要求：',
      '',
      `1. 下载 ${RELEASES}/v${version}/${name}.tar.gz 和同目录的 frp_sha256_checksums.txt；访问不了 GitHub 时改用可信镜像（目录结构相同）。${target ? '' : '本机系统或架构不在自动安装支持范围内，请先确认系统和架构，再选对应的发布包。'}`,
      '2. 用 frp_sha256_checksums.txt 校验压缩包的 SHA-256，不一致就停止并告诉我，不要继续。',
      `3. 只把压缩包里的 frpc 放到 ${binDir}/frpc（目录不存在就创建），权限 755。t-agent 会自动检测这个位置。`,
      `4. 运行 ${binDir}/frpc --version，确认输出 ${version}。`,
      '5. 不要启动 frpc，不要使用 sudo，不要修改其他文件；临时文件用完删除。',
      '',
      '完成后告诉我 frpc 的路径和版本号。',
    ].join('\n');
  }

  const tomlString = value => JSON.stringify(String(value));

  // 公网服务器安装 frps：端口、Token、放行范围都取自页面当前配置。
  function frps({ version, serverPort, token, portMin, portMax, remotePort }) {
    const name = `frp_${version}_linux_<amd64|arm64>`;
    const manual = remotePort && (remotePort < portMin || remotePort > portMax);
    const allow = [`{ start = ${portMin}, end = ${portMax} }`];
    if (manual) allow.push(`{ single = ${remotePort} }`);
    const ports = manual ? `${portMin}-${portMax} 以及 ${remotePort}` : `${portMin}-${portMax}`;
    if (english()) {
      return [
        'Please install and run frps (the frp server) on my public Linux server so t-agent\'s tunnel can connect. Requirements:',
        '',
        `1. First confirm the OS and CPU architecture, then download ${RELEASES}/v${version}/${name}.tar.gz and frp_sha256_checksums.txt; if the server cannot reach GitHub, use a trusted mirror. Verify the SHA-256; if it does not match, stop and tell me.`,
        '2. Install only frps to /usr/local/bin/frps (mode 755) and keep no other files.',
        '3. Create /etc/frp/frps.toml (mode 600) with:',
        '',
        `bindPort = ${serverPort}`,
        'auth.method = "token"',
        token ? `auth.token = ${tomlString(token)}` : 'auth.token = "<random 32-character token; tell me what it is at the end>"',
        `allowPorts = [${allow.join(', ')}]`,
        '',
        '4. Create the systemd service /etc/systemd/system/frps.service: ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml, Restart=on-failure, WantedBy=multi-user.target; then daemon-reload, enable and start it.',
        `5. Open the firewall: TCP ${serverPort} (for frpc connections) and TCP ${manual ? `${portMin}-${portMax} and ${remotePort}` : `${portMin}-${portMax}`} (the mapped remote ports). Use whichever of ufw / firewalld / iptables the server actually uses; you cannot change a cloud security group, so clearly remind me to open the same ports in the cloud console.`,
        `6. Verify: systemctl status frps shows it running, and ss -lntp shows frps listening on ${serverPort}. Do not enable the dashboard.`,
        '',
        'When done, tell me: the server\'s public IP, bindPort, the token (if you generated it), allowPorts, and anything I still need to do by hand.',
      ].join('\n');
    }
    return [
      '请在我的公网服务器（Linux）上安装并运行 frps（frp 服务端），供 t-agent 的内网穿透连接。要求：',
      '',
      `1. 先确认系统和 CPU 架构，下载 ${RELEASES}/v${version}/${name}.tar.gz 和 frp_sha256_checksums.txt；服务器访问不了 GitHub 时改用可信镜像。校验 SHA-256，不一致就停止并告诉我。`,
      '2. 只把 frps 安装到 /usr/local/bin/frps（权限 755），不要保留其他文件。',
      '3. 创建 /etc/frp/frps.toml（权限 600），内容：',
      '',
      `bindPort = ${serverPort}`,
      'auth.method = "token"',
      token ? `auth.token = ${tomlString(token)}` : 'auth.token = "<随机生成的 32 位 Token，生成后在最后告诉我>"',
      `allowPorts = [${allow.join(', ')}]`,
      '',
      '4. 创建 systemd 服务 /etc/systemd/system/frps.service：ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml，Restart=on-failure，WantedBy=multi-user.target；然后 daemon-reload，enable 并启动。',
      `5. 放行防火墙：TCP ${serverPort}（frpc 连接用）和 TCP ${ports}（映射出来的远程端口）。按服务器实际使用的 ufw / firewalld / iptables 处理；云服务器的安全组你改不了，请明确提醒我去控制台放行同样的端口。`,
      `6. 验证：systemctl status frps 正常运行，ss -lntp 能看到 frps 监听 ${serverPort}。不要开启 dashboard。`,
      '',
      '完成后告诉我：服务器公网 IP、bindPort、Token（如果是你生成的）、allowPorts，以及还需要我手动做的事。',
    ].join('\n');
  }

  return { frpc, frps };
})();
if (typeof module !== 'undefined') module.exports = FrpPrompts;
