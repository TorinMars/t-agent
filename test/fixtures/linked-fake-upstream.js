// Preloaded with `node -r` by test/linked-capabilities.test.js. The translator accepts only an HTTPS endpoint, so a plain local server cannot stand in for the
// provider: requests to this one host get an OpenAI-compatible answer naming the service that made the call, and everything else goes to the real fetch.
const FAKE_ORIGIN = 'https://fake-llm.test/';
const realFetch = global.fetch;

global.fetch = async (url, options) => {
  if (!String(url).startsWith(FAKE_ORIGIN)) return realFetch(url, options);
  const content = `translated-by-${process.env.FAKE_UPSTREAM_TAG}`;
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
