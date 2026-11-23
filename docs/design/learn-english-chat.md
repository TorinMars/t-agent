# Learn English: English chat

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## English chat

A standalone chat inside Learn where the person talks with the model about their own English questions: words, grammar, how to say something, their English journal entries and their journaling and learning habits. The chat model they set up for translation answers as a tutor (`converse` of `services/translator.js`, as in "Ask about a question" in [learn-english.md](learn-english.md)), streamed to the page. The chats are kept on the server and synced to every linked normal engine, so a chat is the same on every device. The page side (the Learn home entry, the chat view, the chats list, the chips) is in [learn-english-page.md](learn-english-page.md).

- **Server**: `services/learn-chat.js` (the prompt, the meta line, the topics, the checks, storing), `routes/learn.js` (`/api/learn/chats`), the merge rules in `services/learn-merge.js` (`cleanMeta`, `mergeConvo`, `convoFromPeer` / `convoToPeer`, `convoMessageFromPeer` / `convoMessageToPeer`), the limits in `services/learn-sync-store.js` (`MAX_CONVO_MESSAGES`, `MAX_CONVOS`, `pruneConvos`), the sync in `services/learn-sync.js`, the home routes in `routes/learn-sync.js`.
- **Tests**: `test/learn-chat.test.js` (the meta line cut at every place, its checks, a missing or broken one; the prompt, the level and the history that fits; 100 messages and the 409; the newest 50 chats and journal chats never pruned; the journal flag by the model and by the person; the topics and their summaries; the checks before the model, one answer per chat, the rate limit; PATCH and DELETE; the routes with a stubbed `converse`: the chat line, deltas, done, refusals as JSON, an error line, a page that goes away; the summary count; two databases: union, the title and journal clocks, tombstones, a chat brought back, the prune after a merge), the company computer in `test/learn-sync.test.js`, the 20 → 21 migration in `test/data-home.test.js`.

### Storage and limits

Schema 21 (`db/schema.sql`; `services/learn-sync-store.js` `ensureSyncSchema` adds the tables to an older database before `schema.sql` runs).

