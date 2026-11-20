// Collection hooks of English learning ("Collection hooks" in docs/design/learn-english.md): a sentence sent with translate-and-send (h5.js) and a word
// whose meaning tap to translate showed (word-translate.js) become study cards (POST /api/learn/cards). Fire and forget: nothing waits for it, nothing
// is shown when it fails. The switch "collect" is read once per page load, at the first use (GET /api/learn/settings); the Learn page calls
// LearnCollect.set(on) after it changes it. The server checks the switch and the text again.
const LearnCollect = (() => {
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  let collecting = null; // a promise of the switch, or null until the first use (and again after a failed read)
  const seen = new Set(); // what this page load already sent
  const on = () => collecting || (collecting = fetch('/api/learn/settings', { headers })
    .then(response => (response.ok ? response.json() : null))
    .then(settings => Boolean(settings && settings.collect !== false), () => { collecting = null; return false; }));
  function add(card) {
    const key = `${card.kind}|${card.en.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    on().then(yes => {
      if (yes) fetch('/api/learn/cards', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(card) }).catch(() => {});
    }).catch(() => {});
  }
  return {
    // The English that was sent and the Chinese the person typed. Only text that can be a sentence: three words or more, no braces, at most 300 characters.
    sentence(en, zh, context) {
      const text = String(en || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 300 || /[{}]/.test(text) || (text.match(/[A-Za-z][A-Za-z'-]*/g) || []).length < 3) return;
      add({ kind: 'sentence', en: text, zh: String(zh || '').trim().slice(0, 500), source: 'translation', context: String(context || '').slice(0, 120) });
    },
    // `phonetic`: the transcription shown with the meaning, kept when the server's dictionary has none for the word.
    word(en, zh, phonetic) {
      const text = String(en || '').trim().replace(/\u2019/g, "'");
      const ipa = typeof phonetic === 'string' ? phonetic.trim().slice(0, 60) : '';
      if (/^[A-Za-z][A-Za-z'-]{0,39}$/.test(text)) add({ kind: 'word', en: text, zh: String(zh || '').trim().slice(0, 500), source: 'lookup', ...(ipa ? { phonetic: ipa } : {}) });
    },
    set(value) { collecting = Promise.resolve(Boolean(value)); },
  };
})();
if (typeof window !== 'undefined') window.LearnCollect = LearnCollect;
