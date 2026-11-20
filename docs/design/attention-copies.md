# T-Attention read copies

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

Item 11 ("attention-replicated") of the single-system-image program. An item stays owned by the engine whose database has it, and only that engine changes it. Every engine joined to it by service links keeps a read copy, so the list, the badge, the reminders and the desktop window show the same items whether or not the owner answers right now. Code: `services/attention-copy.js` (store, sync, queue, owners, the copy bus), `services/attention-copy-merge.js` (the rules, pure), `routes/attention-copy.js` (`/v1/attention-copy`), the copies of `routes/attention.js` (`copies=1`, `/api/attention/copies/*`), the fallback of the proxy in `routes/remote-servers.js` and `copyEngine` in `routes/attention-widget.js`. Page: `scripts/h5-shell/attention-feed.mjs`, `Attention.jsx`. Tests: `test/attention-copy.test.js` (the rules with a fake clock; two and three engines in this process over real HTTP), `scripts/test-h5-attention-copy-browser.cjs`.

## Data

No schema generation (the program kept 19 free for it, but none is needed): two tables made at every start by `db/schema.sql` and `ensureSchema`. An older version leaves them alone; a change it makes to the items is found by the check at start.

- `attention_copies` (`owner`, `item_id`, `rev`, `deleted`, `item`, `event`, `at`, `sync_seq`; key owner + item id). One row per item and owner. Owner `''` is this engine's own items: the journal its peers copy, written from the attention service's change bus (`journal`) and checked against `attention_items` at start (`reconcile`: a changed item is journaled, a missing one gets a tombstone). `item` is the whole item as the owner lists it (the context and the session included, never the excerpt), `NULL` for a tombstone. `event` keeps the kind of the last change (`type`, `actor`, `at`, `from_status`, `to_status`, `reorder`, `plain_turn_end`), never its data. `rev` is the owner's version: a hybrid clock in ms (`max(now, last + 1)`), so a restored database or a clock that went back still moves forward. An activity note alone writes no row (the item is the same).
- `attention_copy_queue`: changes made here to the item of an offline owner (`fields`, `activity`, `base`, `state` pending | dropped, `reason`).
- `system_state`: `attention_copy_peers_v1` (change numbers and capability per peer), `attention_copy_owners_v1` (name, host and last-heard time of each owner), `attention_copy_clock_v1` (the clock and the newest change number). All runtime ([server-state-keys.md](server-state-keys.md)).

## Merge

The owner is the only writer, so there is no field merge: an incoming row replaces the stored one when its `rev` is higher (`wins`), a tombstone included, so an old copy never brings a deleted item back. An engine never takes a row of its own items from a peer. A peer's row is checked (`rowFromPeer`: instance id, positive id, time, a title, a known status, at most 64 KiB).

## Sync

The pattern of the usage data and Learn syncs ([usage-data.md](usage-data.md), [learn-english.md](learn-english.md)): capability `attention:copy` in `/v1/info` (an older peer is marked `supported: false` and skipped; the page and the window then read it live through the proxy, as before); `GET /v1/attention-copy` → `{ instance_id, public_key, max_seq, have }`; `POST /v1/attention-copy/pull { instance_id, public_key, after, limit }` → `{ instance_id, sealed }`; `PUT /v1/attention-copy { instance_id, public_key, sealed }` → `{ applied, have }`. Link tokens only (403 `LINKED_ONLY`); pages `{ rows, owners, after, next, more }` travel only in the settings sync's AES-256-GCM envelope (HKDF of the link's key, info `t-agent attention-copy v1`, additional data `t-agent attention-copy v1|<push|pull>|<sender>|<link id>`). Pages of 100 rows (at most 500). Every row written here, own or copied, takes the next change number; a receiver applies only newer rows, renumbers them and pushes them on, so a chain A–B–C reaches C and an echo stops after one page. When: 1.5 s after the first change of a burst (one round for the burst), when a link comes online, after a write through the proxy reached the owner (`nudge`), and every 5 minutes. Off with `SETTINGS_SYNC_ENABLED=false` or `ATTENTION_COPY_ENABLED=false`: every engine is read live, as before.