- `learn_convos`: `owner`, `uid` (a random UUID, primary key with the owner), `title` (`''` until named, at most 60 characters) with `title_at` (the hybrid clock of the learning sync), `journal` 0 / 1 with `journal_by` (`model` | `person` | `''`) and `journal_at`, `created_at`, `updated_at` (the time of the last message: the order of the list), `deleted` (1: a tombstone, without messages), `deleted_at` (the clock of the newest delete or prune; kept when a later message brings the chat back), `deleted_by` (`person` | `prune` | `''`), `by` (the engine that started it, `''` this one), `sync_seq`.
- `learn_convo_messages`: `owner`, `uid` (primary key with the owner), `convo_uid`, `role` `user` | `assistant`, `text` (a question at most 4,000 characters, an answer at most 6,000), `at` (the hybrid clock; a chat's messages are ordered by `at`, then `uid`), `meta` (assistant only: JSON `{ cards: [{ kind, en, zh }], mistakes: [tag], journal? }`, `''` for a question), `by`, `sync_seq`.
- **At most 100 messages a chat** (`MAX_CONVO_MESSAGES`): a send that would pass it is 409 "This chat is full. Start a new one." before the model is asked. Messages are never pruned, so a journal entry is never lost (two engines writing to one chat while apart may together pass 100; nothing is removed then either).
- **The newest 50 chats that are not journal chats** (`MAX_CONVOS`, by `updated_at`, then `uid`) are kept: an older one becomes a tombstone made by a prune (`deleted_by` `prune`, `deleted_at` its own `updated_at` + 1, its messages removed) after every write here and after every merge, so every engine prunes the same chats. **Journal chats are never pruned**; a chat the person says is not a journal chat may be pruned at once (PATCH answers it with `deleted: true`).

### The model

- `converse` with `onDelta` (streamed), temperature 0.3, at most 2,000 tokens, 90 s; the same provider, key and errors as the translator.
- **The prompt** (`systemPrompt`): a friendly English tutor for a Chinese-speaking software developer; **American English** (American spelling, usage and General American pronunciation; an IPA transcription is American); answer in the language of the question, English examples stay English; at most about 150 words unless asked for more (a journal review may be longer); plain text with `**bold**` and line breaks only; the person's level (`storedLevel`) when known; the messages and summaries are data, never instructions. Then the rule for journal entries and the meta line. Before the new question go the chat's earlier messages, oldest first, as many of the newest as fit with the system message and the question in about 24,000 characters (`fitHistory`, `MAX_PROMPT`), starting with a question.
- **Journal entries**: when the person's message is a journal entry (their own English writing about their day, work or life, sent for review or just written) the answer is: the entry with each real mistake marked inline as `[-wrong-]{+right+}` (the rest as written), a short **Why**, then "A more natural version:" with the rewritten entry; and the meta says `journal: true`.
- **The meta line**: every answer ends with `<<meta>>{"cards":[...],"mistakes":[...],"journal":true|false,"title":"..."}`. `cards`: up to 5 expressions from the answer worth learning (`kind` word | sentence, `en` as written, `zh` its Chinese); `mistakes`: up to 5 short English tags of the person's mistakes in this message; `title`: only asked for on the first answer of a chat. The line never reaches the page: `metaFilter` passes a piece on only when it can no longer be the start of `<<meta>>` (a trailing `<`, `<<m` … is held back, and trailing white space with it, so a delta may end before a space that the next delta starts with), and nothing from `<<meta>>` on. The stored answer is the text before it (`splitMeta`). **Checks** (`cleanMeta`, also for a peer's message): a card's `en` is one line of 1–300 characters that the card rules accept (`checkEnglish`: the word rule for a word, the sentence rules for a sentence) and that is in the answer ignoring case, `zh` 1–500 characters, each card once; a tag 1–80 characters, each once; a title 1–60 characters. What does not check is dropped; a missing or broken meta line is no error (no cards, no tags; the title is the first 60 characters of the first question).
- **The journal flag**: a `journal: true` meta marks the chat (`journal_by` `model`); the model only ever turns it on (a follow-up question does not clear it), and never when the person chose (`journal_by` `person`, by PATCH), which wins everywhere.
- **Topics** (extra context only when asked): `topic: 'journal'` from the page (the chip "How is my journaling going?"), or a typed question of at most 500 characters that matches `journal|diary|habit` or the Chinese words for diary or habit (and does not start with "Please review my journal entry"), adds a JSON summary of the journal chats: each entry (in a journal chat the questions whose answer's meta said journal, else its first question), newest first, at most 60: `date` (YYYY-MM-DD in the server's time zone), `weekday`, `part` (morning 5–12, afternoon 12–17, evening 17–22, late night), `words` (without the "Please review my journal entry:" line), `mistakes` (the tags of its review); totals: `entries`, `first_date`, `last_date`, `entries_per_week`, `entries_last_4_weeks`, `average_words`, `by_month` (entries and average words, the last 12 months), `common_mistakes` (tags seen at least twice), `mistakes_gone_in_last_4` (tags of older entries not seen in the newest 4). **This is a deliberate exception** to the "never a time" rule of the reports and the level: the person asked about their habit, which is about when and how much they write. No text of an entry goes in it. `topic: 'mistakes'` (the chip "Words I keep getting wrong", or a question matching `mistake|wrong|keep getting` or the Chinese for mistake or "spelled wrong") adds the recent wrong answers by card (the newest 200 wrong answers: the card's English, how often wrong, the tags; at most 40 cards; the shape of the level estimate's record) and the newest mistake report's summary; no times, no written answers. Nothing else of the person's data ever goes to the model.

### API

Under `/api/learn`, the same auth, error shape and translated server messages as the rest of Learn.

