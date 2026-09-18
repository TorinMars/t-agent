# Task file panel implementation plan

Approved design: toolbar button opens a downward panel covering tabs, default 85% of content below toolbar, resizable bottom edge 20–90%. Underlying terminal is laid out in remaining area and remains interactive; no draggable floating window. Auto-select terminal, preserve sessions. Tree left, Monaco with file tabs right. Local and remote task roots only.

Task 1: File service and local/Engine/proxy endpoints. CRUD, rename, directory pages 200, hidden option, UTF-8 5 MiB, preserve BOM/EOL/mode, optimistic revisions, no symlinks/traversal/root mutations. files:read/write capabilities and permissions, old Engines graceful upgrade message. Tests first.
Task 2: Self-contained tree/editor panel with manual save, dirty save/discard/cancel flow, conflict reload/explicit overwrite, stale response protection, root context switching, resizing persisted. No full-page overlay. Unit/browser tests first.
Task 3: Integrate task and Engine transitions, toolbar and terminal layout, language bundle. Add real-browser and API integration tests; update README/DESIGN.
Task 4: Review, full tests, syntax/diff checks; version 2.11.0 if remote still 2.10.16, commit and push origin/main, verify remote and report image status.

No uploads/downloads, move drag/drop, project search, Git UI or extensions. Root resolution follows task work_dir then dirname(md_path). Unsupported files listed with error rather than editable. No database schema bump.
