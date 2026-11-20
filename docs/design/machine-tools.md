# Machine tools without a page

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

The pages of these tools were removed with the PC page in 2.88.0. Their routes, services, `/v1` twins and remote proxies stay (see "G. The page"), and a tool set to start with the Client still starts.

- **Tunnel (frp)**: `routes/frp.js` (`/api/frp`), `services/frp.js`, `services/frp-install.js`; configuration in `system_state.frp_config` (token encrypted), `~/.tagent/frpc.toml` (0600) and `~/.tagent/bin/frpc`; one TCP proxy to this Client on a random remote port; frpc 0.52 or newer.
- **SSH reverse tunnel**: `routes/ssh-tunnel.js` (`/api/ssh-tunnel`), `services/ssh-tunnel.js`; configuration in `system_state.ssh_tunnel_config` (only the private key path, never the key); `ssh -N -R …` started with an argument array, its own connection (`ControlMaster=no`), reconnect after 5 s at most 5 times.
- **Environment check**: `GET /api/environment/check` (`routes/environment.js`, `services/environment-check.js`, `lib/find-program.js`): read-only checks of the machine (programs, agents, network, storage, data source), each with its own time limit. `test/environment-i18n.test.js` checks that every text it can show has a Chinese translation. Its tools list (`GET /api/environment/tools`) feeds Settings → Devices → Environment ([environment-compare.md](environment-compare.md)).
- **PM2 and apps, agent config, file sync, bookmarks, workspace tools**: see "C. Server modules".