- Owners: each page carries `owners` (`{ <instance id>: { name, host, seen_at } }`, the sender's own entry marked `self`); the newest `seen_at` wins. A successful round or push marks the peer as heard now. The page shows an owner offline with "as of" its `seen_at`.
- Company computers take part like normal machines: the items describe sessions, not the person's own progress (like the shared page state).
- Old rows: tombstones after 30 days; the copies of an owner nobody has heard of for 30 days (an unlinked device known only through a chain); dropped queue notes after 7 days.

## Actions on a copy

- Owner online (a linked peer whose link is online): the action goes to the owner as before (`/api/remote-servers/:id/attention/...`, the window's remote engine). A request that does not reach it (502, offline, timeout) falls back to the copy.
- Owner offline (`offline()` in `services/attention-copy.js`, the same for the proxy and the window): a read of the list or of an item answers the copy (`{ item, events: [], copy: { owner, as_of } }`: the history stays on the owner). A `PATCH` of safe fields (title, notes, status, priority, due date, reason, link and label, custom status, result) with an optional note is queued and answered 202 with the item as it will be (`pending: [{ id, at, fields }]`). Refused with 409 `ATTENTION_OWNER_OFFLINE` and an English sentence (Chinese in `i18n-zh-server.js`): delete, move, the AI summary (it starts work on the owner), a new task on that engine, and a `PATCH` that names the tree, the order, the identity, the context or a note that is not `note`.
- When the owner is back (its round, before the pull) the queue is applied in order. Each entry kept the values its fields started from (`base`, from the item as shown, earlier entries applied). Against the owner's current item (`resolveQueued`): a field already at the queued value is skipped; a field the owner changed since (current differs from base) means the owner's newer change wins and the entry is dropped whole, its note too (`reason: 'newer'`); a gone item drops it (`gone`); an owner's 4xx drops it (`refused`). A request that does not reach the owner stops the run (the rest waits). The page is told (`dropped_now` on the copy change): a notice "Not sent to K01: <title> — it was changed there in the meantime", the row line "Not sent: it was changed on K01 first" and Dismiss (`DELETE /api/attention/copies/queue/:id`).
- A device known only through another one (a chain, no link here): `/api/attention/copies/:owner/:id` reads its copy; every change is 409 `ATTENTION_OWNER_NOT_LINKED`.
- Task move (item 13) re-points an item to the moved task by changing `context.tagent` on the owner (a normal `PATCH` of `context.tagent`, or by the owner itself when the task moved to it); the copies follow like any change. A move to another engine should create the item on the target and delete it on the source: the tombstone and the new row travel.

## Notifications: never twice

Rule: a notifier (Telegram, email, the desktop bubble) and the AI summary fire only on the item's owner. Copies never reach them: their changes go out on the copy module's own bus, which only the page stream (`copies=1`) and the desktop window read, never on the attention service's bus that the notifiers, the summary and `/v1/attention/stream` follow. A copy only exists after the owner made the change, so the owner already decided about a notification (with its foreground rule, quiet hours and the Telegram relay). In-page reminders stay as before (any page reminds for any engine it lists), except that a copy change made more than a minute before it arrives (`quiet`: a device back online, the first sync) gives no reminder.

## Page

This machine's list (`GET /api/attention?include_done=1&limit=200&copies=1`) answers `copies: { items, owners }` and its stream (`?tab=1&copies=1`) carries the copy changes and `kind: 'owners'` when an owner goes offline or back (the page reads the list again). The engines the copies cover get no list read and no stream of their own (one list read and one stream instead of one per engine); until the first list answered no other engine is read; an engine without copies is read live as before. Copies keep the item's engine identity: the task list's key `remote:<id>` for a linked owner (tags, "open its session" and actions work as before), `copy:<instance id>` for a device known only through another. A line at the top per such engine: "K01 is offline · Its tasks as of 11-05 14:05 · Changes are sent when it is back", or "Far is not linked to this device · Its tasks as of …". Rows of an offline engine are not dragged; a queued change shows "Will be sent to K01"; the edit view says "As of <time>" and "The history is kept on K01". The badge and reminders count copies the same way on every engine. Hiding a device in the task list hides its copies; showing it again reads this machine's list again.

## CLI and desktop window

- `t-attention list` reads `/api/attention` without `copies=1`: agents see what they saw before (this engine's items only).
- The desktop window reads a copied engine's part from the copies (no remote read, re-read on the copy bus), so an offline engine's items stay; `engines` gains `offline: true, as_of` for it (the Swift window does not show it yet). Its actions go through `copyEngine` (owner online: to the owner; offline: queued or refused, as on the page).

## Limits

- A device known only through a chain is read only, and "online" is not known for it.
- "As of" is the last time this engine (or a peer, for a chain) heard from the owner, not the owner's own last change.
- The history (events) of a copy is not copied; the edit view of an offline owner's item shows none.
- Queued changes wait on the engine where they were made; another engine does not see them as pending.