- `GET /chats` → `{ chats: [{ uid, title, journal, journal_by, created_at, updated_at, count }], translator }`, the newest `updated_at` first (ISO times; `count`: the messages).
- `GET /chats/:uid` → `{ chat, messages: [{ uid, role, text, at, cards: [{ kind, en, zh, added }], mistakes }] }`, oldest first; `added`: the owner has a card of that kind and normalized text now. 404 "Chat not found" (also for a deleted one).
- `POST /chats/send { chat: uid | null, question, topic? }`: `null` starts a new chat. Checks, in this order and before the model: the body (400 "Invalid question"), `question` 1–4,000 characters after trimming (400 "Enter your question", "The question cannot exceed 4000 characters"), `chat` (404 "Chat not found"), `topic` `journal` | `mistakes` (400 "Unknown chat topic"), a full chat (409 "This chat is full. Start a new one."), a model (503 "Translation service not configured yet"), one answer at a time in a chat (409 "Another question in this chat is being answered"), at most 30 sends a minute per owner (429 "Too many questions in a minute. Wait a moment and ask again."). Then `application/x-ndjson` (`Cache-Control: no-store`), starting with the first piece of the answer: the first line `{"chat":{uid, title, journal, journal_by, created_at, updated_at, count}}` (a new chat: its uid, `title` `''`, `count` 0; it is stored only with its answer), then `{"delta":"..."}` lines (without the meta line), then `{"done":true,"chat":{...with the title and count},"messages":[question, answer]}`; or `{"error":"...","status":N}` when the model fails after its first piece. A model that fails before it is a JSON error (502, 504). Nothing is stored on a failure; when the page closes the request the model's call is cancelled.
- `PATCH /chats/:uid { title?, journal? }` → `{ chat }`: `title` 1–60 characters after collapsing white space (400 "A chat title has 1 to 60 characters"), `journal` a boolean (`journal_by` `person`); anything else 400 "Invalid chat change". A chat pruned by its change answers `{ chat: { ..., deleted: true } }`.
- `DELETE /chats/:uid` → `{ ok: true }`: a tombstone by the person (`deleted_at` now), its messages removed.
- `GET /summary` has `chats`: the chats that are not deleted.
- A chip's card is added with the existing `POST /cards { kind, en, zh, context }` (source `manual`); a word's context is cut to that route's limit.

### Sync

