# Explicit intranet HTTP access

User needs existing Docker Client to support plain HTTP by IP/domain and port on a trusted intranet. Keep authenticator binding/data and authentication intact. No brainstorming per user.

1. Auth: CLIENT_ALLOW_HTTP=true (strict exact true) opts production Client into HTTP session cookies. Default unchanged, HTTPS still always Secure. One shared cookie policy for initial middleware and regenerated login session. HTTP opt-in does not bypass auth, origins, WebSocket tickets or local-only initial enrollment. Regression integration tests for production remote HTTP login, reuse, setup after verification, WS, default Secure and HTTPS Secure. Native Client supports same env.
2. Installer: Docker env T_AGENT_CLIENT_ALLOW_HTTP=false passed to CLIENT_ALLOW_HTTP. --allow-http yes|no supported, retained on rerun, --configure/first install prompt default no, explicit flag skips prompt; --non-interactive honors parameter. Keep pulling prebuilt images by default. Output meaningful HTTP IP:port guidance when enabled. Document upgrade+configure command.
3. Review/test/release: targeted tests then full suite, docs, patch release and push main per AGENTS.md. Do not claim image publication until CI success.
