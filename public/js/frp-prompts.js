// 生成“让 Agent 安装 frpc / frps”的提示词。纯函数，页面和测试共用。
const FrpPrompts = (() => {
  const RELEASES = 'https://github.com/fatedier/frp/releases/download';

  function packageName(version, target) {
    return target ? `frp_${version}_${target.os}_${target.arch}` : `frp_${version}_<系统>_<架构>`;
  }

  // 本机安装 frpc：只放到 Client 会自动检测的 data/bin，不启动、不改别的。
  function frpc({ binDir, version, target }) {
    const name = packageName(version, target);
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