- The chats and their messages travel in the learning sync's pages (`convos`, `convo_messages`), to normal engines only (a company computer's cards-only pull has none). A message goes with its chat (the page adds the chat it needs, like a card for an answer); one whose chat is not there, or is deleted, is not stored. The pull kind became `full-21`, so every link reads the other side once from the start after the update.
- **Merge** (`mergeConvo`, pure): messages a union by uid; the title the newer `title_at` (a tie to the greater title); the journal flag the person's over the model's, then the newer `journal_at`, then on; the tombstone the newer `deleted_at` (a tie: the person's); `created_at` the earliest, `updated_at` the newest. **A chat is deleted while its newest tombstone is newer than its newest message, except that a prune never removes a journal chat.** So a delete wins over everything older and removes the messages, and a message written elsewhere after a delete or a prune (that engine had not seen it) brings the chat back. When an engine gets a tombstone that does not hold there, it sends its messages of that chat again (new change numbers), so the engine that removed them gets them back. After a merge the newest 50 non-journal chats are kept, the same on both sides.
- **Company computer**: it keeps no chats (one it had from before it was marked is handed over and removed). Its page reads and writes them on its home: `GET /v1/learn-sync/chats`, `GET /v1/learn-sync/chat?uid=`, `POST /v1/learn-sync/chat-send { chat, question, topic }` (the home checks, asks its own model, stores, and answers with one plain JSON `{ chat, messages }`, not streamed), `POST /v1/learn-sync/chat-update { uid, title?, journal? }`, `POST /v1/learn-sync/chat-delete { uid }`. While the home is away `GET /chats` is `{ chats: [], translator: false, offline: true }` and the others 503 "Your English chats are kept on a normal computer, which cannot be reached right now"; a home without this version: `GET /chats` `{ chats: [], translator: false, home_older: true }`, the others 409 "The normal computer that keeps your learning data needs an update first". The summary's `chats` is the home's.

### Decisions and limits

- **Decisions** (where the contract left room, 2026-11-21): `deleted_by` was added to `learn_convos` so a prune never removes a journal chat that the person marked elsewhere at the same time; a prune's tombstone is at the chat's own last time + 1 (not now), so a later message wins over it; a tombstone that does not hold sends the messages again; the meta keeps `journal: true` on the reviewed answer (the journal summary counts entries by it); sentence cards in the meta are checked by the sentence rules too, so every chip can be added; the model only ever turns the journal flag on; a topic is guessed only for a question of at most 500 characters that is not a journal entry for review; no new capability in `/v1/info` (an older home answers 404); no new `system_state` key.
- **Known limits**: the 30-a-minute limit and the one-answer-per-chat rule are per engine; two engines that write to one chat while apart can together pass 100 messages; a home of an older version without the routes at all answers an HTML 404, which the company computer reads as "cannot be reached"; tombstones are kept for good (a few small rows).

## English chat on the page

The person's own conversations with the translation model about English, not tied to a card: words, grammar, how to say something, their
English journal entries and their journaling habit (the server side, the prompt, the meta line, the storage and the sync are "English chat" in
[learn-english.md](learn-english.md)). `LearnChat.jsx` (in the Learn chunk; the pure parts in `learn-chat.mjs`). The approved design is the board
"Learn · English chat: your own questions, journal and habits" (frames 1 to 7). Same content on a phone and a computer.

- **Home entry** (frame 1): after Mistakes the overline "Ask" and a mode card `#h5-learn-mode-chat` "English chat" (library icon `message`,
  `learnAsk`), "Ask anything about English: words, grammar, how to say something", and "N chats": `chats` of `GET /api/learn/summary` when the
  server sends it, else the length of `GET /api/learn/chats`, read again with each new summary (`useChatCount`). It opens the view
  `{ kind: 'chat' }` (a new chat).
- **Phone** (frames 2, 3, 5, 6): the view is a Learn mode page (`#h5-learn-mode`) with its own app bar: back arrow (`#h5-learn-back`, to the
  home), "English chat" with the open chat's title as the subtitle (`#h5-learn-chat-title`, "New chat" until the first answer names it) and the
  Journal tag before it, then the icon buttons Earlier chats (`#h5-learn-chat-history`, library `reload time`, Ant Design's history,
  `learnHistory`), New chat (`#h5-learn-chat-new`, `add`) and, once the chat exists, its menu (`#h5-learn-chat-more`, `taskMore`). Below, the
  conversation (`#h5-learn-chat`, `data-layout="phone"`) and the input pinned at the bottom (above the system keyboard, like every Learn page).
- **Earlier chats** (frame 4, phone only): the view `{ kind: 'chats', parent }`, its own screen: back arrow (to the chat it came from; the back
  button and Escape do the same: `PhoneLearn` closes it to `parent`, not to the home), "Earlier chats", New chat, the rows, and the caption
  "Kept on the server and on your other machines." (`#h5-learn-chats-note`).
- **Computer** (frame 7): the view fills Learn's right pane (`.h5-learn-pane` without padding): a 260px chats list (`#h5-learn-chats`: "Chats",
  a "New chat" text button with the plus icon, the rows, the same caption) and the conversation (`data-layout="wide"`: the title in h6 with the
  Journal tag, the menu, Close; the messages; the input). Picking a row or New chat changes the conversation in place (an answer on its way is
  cancelled). The input takes the focus when a chat opens (hardware keyboard or mouse). Escape closes the menu or a dialog first, then the view.
