# wjscli

A CLI **and** [MCP](https://modelcontextprotocol.io/) server for [Wiki.js v2](https://js.wiki/) that authenticates **as a real human user** — by riding the same JWT the browser uses. Page edits are attributed to that user's account; permissions and audit trail stay honest; no admin API key required.

The same set of seven Wiki.js tools is available two ways:

- **MCP stdio server** (`wjscli <url> mcp`) — for Claude Desktop, MCP Inspector, custom MCP clients.
- **CLI** (`wjscli <url> page get --id 42`, `wjscli <url> search "needle"`, etc.) — for shells, scripts, and ad-hoc use.

In every invocation, `<url>` comes first and the subcommand comes second.

## Why

- **Real user attribution.** `creatorId` and `authorId` on every page edit point at the actual person, not a shared API key. The audit log is meaningful.
- **Permissions come for free.** wjscli can only do what the user can do — Wiki.js enforces `read:pages` / `write:pages` / `manage:system` server-side against the JWT's `groups`.
- **No admin API key needed.** Wiki.js v2's built-in API tokens require admin rights and bypass per-user permissions. wjscli avoids that by riding the regular browser JWT instead.
- **Long-running.** Wiki.js's JWT lifetime is 30 minutes, but the server emits a `new-jwt` response header when a token is nearing expiry. wjscli captures that header and updates its stored token, so a process can stay alive indefinitely as long as it makes at least one call per 30 minutes. The `validate` daemon (`-t`) polls just often enough to keep the token live across idle stretches.
- **stdio MCP.** No HTTP listener, no port. Standard MCP transport — drops into Claude Desktop and similar clients with one config block.

## Install

Not published to npm. Two paths:

**Install directly from GitHub** (preferred for users who just want to run it):

```sh
npm install -g git+https://github.com/acehoss/wjscli.git
```

The `prepare` script in `package.json` builds `dist/` automatically during install, so `wjscli` lands on your `$PATH` ready to run.

**From a clone** (for hacking on it):

```sh
git clone https://github.com/acehoss/wjscli.git
cd wjscli
npm install
npm link
```

`npm link` symlinks the working tree's `dist/index.js` into your global PATH as `wjscli`. Rebuild (`npm run build`) and changes are picked up immediately — no re-link needed. Remove with `npm unlink -g wjscli`.

Requires Node ≥ 20.

## Quick start

1. Install — see [Install](#install) above.
2. Get a JWT from your browser. See [Getting a JWT](#getting-a-jwt) — about 10 seconds in DevTools.
3. Validate the JWT and write the config:

    ```sh
    wjscli https://wiki.example.com validate <jwt>
    ```

    On success this writes `~/.config/wjscli/wiki.example.com.json` (mode `0600`) and prints something like:

    ```text
    Connecting to https://wiki.example.com…
    ✓ Authenticated as Example User <user@example.com> (id=7)
    ✓ Config written to /home/user/.config/wjscli/wiki.example.com.json
    ```

4. (Optional, for MCP) Add to your MCP client config. For Claude Desktop, edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your platform:

    ```json
    {
      "mcpServers": {
        "wikijs": {
          "command": "wjscli",
          "args": ["https://wiki.example.com", "mcp"]
        }
      }
    }
    ```

5. Restart your MCP client. The seven `wiki_*` tools should appear.

You can also drive the same tools directly:

```sh
wjscli https://wiki.example.com tags list
wjscli https://wiki.example.com search "onboarding"
wjscli https://wiki.example.com page get --id 42
wjscli https://wiki.example.com page get --path team/onboarding
```

## CLI surface

```text
wjscli <base-url> validate <jwt> [-t]     Validate JWT, write config
                                          -t: stay running, keep token refreshed
wjscli <base-url> mcp                     Start MCP stdio server

wjscli <base-url> pages tree [--parent N --mode ALL|PAGES|FOLDERS --locale L --depth N]
wjscli <base-url> page get   --id N | --path P [--locale L]
wjscli <base-url> page create --path P --title T --content C [...]
wjscli <base-url> page update --id N [fields...]
wjscli <base-url> page history --id N [--offset-page N --offset-size N]
wjscli <base-url> search <query> [--locale L]
wjscli <base-url> tags list

wjscli --version
wjscli --help
```

Add `--json` to any CLI subcommand for the raw MCP-equivalent JSON payload. Default output is a small human-readable rendering per command (box-drawing tree for `pages tree`, key/value + content for `page get`, table-ish for `search` and `page history`, etc.). Example:

```text
$ wjscli https://wiki.example.com pages tree
├── [1] Docs/  (docs)
│   ├── [11] Setup  (docs/setup)
│   └── [12] API  (docs/api)
└── [2] About  (about)
```

`pages tree` recurses 20 levels by default — pass `--depth N` to limit it. Every subcommand accepts `-h` / `--help` for command-specific usage, including options and examples:

```sh
wjscli https://wiki.example.com pages tree --help
wjscli https://wiki.example.com page get -h
wjscli https://wiki.example.com validate --help
```

`page create` and `page update` accept `--content -` to read content from stdin or `--content @path/to/file.md` to read from a file. The same `@-` / `@path` indirection works for `--description`.

Boolean toggles use `--published` / `--no-published` and `--private` / `--no-private`. To pass a value explicitly: `--published=true` / `--published=false`.

Tags are repeatable and comma-splittable: `--tag a --tag b` or `--tag a,b` (both produce `['a', 'b']`).

### Daemon mode (`validate -t`)

`wjscli <url> validate <jwt> -t` does the same one-shot probe as `validate`, writes the config, and then **keeps running** — polling Wiki.js's lightweight `users.profile` query every five minutes to give the server a chance to emit a `new-jwt` refresh header. Any refresh is persisted to the config file atomically. This keeps the stored JWT alive across idle stretches when no MCP or CLI calls are happening.

The daemon exits cleanly on SIGINT/SIGTERM. It also exits (non-zero) if the JWT is rejected — at that point only a fresh JWT can recover.

## Getting a JWT

Wiki.js stores its session JWT in a cookie that is NOT marked `httpOnly` (an upstream Wiki.js choice — see `server/helpers/common.js`), so any JS running in the page can read it.

Open DevTools on any authenticated Wiki.js page and paste into the console:

```js
copy(document.cookie.split('; ').find(c => c.startsWith('jwt=')).slice(4))
```

The JWT is now on your clipboard. Paste it into the `validate` command.

If you want a permanent bookmark, save this as a bookmarklet URL (one line, including the `javascript:` prefix):

```text
javascript:(()=>{const c=document.cookie.split('; ').find(c=>c.startsWith('jwt='));if(!c){alert('No jwt cookie on this page — are you logged in to Wiki.js?');return;}navigator.clipboard.writeText(c.slice(4));alert('JWT copied to clipboard');})();
```

Click the bookmark while viewing a logged-in Wiki.js tab to copy the current JWT to your clipboard.

**Security notes:**

- The JWT is a bearer credential. Anyone who has it can act as you against Wiki.js for the remaining lifetime of the token (default 30 minutes from the most recent refresh).
- wjscli stores it on disk in plaintext at mode `0600` (user-readable only). The containing directory is mode `0700`.
- Treat it like a password: don't paste it into chat, don't commit it, don't email it.

## MCP tools

After validation and (re)start, your MCP client sees these seven tools:

| Tool | What it does |
| --- | --- |
| `wiki_pages_tree` | List a slice of the Wiki.js page tree under a parent node. Each entry includes `depth` (absolute from the wiki root) and `parent` so the caller can rebuild the hierarchy. Defaults: parent=0 (root), mode=ALL, locale=en, depth=20 (deep enough to print the full tree for most wikis). Each extra level adds one GraphQL round-trip per node at the level above. Returned list is flat but ordered DFS (parent, then its subtree). |
| `wiki_page_get` | Fetch a single Wiki.js page by `id` or by `{path, locale?}` (exactly one — never both, never neither). Returns the full Page record (title, path, content, contentType, tags, isPublished, createdAt, updatedAt, authorName, etc.). |
| `wiki_page_create` | Create a Wiki.js page. Required: `path`, `title`, `content`. Defaults applied for unspecified fields: description="", editor="markdown", locale="en", tags=[], isPublished=true, isPrivate=false. The created page is attributed to the user whose JWT was validated. |
| `wiki_page_update` | Update a Wiki.js page. Requires `id` plus at least one field to change. Only supplied fields are sent — omitted fields are left untouched. The update is attributed to the user whose JWT was validated. |
| `wiki_search` | Search Wiki.js pages. Returns `{ results, suggestions, totalHits }` as Wiki.js does — results may be empty with `totalHits=0` if no search engine is configured on the server. Results are filtered by the calling user's `read:pages` permission. |
| `wiki_tags_list` | List all tags across pages the calling user can read. Filtered server-side by `read:pages`. |
| `wiki_page_history` | Fetch the revision history of a Wiki.js page. Paginated via `offsetPage` (default 0) and `offsetSize` (Wiki.js default 100). Requires the calling user have `manage:system` or `read:history`. |

Tool outputs are pretty-printed JSON in a single MCP `text` content block. Tool-execution errors (HTTP, network, GraphQL) come back as `{ isError: true, content: [...] }` with a `{ code, message }` JSON payload — agents see the failure as a normal tool result they can react to, not as a transport-layer error.

The CLI subcommands listed above wrap exactly these seven tools.

## Configuration

- **Location:** `${XDG_CONFIG_HOME:-$HOME/.config}/wjscli/<host>.json`, where `<host>` is the URL host (lowercased, including a non-default port if any). Examples: `wiki.example.com.json`, `wiki.example.com:8443.json`.
- **File mode:** `0600`. **Containing dir mode:** `0700`.
- **Override the config dir** with the `WJSCLI_CONFIG_DIR` env var (mostly useful for tests).
- **Schema:** `{ baseUrl, jwt, refreshedAt, note? }` — see [SPEC.md](./SPEC.md#config-file) for the field list.

The `validate` command writes this file atomically (tmp file + fsync + rename), so a crashed `validate` never leaves a corrupt config.

## How it stays alive

Wiki.js v2's JWT lifetime is 30 minutes from issue. The server emits a `new-jwt` response header on any authenticated `Content-Type: application/json` request when the token is in its renewal window. wjscli captures that header, updates the in-memory token, and atomically writes the new value back to the config file (debounced ~250 ms).

In practice this means:

- If your MCP client uses the wiki at least once every 30 minutes, the JWT stays refreshed indefinitely.
- For idle stretches, run `wjscli <url> validate <jwt> -t` in a separate shell as a daemon — it polls every 5 minutes to keep the refresh window covered.
- If the JWT expires beyond auto-refresh range, the next call gets an auth-rejection from Wiki.js → wjscli surfaces that as an `AuthExpiredError` with re-validate guidance.
- A file watcher on the config also notices if you re-validate from another shell — a running MCP or daemon picks up the new JWT live without needing to restart.

## Re-validating

When you see a tool call fail with `JWT rejected by server` or `Wiki.js rejected the JWT for <url>`, the stored token has expired beyond auto-refresh range. Two-step fix:

1. Grab a fresh JWT (DevTools console or bookmarklet — see [Getting a JWT](#getting-a-jwt)).
2. Re-run `wjscli <base-url> validate <jwt>`.

The running MCP server (or daemon) picks up the new config automatically (file watcher); you don't need to restart your MCP client unless a tool call was in flight.

## Limitations (v1)

- **No assets/uploads.** Page bodies only.
- **No page move/delete.** Read and write to existing or new paths only.
- **No admin/user management.** Per-user permissions apply, but you can't manage users/groups through wjscli.
- **One base URL per process.** If you need access to two Wiki.js instances, run two processes / use two configs.
- **`pages.search` doesn't expose its `path` prefix filter.** Just `query` and `locale`.

## Security

- The JWT is a bearer credential. Anyone holding it can act as you against Wiki.js until it expires.
- Stored at mode `0600` in your user config dir. The directory is `0700`. Don't copy the file or share its contents.
- The JWT is **never logged** by wjscli — error messages from the underlying HTTP / GraphQL client are run through a redactor that scrubs JWT-shaped substrings before they reach any output. Tool result content carries only the structured `{code, message}`, never the token.
- A new-jwt refresh debounces a write to disk; on process shutdown (SIGINT/SIGTERM/normal exit) any pending write is flushed before exit.
- `stdout` is reserved for MCP stdio framing (in `mcp` mode) and for CLI command output. All `validate` output and all error messages go to `stderr`.

## Development

After cloning (see [Install](#install) for the `npm link` flow), the standard workflow:

```sh
npm install            # also runs `prepare` → builds dist/
npm run build          # tsc + chmod 0755 on dist/index.js
npm test               # vitest, hermetic (no live Wiki.js needed)
npm run typecheck
npm run lint
node dist/index.js --help
```

The full design lives in [SPEC.md](./SPEC.md). Tests are organized as:

- `test/config.test.ts` — atomic config file writes, URL canonicalization.
- `test/token-store.test.ts` — JWT lifecycle, debounced disk writes, file watcher.
- `test/wiki/client.test.ts` — HTTP / GraphQL / network classification, JWT redaction, retry policy, `new-jwt` capture.
- `test/wiki/queries.test.ts` — GraphQL document pin-tests.
- `test/validate.test.ts` — `wjscli <url> validate` (with and without `-t`) end-to-end against an in-process Wiki.js mock.
- `test/server.test.ts` — `wjscli <url> mcp` startup, signal handling.
- `test/index.test.ts` — top-level argv dispatch.
- `test/cli/argv.test.ts` — CLI argv reader unit tests.
- `test/cli/run.test.ts` — CLI dispatch end-to-end through `runCli` against the mock.
- `test/tools/*.test.ts` — per-tool happy / Zod / auth-expired / GraphQL paths via `dispatchTool` directly.
- `test/tools/e2e.test.ts` — one round trip per tool through real `Server` + `Client` over an in-memory transport pair, plus JWT-refresh integration.
- `test/mock/graphql-server.ts` — typed mock backend used by everything above except the standalone client tests.

## Reporting issues

This project doesn't yet have a public issues URL. If you've got it from someone, send your feedback to whoever shared it.
