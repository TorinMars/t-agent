# Learn English: the DeepSeek voice

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## DeepSeek voice

Learn reads words and sentences aloud (a card that plays by itself, Hear it / Play, Play slowly, Dictation, the model of Say it). By default it uses
this device's voices (`speechSynthesis`, "Speech" in [learn-english-page.md](learn-english-page.md)). The person can choose DeepSeek's
text-to-speech instead. The audio is made on the server with the DeepSeek API key already saved for the translation service.

**What DeepSeek offers** (api-docs.deepseek.com/api/tts, read 2026-11-25): `POST https://api.deepseek.com/v1/tools/tts`, `Authorization: Bearer
<key>`, body `{ text, voice_id: 'stella' (female, default) | 'tide' (male), format: 'wav' | 'pcm', filter_markdown }`; the answer is streamed audio
(an answer that ends early is a failure). There is no language, speed, accent or SSML parameter: the language is detected from the text. Errors:
400 (no readable text, or the content review refused it), 429 (too many requests in progress), 503 (busy), 504 (timeout); the error body is not
documented, so only the status is used. Billing is per 10,000 characters (a Chinese character counts twice). The docs do not say whether the
voices speak American English, so the page says that the accent is DeepSeek's own and may not be American, and that this device's voices stay the
choice for a specific accent (the user's rule of American pronunciation, "Speech" in learn-english-page.md).

**Settings** (shared in `learn_v1` like the audio settings; `VOICE_SETTINGS` in `services/learn.js`, part of `CHECKED_SETTINGS` and of
`KEPT_SETTINGS`, so an older peer that sends neither never resets them): `voice_engine` 'system' (default) | 'deepseek', `voice_id` 'stella'
(default) | 'tide'. Synced to every linked engine with the learning settings and changed on the home from a company computer. The coach may not
change them (not in `COACH_CHANGES`: the DeepSeek voice costs money).

**Server** (`services/learn-speech.js`):
- `speak(owner, { text, voice })`: the text is whitespace-collapsed and trimmed, 1 to 500 characters (a card's sentence or context is at most 300),
  without Chinese, Japanese or Korean (Learn reads English); an unknown voice is 400. The key is `translator.providerConfig(owner, 'deepseek').apiKey`
  (server side only, read for each call, never cached, logged or answered); none: 409 "Set up the DeepSeek translation service first". The call has
  a 20 s timeout; 429 and 503 are tried once more after 500 ms ("DeepSeek is busy, try again in a moment", 503); 400 is 422 "DeepSeek could not read
  this text"; 401 / 403 is 502 (a refused key); 504 and the timeout 504; anything else, a broken stream or an answer that is not a WAV, 502. The log
  gets the status only, never the text or the key. Always the official host (a custom base URL of the translation service is not used for the key).
- Cache: `<data dir>/learn-speech/<sha256(voice + "\n" + text)>.wav` (folder 0700, files 0600, written through a temporary file and a rename), at
  most 50 MB; after each write the least recently played files are removed (a hit touches the file's time). It survives restarts and holds no key
  and no text in its names. The same text asked again while it is being made joins the first call.
- `status(owner)` → `{ ready, reason: null | 'no_key', voices }`.

**Routes** (`routes/learn.js`, behind the page login): `GET /api/learn/speech/status` and `GET /api/learn/speech?text=&voice=` → `audio/wav` with
`Cache-Control: private, max-age=604800`; errors are the usual JSON `{ error }` with the status above. GET (not POST) so the answer is an
ordinary cacheable resource; the 500-character limit keeps the URL short. `learn:speech` is listed in `/v1/info` (`routes/engine-v1.js`).

**Company computer**: like the other learn routes, both ask the home (`askHome('speech-status')`, `askHome('speech?text=&voice=')`; the home has the
key and the cache). The service links carry JSON only (`services/remote-client.js`), so the home's `GET /v1/learn-sync/speech` answers
`{ type: 'audio/wav', audio: <base64> }` and the company computer decodes it, checks it is a WAV and serves it as audio. The text is checked on the
company computer first. The status answers `reason: 'offline'` while the home is away and `'home_older'` for a home without the voice (a speech
request then is 409 "needs an update first").

**Page** (`scripts/h5-shell/learn-voice.mjs`, pure, `test/h5-learn-voice.test.js`; wired in `Learn.jsx`):
- `createServerVoice`: one `HTMLAudioElement` for the page; the audio of each text is fetched once per page load (`GET /api/learn/speech`, kept as an
  object URL, the oldest of 80 dropped) and preloaded when a card appears (`useCardAudio` → `audio.preload`), so a tap plays synchronously, which
  iOS requires. A play whose audio is still loading calls `onLoading` and, when it arrives, `onReady`; meanwhile the element plays a short silent
  WAV inside the tap, which unlocks it on iOS. A load is given up after 50 s.
- Slow and the Speed setting: DeepSeek has no speed control, so `playbackRate` (and `defaultPlaybackRate`) is 0.7 with `preservesPitch` on.
- `createVoiceEngine` gives the player of `learn-audio.mjs` one `speakOnce` / `cancel` / `speaking` over both engines, as chosen at that moment.
  The player is unchanged except that it starts its "refused" watch (2.5 s) and its lost-end bound only after `onReady`, so a slow first load is
  not taken for a browser that refuses sound. Repeat, pause, Stop, stop on typing, "Playing 1 of 2" and "Tap to play" (a `NotAllowedError` from
  `play()`) behave as with this device's voices.
- Fallback: any DeepSeek failure (network, an error status, no key, no route, audio the browser cannot decode) reads that play with this device's
  voice and shows one short notice per page load. 409 (no key) and 404 (no route) keep using this device's voice for the rest of the page load
  without new requests; the status question (`GET /speech/status`, when DeepSeek is chosen, again when Learn settings open) clears that once ready.
  An engine without the route (404) or a home that is older: "This engine has no DeepSeek voice yet". With DeepSeek usable, the page reads aloud
  even without `speechSynthesis` (`tts` is true), so Dictation stays offered; Say it's recognition is unchanged.
- Learn settings → Audio → Voice (`#h5-learn-voice`, first row of `#h5-learn-audio-card`, shown when the server's settings have `voice_engine`):
  a radio group (an option that applies at once, MD2 list rows of 44px) "This device's voices" / "DeepSeek". For DeepSeek: the native select
  "DeepSeek voice" Stella (female) / Tide (male) (`#h5-learn-voice-id`), Try it (`#h5-learn-voice-try`, plays "Hello from your English coach."
  with the chosen voice and speed, its failure said under it), and the caption about the accent and the speed. Without a key the
  "Set up the DeepSeek translation service first" notice with Open Settings (Settings → Voice and translation) and Try it is off.

**Tests**: `test/learn-speech.test.js` (the request exactly, the cache and a restart, coalescing, the retry, the error mapping, the timeout, the
length and language checks, no key, the eviction, the key never in errors, logs, status or cache; the routes; the company computer decoding),
`test/learn-sync.test.js` (a company computer and its home end to end over the link, the shared choice, the home away or older),
`test/h5-learn-voice.test.js`, `scripts/test-h5-learn-voice-browser.cjs` (390x844 touch with a stand-in audio element and a mocked WAV: the settings
radios, the select, Try it, no key, an engine without the voice, an older server; a card's repeat with one request per text, Hear it, Play slowly at
0.7 with the pitch kept, Tap to play; the fallback with its notice; `H5_SHOT_DIR` saves `voice-*.png`).

**Not verified**: no real DeepSeek call was made (fetch is mocked everywhere), so the real audio, its accent and its latency are unknown; autoplay
and the silent unlock on a real iPhone are untested.
