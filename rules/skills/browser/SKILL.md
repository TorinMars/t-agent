---
name: browser
description: Explore a website in the user's own browser with T-Agent's tcli browser command, learn how it works (its pages, actions and APIs), and build up a reusable site entry with tcli site. Use it when you need to drive the user's browser, read or act on a page, discover a site's requests, or remember how to do something on a site for next time.
---

# browser

T-Agent can drive the user's own browser through a paired Chrome extension, and it keeps a **site library**: one entry per website with what has been learnt about it, shared across the user's linked devices. Two command groups of `tcli` work together:

- `tcli browser ...` — look at and act on a page in the user's browser (open tabs, read a page, click and type, watch the network, record a session). This is the live exploration.
- `tcli site ...` — read and write the site library: the accumulated knowledge (summary, pages, actions, APIs) for a host like `github.com`.

The loop this skill teaches: **explore with `tcli browser`, then write down what you learnt with `tcli site`, so the next session does not start from zero.**

Talk to the user in the user's language.

## The command

In this file `tcli` stands for this command. Use it exactly like this in every shell call, with the quotes:

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" help
```

- Inside a T-Agent terminal `TA_TCLI` is set and the command works with no setup.
- Outside a T-Agent terminal the server refuses with exit code `2`: then tell the user it only works in a T-Agent terminal.
- Shell variables do not survive between tool calls, so write the full command each time. `127` means the command was not found: say so once and do not guess.

## Before you explore: does a site entry already exist?

Always check the library first; it may already hold what you need.

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" site list                 # every known site
${TA_TCLI:+node} "${TA_TCLI:-tcli}" site show github.com      # the full entry for one host
${TA_TCLI:+node} "${TA_TCLI:-tcli}" site search "download invoice"   # find a known action or API
```

If an entry already describes the action, follow its steps with `tcli browser` instead of exploring again. If it is wrong or incomplete, explore and update it (below).

## Explore with `tcli browser`

Only tabs T-Agent opened, or tabs the user handed over with the extension button, can be driven. Typical flow:

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser status            # is a browser paired and online?
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser open https://github.com
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser snapshot          # the page as a list of elements (e1 button "Sign in" ...)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser click e12         # click an element by its ref
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser type css:#search "invoices" --submit
```

To discover the **requests and APIs** a page uses, capture the network or record the whole interaction:

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser net start
#  ... do the action in the page ...
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser net list --type XHR,Fetch
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser net get <req_id>          # one request's method, URL, headers (redacted), shape

${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record start             # a full recording (navigations, clicks, inputs, requests)
#  ... do the action ...
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record stop
```

`tcli browser help` lists every command. Read a request's shape (method, URL template, which parameters it takes) rather than its exact values.

## Write it down with `tcli site`

Turn what you learnt into a site entry. The entry is **authored content you write**, from what you saw — not a dump of the recording. Keep it short and useful for next time.

An entry (one host) has:

- `title`, `summary` (Markdown: what the site is and how to use it),
- `pages`: `{ pattern, purpose }` — the useful URLs,
- `actions`: `{ name, description, steps, selectors }` — how to do a thing, as plain steps or as `tcli browser` commands,
- `apis`: `{ name, method, url (a template with {param}), description, auth, params, request_example, response_shape }`,
- `notes`, `sources` (the `recording_id` you learnt from).

Write the whole entry as a JSON file and save it, or save a Markdown summary and add the rest with `edit`:

```bash
#  Whole entry from a JSON file (replaces the entry):
${TA_TCLI:+node} "${TA_TCLI:-tcli}" site save github.com --file github.json

#  Just a Markdown summary (the file becomes the entry's summary):
${TA_TCLI:+node} "${TA_TCLI:-tcli}" site save github.com --file github.md

#  Change simple fields on an existing entry:
${TA_TCLI:+node} "${TA_TCLI:-tcli}" site edit github.com title="GitHub" notes="2FA is required to sign in"
${TA_TCLI:+node} "${TA_TCLI:-tcli}" site edit github.com --file more.json        # merge a JSON partial
```

Example `github.json`:

```json
{
  "title": "GitHub",
  "summary": "# GitHub\nCode hosting. Sign in is required for private repos.",
  "pages": [{ "pattern": "https://github.com/{owner}/{repo}", "purpose": "A repository" }],
  "actions": [{
    "name": "search repositories",
    "description": "Search the whole site",
    "steps": [
      "tcli browser open https://github.com",
      "tcli browser type css:#query-builder-test \"QUERY\" --submit"
    ]
  }],
  "apis": [{
    "name": "list repos",
    "method": "GET",
    "url": "https://api.github.com/users/{user}/repos",
    "auth": "page cookies",
    "description": "The user's public repositories"
  }]
}
```

The host is lowercased and loses a leading `www.` automatically, so `github.com`, `www.github.com` and `https://github.com/x` all mean the same entry. Saving replaces the entry; use `edit` to keep most of it and change a part. `tcli site rm <host> --yes` deletes one.

## Never store real secrets

The site library is **documentation, shared across the user's devices**. It must never hold real credentials.

- Do not put tokens, cookies, session IDs, API keys, passwords or `Authorization` header values into an entry. Describe the auth instead: `"auth": "page cookies"` or `"auth": "header X-Api-Key (the user's own key, not stored)"`.
- `tcli browser net get` and recordings already redact secrets. Keep it that way: in `request_example` and `response_shape`, replace any real value that looks like a token with a placeholder such as `<TOKEN>`.
- The server runs the redaction rule over every saved entry and **refuses it with `SITE_HAS_SECRET`** if a value still looks like a token (a long opaque key, a JWT, a bearer token). If you see that error, find the value named in the message and replace it with a placeholder, then save again. Do not try to get around it.

## Safe practice

1. **Read before you write.** `site list`, `site show`, `site search`, `browser status`, `browser snapshot`, `browser net list` change nothing. Use them first.
2. **Ask before you act in the user's browser** when the action has an effect they cannot undo (buying, sending, deleting, posting). Exploring and reading are fine; acting on the user's behalf needs their yes in this conversation.
3. **Keep entries small and honest.** Write what you verified, not guesses. Put the `recording_id` in `sources` so the next session can check.
4. **One host per entry.** Use the site's real host (`github.com`), not a full URL.
5. **Never read T-Agent's configuration or credentials**, and never start, stop or restart T-Agent yourself. If a command fails, report the error.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| `0` | Done | Report the result. |
| `1` | Wrong usage, or the server refused (bad entry, `SITE_HAS_SECRET`, no such request) | Read the message, fix once. |
| `2` | Not in a T-Agent terminal, or access is off | Tell the user to run the session in a T-Agent terminal. |
| `3` | Not found (no such site entry, tab or request) | Tell the user what was not found. |
| `4` | Server or network failed (the browser may be offline) | Check `browser status`; tell the user if the browser is not reachable. |
