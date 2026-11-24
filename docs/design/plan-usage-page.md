# Plan usage: the page

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

The Claude and Codex plan windows (5 hours and 7 days) as eight thin bars in the session header, with the details on a click (the confirmed design "Plan usage bars", Place A). The server half (`GET {base}/agent-usage`, `POST {base}/agent-usage/refresh`, the capability `agent-usage:read`) answers `{ engine, agents: [{ agent, state, account, read_at, windows }] }`; `state` is `ok`, `not_read`, `signed_out`, `no_plan` (a reading without plan windows: left out of the bars, "Claude on T01 reports no plan limits (an API key, or not signed in)" in the details) or `error`, `account` a 12-hex hash of the account id (never shown), and a window `{ id: '5h' | '7d', label, usedPercent, resetsAt }`.

## The button

- `#h5-usage` in the session header (`Header.jsx`, also the notebook header), at the right right before More (`#h5-header-more`), on the computer and the phone, for every kind of session and with none shown. Drawn by `PlanUsageButton` in `scripts/h5-shell/PlanUsage.jsx`, which subscribes to its own slice of the store (`planUsage`, `sources`, the shown engine, `input`), so the header is not drawn again by a reading.
- Per agent, Claude then Codex: its mark (the session tiles' marks: Claude's sparkle in `#d97757`, Codex's logo) and four bars: 5h plan, 5h time, 7d plan, 7d time. Each bar 20px high and 4px wide, 2px apart, 6px between the two windows, 8px between the agents. The plan bar is what is left of the plan (primary); the time bar is the time left before the window resets (on-surface 45%); the track is on-surface 14%. A plan bar lower than its time bar means the plan runs out before the reset.
- 10% or less left (`LOW_LEFT`): the plan bar in the warning colour (`warning.light`, the design's amber) and, on a computer, the number beside the bars ("7d 8%"), so it is not colour alone. The phone shows the bars only (the numbers are in the details).
- Name (`aria-label` and `title`): "Plan usage: Claude 5 hours 62% left, 7 days 81% left; Codex 5 hours 24% left, 7 days 8% left" (each piece translated).
- Size: 36px high on a computer with a 6% white fill, 44px on a phone and in touch input mode (at least 44 x 44px), an 8px radius.
- States: not read yet = the four bars outlined without fill; not signed in or could not be read = that agent left out of the bars (the details say why; when every agent is left out, their marks alone, dimmed, so the details stay reachable); a window whose reset time has passed = plan full (100% left, time bar full) until the next reading; a window with no reset time has not started counting (its clock starts with the next message) = time bar full, and the details say "Not started: the time starts with the next message" (`limitBars` in `scripts/agent-chat/format.mjs`, so the chat view's bars do the same); an offline engine (its GET failed, or its service is offline) = its last reading, dimmed (38% opacity). The button is hidden while no engine answered with any agent (no reading yet, or an engine without the route: 404 / 501).

## Which engine

- The engine of the shown session's task (`state.sourceKey` while `state.taskName` is set), this machine when none is shown (`shownKeyOf`). The page asks only this machine and listed services whose `/info` lists `agent-usage:read` (`usageEngines`; the capabilities come from h5.js `readInfo`).
- An engine that has no plan usage (an older version without the capability, or its GET answered 404): the header shows this machine's reading, and the details say "K01 cannot report plan usage until it is updated." (one experience: what cannot be the same says so).
- No reading is kept in the browser: the server keeps the last reading; the page keeps what it read in this load only (`state.planUsage.readings`).

## When the page reads (`scripts/h5-shell/plan-usage-feed.mjs`)

- Started by `entry.jsx` on the top page only (a pane of the columns view has no session header of its own). Requests go through `api` (`common.jsx`): `/api/agent-usage` for this machine, `/api/remote-servers/:id/agent-usage` for a service.
- Every 5 minutes (`POLL_MS`) while the page is visible (`document.visibilityState`); every 60 s (`RUNNING_POLL_MS`) while a Claude or Codex session of the shown engine runs (the server reads every minute then). The schedule is looked at every 15 s; nothing is asked when nothing is due.
- About 10 s (`TURN_DELAY_MS`) after a Claude or Codex session of the shown engine stops running (a turn ended), at most one such extra read in 30 s (`TURN_GAP_MS`). Running sessions come from the page's pushed terminal activity (`state.terminalActivity`, `runningSessions` in `plan-usage.mjs`): a session the task list names as another kind (a notebook running a cell, OpenCode, a plain shell) does not count; one it does not list (a folded task) does, since only agents report running there. A run that starts while the last read is older than 60 s reads at once.
- At once when the page is shown again (`visibilitychange`) and the last read is older than 60 s (`VISIBLE_STALE_MS`), and when another engine's task is shown (unless that engine was read in the last 60 s).
- The details read the other engines when they open, and with each read while they stay open. Refresh in the details posts `{base}/agent-usage/refresh` for the shown engine (the server reads now) and shows its answer.
- A failed read keeps the last reading with `status: 'offline'`; 404 / 501 is `missing`.

## The details

- A click opens them: on a computer an MD2 menu-like popover anchored under the button's right edge (`Popover`, 400px, elevation 8, 8px radius, `#h5-usage-details`, `data-layout="popover"`); on a phone a bottom sheet (`Drawer` from the bottom, 8px top corners, a 32% black scrim, `data-layout="sheet"`). Both are MUI modals, so Escape closes them and `back.mjs` closes them with the back gesture. The time texts move on every 30 s while they are shown.
- Content: the title "Plan usage" (h6) with "<engine> · read N min ago" at the right ("<engine> is offline · read 3 h ago" in the warning colour while it is offline; the rows are dimmed then); per agent its mark and name, then a row per window: "5 hours" / "7 days", two 120 x 6px bars (plan left, time left), "62% left" (warning colour at 10% or less), "resets in 3 h 10 min · 18:30" within a day, else "resets Fri 09:00", "reset at 18:30, not read since" after a reset that was not read yet; an agent without rows says "Not read yet", "Codex is not signed in on T01" or "Could not read Codex on T01".
- The pace line, in the warning colour: "At this pace it runs out about 2 h before the reset" — a linear projection from the used percent over the elapsed part of the window at the reading (`read_at`): it runs out at `start + elapsed × 100 / used`; the line shows only when that is more than 10 minutes and more than 2% of the window before the reset (`paceText`). Nothing for 0% or 100% used.
- Then a divider and the lines of the other engines that report plan usage (`otherLines`): an offline one "K02 is offline · read 3 h ago"; per agent, the engines on the same account (equal hash) in one line, "K01 uses the same Claude account." ("K01, K02 use …"); the others grouped by their account hash with the numbers of the newest reading, "Codex on K01: another account, 5 hours 71% left, 7 days 66% left."; an account that is not known (no hash on either side) "Codex on K03, account unknown: …"; "Codex on K01: not read yet."; and the not signed in / could not read lines. Then the Refresh text button (`#h5-usage-refresh`, 44px in touch mode; "Refreshing…" while it runs, kept focusable so Escape still closes the popover).
- Times use the device's clock (24-hour, English weekday abbreviations, translated by the dictionary).

## Code and text

- `scripts/h5-shell/plan-usage.mjs`: the pure rules (bars, states, low, reset passed, pace, texts, the engine shown, the grouping by account hash, the running sessions); it reuses `visibleLimits`, `windowMs` and `limitBars` of `scripts/agent-chat/format.mjs`.
- `scripts/h5-shell/plan-usage-feed.mjs` (the reads, `state.planUsage`, `ui.actions.openPlanUsage` / `closePlanUsage` / `refreshPlanUsage`), `scripts/h5-shell/PlanUsage.jsx` (the button and the details).
- Every text is English; the Chinese is in `public/js/i18n-zh-extra.js` ("Plan usage in the session header"), as templates of the whole sentences ("{1} · read {2} min ago", "resets in {1} · {2}", "{1} on {2}: another account, {3}." …).
- No browser storage and no `system_state` key.

## Tests

- `test/plan-usage.test.js`: the bars, low, reset passed, not read yet, signed out and errors, the reset texts, the pace with and without running out, the button label, the engine shown and the fallback, the other engines grouped by account hash, the running sessions, and a Chinese translation for every text.
- `scripts/test-h5-plan-usage-browser.cjs` (stubbed routes, Playwright's fake clock): 1440x900, the button before More with 8 bars, its label and "7d 8%", the popover with the rows, reset times, pace lines and K01's lines, Refresh posting, Escape; the GET every 5 minutes, none while hidden, at once when shown again after 60 s, every 60 s while a session runs, about 10 s after it stops and at most once in 30 s; not read yet, not signed in, offline (dimmed). 390x844 touch: no number, a 44px target, the sheet at the bottom with a 44px Refresh, back closing it. An engine without the route: no button.
