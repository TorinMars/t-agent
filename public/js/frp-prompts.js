// Builds the prompts that ask an Agent to install frpc / frps. Pure functions shared by the page and the tests.
// The prompts are plain text copied to an Agent (not rendered in the page), so they are always English.
const FrpPrompts = (() => {
  const RELEASES = 'https://github.com/fatedier/frp/releases/download';

  function packageName(version, target) {
    return target ? `frp_${version}_${target.os}_${target.arch}` : `frp_${version}_<OS>_<arch>`;
  }

  // Install frpc locally: only into data/bin, which the Client detects automatically; do not start it or touch anything else.
  function frpc({ binDir, version, target }) {
    const name = packageName(version, target);
    return [
      "Please install frpc (the frp client) on this machine for t-agent's tunnel feature. Requirements:",
      '',
      `1. Download ${RELEASES}/v${version}/${name}.tar.gz and frp_sha256_checksums.txt from the same directory; if GitHub is unreachable, use a trusted mirror (same layout).${target ? '' : ' This system or architecture is not supported for automatic install; confirm the system and architecture first, then pick the matching release package.'}`,
      "2. Verify the archive's SHA-256 against frp_sha256_checksums.txt; if it does not match, stop and tell me, do not continue.",
      `3. Put only the frpc binary from the archive at ${binDir}/frpc (create the directory if missing) with mode 755. t-agent detects this location automatically.`,
      `4. Run ${binDir}/frpc --version and confirm it prints ${version}.`,
      '5. Do not start frpc, do not use sudo and do not modify other files; delete temporary files when done.',
      '',
      'When done, tell me the frpc path and version.',
    ].join('\n');
  }

  const tomlString = value => JSON.stringify(String(value));

  // Install frps on the public server: port, token and the allowed port range all come from the current page configuration.
  function frps({ version, serverPort, token, portMin, portMax, remotePort }) {
    const name = `frp_${version}_linux_<amd64|arm64>`;
    const manual = remotePort && (remotePort < portMin || remotePort > portMax);
    const allow = [`{ start = ${portMin}, end = ${portMax} }`];
    if (manual) allow.push(`{ single = ${remotePort} }`);
    const ports = manual ? `${portMin}-${portMax} and ${remotePort}` : `${portMin}-${portMax}`;
    return [
      "Please install and run frps (the frp server) on my public Linux server so t-agent's tunnel can connect. Requirements:",
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
      `5. Open the firewall: TCP ${serverPort} (for frpc connections) and TCP ${ports} (the mapped remote ports). Use whichever of ufw / firewalld / iptables the server actually uses; you cannot change a cloud security group, so clearly remind me to open the same ports in the cloud console.`,
      `6. Verify: systemctl status frps shows it running, and ss -lntp shows frps listening on ${serverPort}. Do not enable the dashboard.`,
      '',
      "When done, tell me: the server's public IP, bindPort, the token (if you generated it), allowPorts, and anything I still need to do by hand.",
    ].join('\n');
  }

  return { frpc, frps };
})();
if (typeof module !== 'undefined') module.exports = FrpPrompts;