- **Rows** (`.h5-learn-chat-row`, `data-uid`, the open one `aria-current`): the Journal tag, the title (body2, medium), and
  "11-21 22:05 · 6 messages" (`chatLine`: the time of the last message in the browser's zone, "1 message" / "{1} messages"); newest first.
- **New chat** (frame 3, `#h5-learn-chat-start`): the message icon, "Ask anything about English" (h6), "Words, grammar, how to say something,
  your journal entries and your learning habits. Ask in Chinese or English.", "Try one:" and the chips (`CHAT_CHIPS`): "Review my journal entry"
  puts "Please review my journal entry:" and a line break into the input, "How do I say … in English?" puts `How do I say "" in English?` with the
  caret between the quotes, "Check my sentence" puts "Please check my sentence: " (each translated, `chipFill`; the input gets the focus; nothing
  is sent); "How is my journaling going?" and "Words I keep getting wrong" send their shown text at once with `topic` `journal` / `mistakes`. Above
  the input the privacy caption "Your questions and your level go to the translation model you set up. A short summary of your recent mistakes or
  your journal is added only when you ask about them." (`#h5-learn-chat-privacy`).
- **Messages** (`.h5-learn-chat-msg`, as Ask's bubbles): the person's on the right, the model's on the left, `lang` per text, line breaks,
  `**bold**`, and the corrections of a reviewed journal entry (frame 5): `[-wrong-]` as a `<del>` in the error colour (struck through) and
  `{+right+}` as an `<ins>` in the success colour, underlined (`answerParts`; never across a line break; an unclosed marker stays as written).
  A trailing `<<meta>>` line is never shown: the server strips it, and the page cuts a complete one and holds back a piece that could be its start
  while streaming (`visibleAnswer`).
- **Add to my cards** (frame 2): under a model message with `cards`, the caption "Add to my cards" once and an outlined primary chip per card,
  "+ <en>"; a tap posts `POST /api/learn/cards { kind, en, zh, context, source: 'manual' }` (`context`: for a word the sentence of the answer it
  stands in, as corrected, at most 120 characters, `cardContext`; '' for a sentence) and the chip turns "✓ <en>" (`data-added`). Cards the server
  marks `added` start as ✓; a card added once is ✓ in every message of the view (`cardKey`: kind and text). A failure shows an error Alert under
  that message's chips.
- **Input**: multiline (up to 6 lines, then it scrolls), "Ask anything about English" (with messages "Reply or write more"), at most 4000
  characters; Send (`#h5-learn-chat-send`, `aria-label` "Send", never takes the focus). On a computer (a mouse or a hardware keyboard seen) Enter
  sends and Shift+Enter is a new line; on a touch screen Enter is a new line and the button sends (`enterSends`; an IME composition never sends).
  The Learn keyboard is not used here. A typed question about the journal or mistakes (`chatTopic`: journal, diary, habit and the Chinese for
  diary and habit; mistake, wrong, keep getting and the Chinese for mistake) is sent with that `topic` too.
- **Sending** (`POST /api/learn/chats/send { chat: uid | null, question, topic? }`): the question and a growing model bubble (`data-streaming`);
  the first NDJSON line `{"chat"}` names a new chat (the page keeps its uid, adds it to the list and shows the menu), `delta`s grow the bubble,
  `done` replaces the temporary bubbles with the stored messages and updates the chat (its title from the first answer). A plain JSON answer
  `{ chat, messages }` (a company computer asking its home) is taken the same way. When a new chat's first answer fails, the chat is dropped
  again (nothing is stored).
- **Menu** (`#h5-learn-chat-menu`): "Mark as journal entry" / "Not a journal entry" (`PATCH { journal }`; the person's choice wins over the
  model's), "Rename" (a form dialog "Rename chat", the title filled in, at most 60 characters, Cancel / Save contained, `PATCH { title }`),
  "Delete" (a confirmation "Delete this chat?", "It is deleted on all your machines. Cards you added from it stay.", Cancel / Delete in the
  error colour, `DELETE`; then a new chat).
- **Errors** (as Ask): a JSON error before the first piece or an `{"error"}` line half way keeps the question with an error Alert and Try again
  (`#h5-learn-chat-retry`, the same question and topic). 409 "This chat is full. Start a new one." (or a chat that already holds 100 messages)
  shows an info Alert `#h5-learn-chat-full` with New chat, and the question waits in the input for the new chat. The 503 "Translation service not
  configured yet" (or `translator: false` from GET) shows the translator notice ("English chat needs a translator…"), the question back in the
  input, chips and Send off. `GET /chats` with `offline: true` / `home_older: true` (a company computer whose home cannot answer) shows Ask's
  lines ("Questions are answered by your normal computer, which cannot be reached right now." / "…needs an update…") with chips and Send off.
  The other routes of a company computer answer 503 "Your English chats are kept on a normal computer, which cannot be reached right now" or
  409 "…needs an update first" and show as an error Alert; a 409 "Another question in this chat is being answered" too (only the exact "This
  chat is full…" text gets New chat). A chat that is gone (404 "Chat not found" from GET, PATCH or DELETE) is left: a new chat in its place and
  the list read again. `PATCH { journal: false }` may answer the chat as `deleted` (one non-journal chat too many, pruned at once): the same, plus
  the notice "This chat was removed: only the newest 50 chats are kept.". A refused title (400 "A chat title has 1 to 60 characters") shows in
  the rename dialog. Deltas are joined exactly as they come (the server holds back trailing white space); only the display holds back a
  possible `<<meta>>` start.
