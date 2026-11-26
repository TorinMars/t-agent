# Learn English: the Bailian voice

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## Bailian voice

Learn reads words and sentences aloud (a card that plays by itself, Hear it / Play, Play slowly, Dictation, the model of Say it). By default it uses
this device's voices (`speechSynthesis`, "Speech" in [learn-english-page.md](learn-english-page.md)). The person can choose Alibaba Cloud Model
Studio's text-to-speech (Bailian) instead, with Alibaba's own American English voices (the user chose the voice Cindy). The
audio is made on the server with a Bailian API key saved for the Learn voice.

**Removed: the DeepSeek voice** (v2.169.0). DeepSeek's voice was unusable for this, so it was taken out completely in the next version: its provider
(`POST https://api.deepseek.com/v1/tools/tts` with the translation service's DeepSeek key), the "DeepSeek" radio, the Stella / Tide select, its
caption, notices and messages. The translation service itself is untouched. Migration: a stored `voice_engine: 'deepseek'` reads as `'system'` (the
check refuses it, and a refused value reads as the default); `voice_id` (Stella / Tide) is no longer a setting. `retiredVoice` in `services/learn.js`
turns `voice_engine: 'deepseek'` into `'system'` and drops `voice_id` both in `PUT /settings` (a page of v2.169.0 is not refused) and in the
learning sync (`settingsFromPeer` in `services/learn-merge.js`: an older peer's choice arrives as this device's voices, never an error). The WAV
files that voice left in the cache are never read again (their names are not Bailian's) and leave with the eviction. The routes of that version
(`GET /speech?text=&voice=stella`, `/v1/learn-sync/speech`) are gone or refuse (400 "Unknown voice", 404), so a page or company computer of
v2.169.0 reads with this device's voices.

**What Bailian offers** (read 2026-11-25: help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api and its English twin, alibabacloud.com/help/en/
model-studio/qwen-audio-3-1-tts-flash, docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list, the regions page):
- Model `qwen-audio-3.1-tts-flash`. HTTP: `POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
  (Singapore: `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`), `Authorization: Bearer <DashScope API key>`, the key and the workspace of the same
  region. The docs show only the workspace host for this model (no `dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` URL; the regions page
  says the DashScope domain gets no new features after 2026-09-30), so the workspace id is needed. It is the first label of the "API Host" shown in
  the Bailian console (the API key pop-up, or Workspace Management), e.g. `llm-xxx`. A WebSocket route exists too; the HTTP one is used.
- Body: `{ model, input: { text, voice, format: 'mp3' | 'wav' | 'pcm' | 'opus', sample_rate, rate (0.5–2.0, the speech rate), volume, pitch,
  language_hints, instruction, ... } }`. English text needs no language setting. The answer (not streamed) is JSON: `output.audio.url` (a file kept 24
  hours, `expires_at`), `output.audio.data` empty, `usage`, `request_id`; with `X-DashScope-SSE: enable` the audio comes as base64 chunks instead.
- Voices (each belongs to its model; another model's voice is `InvalidParameter`): American female `Abby_v3.1`, `Annie_v3.1`, `Ava_v3.1`,
  `Beth_v3.1`, `Betty_v3.1`, `Cally_v3.1`, `Cindy_v3.1`, `Donna_v3.1`; American male `Andy_v3.1`, `Brian_v3.1`, `David_v3.1`; British `Emily_v3.1`,
  `Luna_v3.1` (female), `Eric_v3.1`, `Luca_v3.1` (male). These premium English voices work in Beijing and Singapore.
- Errors (the error-code page): 401 `InvalidApiKey`, 403 `AccessDenied`, 404 `ModelNotFound`, 429 `Throttling.*`, 400 `InvalidParameter` /
  `DataInspectionFailed` / `Arrearage`, 5xx `InternalError` / `ServiceUnavailable`; the HTTP page shows no error body, so only `code` is read.
- Limits: no maximum input length is published for this model (the context table shows "—"); 180 requests a minute in both regions. Billed by input
  and output tokens (Beijing about USD 0.212 / 1.696 per million, Singapore 0.23 / 1.87; not verified against a real bill).

**Settings** (shared in `learn_v1` like the audio settings; `VOICE_SETTINGS` in `services/learn.js`, part of `CHECKED_SETTINGS` and of
`KEPT_SETTINGS`, so an older peer that sends none never resets them): `voice_engine` 'system' (default) | 'bailian', `voice_id_bailian` one of the
voices above ('Cindy_v3.1' by default), `voice_region` 'beijing' (default) | 'singapore'. Synced to every linked engine with the learning settings and
changed on the home from a company computer. The coach may not change them (not in `COACH_CHANGES`: the voice costs money).

**The key** (`services/learn-voice-keys.js`): `system_state` `learn-voice:<owner>` = `{ bailian: { apiKey, workspace } }`, encrypted with the
session secret like the translator's keys. `saveBailian(owner, { api_key, workspace })`: the key trimmed, without spaces or control characters, at
most 512 characters (an empty key keeps the saved one); the workspace an id or a pasted API host / URL (its first label, lower-case, a host label);
messages "Enter the Bailian API key", "Enter the workspace ID of Bailian (llm-…), or paste its API host". `view(owner)` → `{ has_key, workspace }`,
never the key. The settings sync carries the row as group `learn-voice` (secret, like `translate`; `exportForSync` / `importFromSync`), so every
linked engine has the same key; a page never gets it. On a company computer the key is saved on the home.

**Server** (`services/learn-speech.js`, one provider behind `{ label, credentials(owner), noKey, call(credentials, request, { fetchImpl, signal,
timedOut }) }`, so another can be added the same way):
- `speak(owner, { text, engine, voice, region, speed })`: the text is whitespace-collapsed and trimmed, 1 to 500 characters (refused above, never
  split; a card's sentence or context is at most 300), without Chinese, Japanese or Korean; `engine` 'bailian' (the default; anything else, the old
  'deepseek' too, is 400 "Unknown voice"), a voice of the list, a region, `speed` 'normal' | 'slow'. The request: the workspace host of the region,
  `{ model: 'qwen-audio-3.1-tts-flash', input: { text, voice, format: 'wav', sample_rate: 24000, rate: 1 | 0.7 } }`; then the file of
  `output.audio.url` is downloaded at once (https only, without the key; base64 `output.audio.data`, if ever given, is taken as it is) and must be a
  WAV of at most 8 MB. One 20 s timeout covers both requests. 429 and 5xx (of either) are tried once more after 500 ms ("Bailian is busy, try again
  in a moment", 503); 401 / 403 / 404 and a 400 `InvalidApiKey` are 409 "Bailian key missing or wrong" (a wrong workspace usually fails earlier: its
  host does not resolve, "Bailian cannot be reached right now", 502); 400 `Arrearage` 402 "Bailian refused: the account has an overdue payment";
  another 400 is 422 "Bailian could not read this text"; the timeout 504 "Bailian took too long to read this text"; anything else 502. No key: 409.
  The log gets the status only, never the text or the key.
- Cache: `<data dir>/learn-speech/<sha256('bailian' \n region \n voice \n speed \n text)>.wav` (folder 0700, files 0600, written through a temporary
  file and a rename), at most 50 MB; after each write the least recently played files are removed (a hit touches the file's time). It survives
  restarts and holds no key and no text in its names. The same request asked again while it is being made joins the first call.
- `status(owner)` → `{ bailian: { ready, reason: null | 'no_key', has_key, workspace, voices, regions } }`; `saveBailianKey` / `removeBailianKey`
  answer the same.

**Routes** (`routes/learn.js`, behind the page login): `GET /api/learn/speech/status`; `GET /api/learn/speech?text=&voice=&region=&speed=`
(`engine=bailian` may be given) → `audio/wav` with `Cache-Control: private, max-age=604800`; `PUT /api/learn/speech/bailian-key { api_key,
workspace }` and `DELETE /api/learn/speech/bailian-key` → the status. Errors are the usual JSON `{ error }` with the status above. GET (not POST) for
the audio so the answer is an ordinary cacheable resource; the 500-character limit keeps the URL short. `/v1/info` (`routes/engine-v1.js`) lists
`learn:speech` and `learn:speech:bailian`.

**Company computer**: like the other learn routes, all of these ask the home (`askHome('speech-status')`, `askHome('bailian-speech?text=&voice=
&region=&speed=')`, `askHome('bailian-key', { method: 'POST' })`, `'bailian-key-remove'`; the home has the key and the cache). The service links
carry JSON only, so the home's `GET /v1/learn-sync/bailian-speech` answers `{ type: 'audio/wav', audio: <base64> }` and the company computer decodes
it, checks it is a WAV and serves it as audio. The request is checked on the company computer first. The status answers `reason: 'offline'` while
the home is away and `'home_older'` for a home without the voice (its status has no `bailian`, or 404); an audio request then is 409 "needs an
update first".

**Page** (`scripts/h5-shell/learn-voice.mjs`, pure, `test/h5-learn-voice.test.js`; wired in `Learn.jsx`):
- `createServerVoice`: one `HTMLAudioElement` for the page; the audio of each text, voice, region and speed is fetched once per page load
  (`GET /api/learn/speech`, kept as an object URL, the oldest of 80 dropped) and preloaded when a card appears (`useCardAudio` → `audio.preload`, at
  the Speed setting), so a tap plays synchronously, which iOS requires. A play whose audio is still loading calls `onLoading` and, when it arrives,
  `onReady`; meanwhile the element plays a short silent WAV inside the tap, which unlocks it on iOS. A load is given up after 50 s.
- Slow and the Speed setting: Bailian has a real speech rate, so the slow audio is asked for (`speed=slow`, `rate` 0.7) and played at rate 1.
- Pronunciation and Try it request `navigator.audioSession.type = 'ambient'` during playback when the browser supports it. The page restores the previous type after playback, cancellation or teardown. A recording session keeps its type. Actual audio mixing depends on the phone and its speech engine.
- `createVoiceEngine` gives the player of `learn-audio.mjs` one `speakOnce` / `cancel` / `speaking` over both engines, as chosen at that moment.
  The player starts its "refused" watch (2.5 s) and its lost-end bound only after `onReady`, so a slow first load is not taken for a browser that
  refuses sound. Repeat, pause, Stop, stop on typing, "Playing 1 of 2" and "Tap to play" behave as with this device's voices.
- Fallback: any failure (network, an error status, no key, no route, audio the browser cannot decode) reads that play with this device's voice and
  shows one short notice per page load. 409 (no key) and 404 (no route) keep using this device's voice for the rest of the page load without new
  requests; the status question (when Bailian is chosen, again when Learn settings open, and the answer of a key save, handed to every listener of
  the page) clears that once ready. With Bailian usable, the page reads aloud even without `speechSynthesis`, so Dictation stays offered.
- Learn settings → Audio → Voice (`#h5-learn-voice`, first row of `#h5-learn-audio-card`, shown when the server's settings have `voice_engine`): a
  radio group (an option that applies at once, MD2 list rows of 44px) "This device's voices" / "Bailian (Alibaba)" (the second only when the server
  knows `voice_id_bailian`; on v2.169.0 only the first). For Bailian (`#h5-learn-voice-bailian`): the native select "Bailian voice"
  (`#h5-learn-voice-bailian-id`, optgroups American English: Cindy, Ava, Abby, Annie, Beth, Betty, Cally, Donna, Andy, Brian, David; British English:
  Emily, Luna, Eric, Luca), "Region" (`#h5-learn-voice-region`, Beijing / Singapore), the key (`#h5-learn-voice-key-part`: "Workspace ID" and the
  password field "Bailian API key" with a contained Save, 44px, its refusal said under it; once saved "Key saved", the workspace and Remove), Try it
  (`#h5-learn-voice-try`, "Hello from your English coach." with the chosen voice, region and speed; off without a key; its failure said under it), and
  the caption that the quality and delay are not checked here and that the key and the workspace must belong to the chosen region.

**Tests**: `test/learn-speech.test.js` (the request exactly, the download without the key, base64, refused URLs and non-WAV answers, the cache keys
and a restart, the old DeepSeek files never read, coalescing, the eviction, the retry, the error mapping, the timeout, the checks, the key stored
encrypted / kept / refused / removed and never in a status, the routes, a company computer with an older or absent home, the Chinese texts),
`test/learn-sync.test.js` (a company computer and its home end to end: the key saved on the home, the audio, the shared choice, the home away or
older; a peer or page sending the removed DeepSeek voice), `test/learn.test.js` (the settings and the DeepSeek migration),
`test/settings-sync.test.js` (group `learn-voice`), `test/h5-learn-voice.test.js`, `scripts/test-h5-learn-voice-browser.cjs` (390x844 touch with a
stand-in audio element and a mocked WAV: the radios, the selects, the key saved and removed, Try it, an engine without the voice, a server of
v2.169.0; a card's repeat with one request per text, Hear it, Play slowly as Bailian's slow audio, Tap to play; the fallback with its notice;
`H5_SHOT_DIR` saves `voice-*.png`).

**Not verified**: no real Bailian call was made (fetch is mocked everywhere), so the real audio, the American accent of Cindy, the latency and the
real cost are unknown; whether `dashscope.aliyuncs.com` would also serve this model is not documented and not tried; autoplay and the silent unlock
on a real iPhone are untested.

## The log names the reason (v2.170.1)

A failed Bailian call logs `[learn-speech] Bailian: <status> (<reason>)`, for example `502 (network ENOTFOUND)` (the workspace host does not resolve), `502 (http 418)`, `502 (answer has no audio (keys: ...))`, `502 (audio is not wav)`, `422 (http 400 InvalidParameter)`. The reason is a short code: never the key, the text, the workspace id or a response body.

## The audio address is upgraded to https (v2.170.2)

The Beijing endpoint answers with `output.audio.url` as an `http://` address on Alibaba's storage (`dashscope-result-bj.oss-cn-beijing.aliyuncs.com`; seen with a real call, 200 and a WAV of 24 kHz). The service refused every non-https address, so every Bailian call ended as "not available right now" (502). An `http://` address of an `aliyuncs.com` host (no port) is now fetched over `https://` (the same signed address works there); any other host over http is still refused.
