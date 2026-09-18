# Client Docker implementation

Target: remote server, accessed through an HTTPS domain. Preserve authentication and local-only initial enrollment.

1. Reuse the current Docker runtime for Client and Engine targets; keep Engine the default target. Add Client Compose with loopback host publishing, persisted data/tasks/Codex, and health check. Extend image workflow to both targets.
2. Generate a stable private session secret in the Client data volume before server startup. Fail on damaged stored configuration. Add an interactive container command that uses the existing loopback enrollment HTTP API and prints QR/manual key, then recovery codes. Do not weaken HTTP enrollment or cookie policies.
3. Copy host Codex once into a separate persisted Client directory; stage the copy, preserve symlink targets as independent files and never overwrite an existing copy. Document HTTPS/WSS Nginx deployment, first binding, volumes, local-vs-host filesystem limitations, remote Engine connectivity, backups and image updates.
4. Add regression tests for secret persistence, enrollment command and deployment configuration. Build and smoke test actual Docker Client, including auth and recreation with persistent data. Run full regression and syntax/diff checks.
5. Publish an appropriate minor version after verification, check main SHA and image workflow outcome.
