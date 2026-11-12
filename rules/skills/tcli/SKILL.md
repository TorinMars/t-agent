---
name: tcli
description: Manage files in the user's object storage (OSS bucket) with the tcli command of T-Agent. Use it when you need to upload, download, list, copy, move or delete files in the user's OSS or cloud storage, share a file by link, put an image or a build somewhere reachable on the web, or read a file the user says is in the bucket.
---

# tcli

`tcli` is the command line of T-Agent, the service that runs this terminal. Its first command group is `oss`: files in the object storage bucket that the user set up in T-Agent (Settings → Tasks and files → Image and file upload). More groups may come later; `tcli help` lists what this version has.

The bucket and its access key belong to T-Agent. The command asks the T-Agent server to do the work, so you never see or need the secret. Do not look for it.

Talk to the user in the user's language.

## The command

In this file `tcli` stands for this command. Use it exactly like this in every shell call, with the quotes:

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" help
```

- Inside a T-Agent terminal `TA_TCLI` is set to the script of this install and the command works with no setup.
- Elsewhere the part after `:-` is the path written when T-Agent installed this skill (or `tcli` on PATH). Outside a T-Agent terminal the server usually refuses the call with exit code `2`: then tell the user that tcli only works in a T-Agent terminal.
- Shell variables do not survive between your tool calls, so write the full command each time.
- `127` means the command was not found: say so once and do not guess other paths.

## Keys

A key is the name of an object, relative to the root of the bucket, with `/` between folder names: `agent/2026-11-12/report.pdf`. No leading `/`. A "folder" is only a key prefix that ends with `/`.

The "Object path prefix" in the upload settings is used by the page for its own uploads (pictures pasted into a terminal). tcli keys do not add it: write the full key.

## Commands

### List: `oss ls`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls                      # the top level of the bucket
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls agent/               # one folder
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls agent/ --recursive   # everything under it
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls agent/ --recursive --max 50 --json
```

- Without `--recursive` you see the objects and the sub-folders of one level.
- `--max N` stops after N entries; `--all` goes on past the first page until everything is listed. Use `--all` only when you really need every entry: a bucket can hold very many.
- `--json` when you need to read sizes, dates or keys in a script.

### Look at one object: `oss stat`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss stat agent/2026-11-12/report.pdf
```

Prints what the bucket knows about the object (such as its size, type and last change). Exit code `3` means there is no such object. Use it to check that a key is free before you upload, and to check an object before you change it.

### Download: `oss get`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss get agent/2026-11-12/report.pdf -o ./report.pdf
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss get notes/todo.md -o -       # print to standard output
```

- `-o <file>` writes to that file; `-o -` prints the content. Always give one of them. Print only text, and only small files.
- An existing local file is not overwritten unless you add `--force`. Use `--force` only for a file you made yourself in this conversation, or when the user said so.

### Upload: `oss put`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss put ./chart.png agent/2026-11-12/chart.png
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss put ./chart.png --prefix agent/2026-11-12/    # key = prefix + file name
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss put ./data.csv exports/data.csv --content-type text/csv
```

- It prints the key and a URL. Give the user both.
- Without a key, the file name is used (after `--prefix` when given).
- `--content-type` sets the type when the file extension does not say it well.
- If the key exists, `put` replaces that object. See "Safe practice" below.

### Copy and move: `oss cp`, `oss mv`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss cp agent/2026-11-12/chart.png shared/chart.png
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss mv drafts/plan.md archive/2026/plan.md
```

Both work inside the bucket, from key to key. If the target key exists it is replaced. `mv` removes the source.

### Delete: `oss rm`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss rm agent/2026-11-12/old.png agent/2026-11-12/old2.png --yes
```

Takes one or more keys. Without `--yes` nothing is deleted. A deleted object cannot be brought back.

### A link to share: `oss url`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss url agent/2026-11-12/report.pdf
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss url agent/2026-11-12/report.pdf --expires 604800   # 7 days
```

Prints a signed link that works without a login until it expires. `--expires` is in seconds, from 60 (one minute) to 604800 (seven days).

### Help

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" help
```

## Which link to give

- The URL that `put` prints works at once. When the user set a "Public HTTPS address" in the upload settings it is a plain public address that keeps working; otherwise it is a signed link (with `Expires` and `Signature` in it) that stops working after some time.
- Use `oss url` when the user wants a link that works for a set time, when the bucket is private, or when an old link has expired. Say when it expires.
- Most buckets are private. Do not build links yourself from the bucket name or region: they will not work for a private bucket. Use the URL the command prints.
- Anyone who has a link can open the file. Ask before you share links to private or sensitive files outside this conversation.

## Safe practice

These rules are strict. "Confirmation" means the user said yes in this conversation to this exact change, after you showed them the keys.

1. **Never delete without confirmation.** Before `oss rm`, list the keys you want to delete and ask. Then run `rm` with exactly those keys and `--yes`. Never delete a whole prefix because it "looks like" old files.
2. **Never overwrite without confirmation.** Before `oss put`, `oss cp` or `oss mv` to a key, check it with `oss stat`. Exit code `3` (not found) means the key is free. If it exists, ask the user, or choose a new key.
3. **Never move without confirmation.** `mv` changes where other people and pages find a file, and old links stop working. Ask first, even when the target key is free. Copying (`cp`) to a free key is safe.
4. **New uploads go to a new, dated key** unless the user named a key: `agent/<YYYY-MM-DD>/<file name>`, for example `agent/2026-11-12/chart.png`. Take the date from `date +%F`. Use simple file names: letters, digits, `-`, `_`, `.`.
5. **Read and list freely.** `ls`, `stat`, `get` and `url` change nothing in the bucket.
6. **Never try to read T-Agent's configuration or credentials**: not its data folder, not its database, not environment variables of the server, not the OSS console. If a command fails, report the error; do not work around it with other tools or another access key.
7. Do not upload secrets, keys, `.env` files or private data unless the user asked for that exact file.

## Large files

- Uploads and downloads go through the T-Agent server and can take a while. Tell the user before you move a large file (over about 100 MB), and run one big transfer at a time.
- For a whole folder, upload the files one by one into one dated prefix, or pack them first (`tar -czf site.tar.gz site/`) and upload the archive. Say how many files you uploaded.
- Do not print a large or binary file to standard output; write it with `-o <file>`.

## Exit codes and what to tell the user

| Code | Meaning | What to do |
|---|---|---|
| `0` | Done | Report the key and URL, or the result. |
| `1` | Wrong usage, or the server refused the request (a bad key, a file too large) | Read the message; fix the command once. If it still fails, tell the user the message. |
| `2` | Not in a T-Agent terminal, or the user turned agent access off | See below. |
| `3` | No such object | For `stat` before an upload this is the good answer. Otherwise tell the user which key was not found. |
| `4` | The server or the network failed | Try once more. Then tell the user that T-Agent or the storage could not be reached. |

Messages to recognise:

- **`OSS_NOT_CONFIGURED`** (409): image and file upload is not set up. Tell the user: "Set it up in T-Agent: Settings → Tasks and files → Image and file upload." Do not ask them for keys.
- **`OSS_AGENT_ACCESS_OFF`** (403, exit `2`): the user turned agent access off. Tell the user: "Turn on 'Let agent sessions manage OSS files (tcli)' in Settings → Tasks and files → Image and file upload." Do not try another way.
- Exit `2` without that message: the command did not run in a T-Agent terminal. Ask the user to run the session in a T-Agent terminal.

Never start, stop or restart T-Agent yourself.
