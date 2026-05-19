# wikijs-mcp

An [MCP](https://modelcontextprotocol.io/) server that lets agents (Claude Desktop, MCP Inspector, custom CLIs) read from and write to a [Wiki.js v2](https://js.wiki/) instance **as a real human user** — by riding the same JWT the browser uses. Page edits are attributed to that user's account; permissions and audit trail stay honest; no admin API key required.

## Why

- **Real user attribution.** `creatorId` and `authorId` on every page edit point at the actual person, not a shared API key. The audit log is meaningful.
- **Permissions come for free.** The MCP can only do what the user can do — Wiki.js enforces `read:pages` / `write:pages` / `manage:system` server-side against the JWT's `groups`.
- **No admin API key needed.** Wiki.js v2's built-in API tokens require admin rights and bypass per-user permissions. This MCP avoids that by riding the regular browser JWT instead.
- **Long-running.** Wiki.js's JWT lifetime is 30 minutes, but the server emits a `new-jwt` response header when a token is nearing expiry. The MCP captures that header and updates its stored token, so a process can stay alive indefinitely as long as it makes at least one call per 30 minutes.
- **stdio MCP.** No HTTP listener, no port. Standard MCP transport — drops into Claude Desktop and similar clients with one config block.

## Install

Not published to npm. Two paths:

**Install directly from GitHub** (preferred for users who just want to run it):

```sh
npm install -g git+https://github.com/acehoss/wikijs-mcp.git
```

The `prepare` script in `package.json` builds `dist/` automatically during install, so `wikijs-mcp` lands on your `$PATH` ready to run.

**From a clone** (for hacking on it):

```sh
git clone https://github.com/acehoss/wikijs-mcp.git
cd wikijs-mcp
npm install
npm link
```

`npm link` symlinks the working tree's `dist/index.js` into your global PATH as `wikijs-mcp`. Rebuild (`npm run build`) and changes are picked up immediately — no re-link needed. Remove with `npm unlink -g wikijs-mcp`.

Requires Node ≥ 20.

## Quick start

1. Install — see [Install](#install) above.
2. Get a JWT from your browser. See [Getting a JWT](#getting-a-jwt) — about 10 seconds in DevTools.
3. Bootstrap the config:

    ```sh
    wikijs-mcp bootstrap https://wiki.example.com <jwt>
    ```

    On success this writes `~/.config/wikijs-mcp/wiki.example.com.json` (mode `0600`) and prints something like:

    ```text
    Connecting to https://wiki.example.com…
    ✓ Authenticated as Example User <user@example.com> (id=7)
    ✓ Config written to /home/user/.config/wikijs-mcp/wiki.example.com.json
    ```

4. Add to your MCP client config. For Claude Desktop, edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your platform:

    ```json
    {
      "mcpServers": {
        "wikijs": {
          "command": "wikijs-mcp",
          "args": ["https://wiki.example.com"]
        }
      }
    }
    ```

5. Restart your MCP client. The seven `wiki_*` tools should appear.

## Getting a JWT

Wiki.js stores its session JWT in a cookie that is NOT marked `httpOnly` (an upstream Wiki.js choice — see `server/helpers/common.js`), so any JS running in the page can read it.

Open DevTools on any authenticated Wiki.js page and paste into the console:

```js
copy(document.cookie.split('; ').find(c => c.startsWith('jwt=')).slice(4))
```

The JWT is now on your clipboard. Paste it into the `bootstrap` command.

If you want a permanent bookmark, save this as a bookmarklet URL (one line, including the `javascript:` prefix):

```text
javascript:(()=>{const c=document.cookie.split('; ').find(c=>c.startsWith('jwt='));if(!c){alert('No jwt cookie on this page — are you logged in to Wiki.js?');return;}navigator.clipboard.writeText(c.slice(4));alert('JWT copied to clipboard');})();
```

Click the bookmark while viewing a logged-in Wiki.js tab to copy the current JWT to your clipboard.

**Security notes:**

- The JWT is a bearer credential. Anyone who has it can act as you against Wiki.js for the remaining lifetime of the token (default 30 minutes from the most recent refresh).
- The MCP stores it on disk in plaintext at mode `0600` (user-readable only). The containing directory is mode `0700`.
- Treat it like a password: don't paste it into chat, don't commit it, don't email it.

## Tools

After bootstrap and restart, your MCP client sees these seven tools:

| Tool | What it does |
| --- | --- |
| `wiki_pages_tree` | List a flat slice of the Wiki.js page tree under a parent node. Each entry includes `depth` and `parent` so the caller can rebuild the hierarchy. Defaults: parent=0 (root), mode=ALL, locale=en. |
| `wiki_page_get` | Fetch a single Wiki.js page by `id` or by `{path, locale?}` (exactly one — never both, never neither). Returns the full Page record (title, path, content, contentType, tags, isPublished, createdAt, updatedAt, authorName, etc.). |
| `wiki_page_create` | Create a Wiki.js page. Required: `path`, `title`, `content`. Defaults applied for unspecified fields: description="", editor="markdown", locale="en", tags=[], isPublished=true, isPrivate=false. The created page is attributed to the user whose JWT was used at bootstrap. |
| `wiki_page_update` | Update a Wiki.js page. Requires `id` plus at least one field to change. Only supplied fields are sent — omitted fields are left untouched. The update is attributed to the bootstrap user. |
| `wiki_search` | Search Wiki.js pages. Returns `{ results, suggestions, totalHits }` as Wiki.js does — results may be empty with `totalHits=0` if no search engine is configured on the server. Results are filtered by the calling user's `read:pages` permission. |
| `wiki_tags_list` | List all tags across pages the calling user can read. Filtered server-side by `read:pages`. |
| `wiki_page_history` | Fetch the revision history of a Wiki.js page. Paginated via `offsetPage` (default 0) and `offsetSize` (Wiki.js default 100). Requires the calling user have `manage:system` or `read:history`. |

Tool outputs are pretty-printed JSON in a single MCP `text` content block. Tool-execution errors (HTTP, network, GraphQL) come back as `{ isError: true, content: [...] }` with a `{ code, message }` JSON payload — agents see the failure as a normal tool result they can react to, not as a transport-layer error.

## Configuration

- **Location:** `${XDG_CONFIG_HOME:-$HOME/.config}/wikijs-mcp/<host>.json`, where `<host>` is the URL host (lowercased, including a non-default port if any). Examples: `wiki.example.com.json`, `wiki.example.com:8443.json`.
- **File mode:** `0600`. **Containing dir mode:** `0700`.
- **Override the config dir** with the `WIKIJS_MCP_CONFIG_DIR` env var (mostly useful for tests).
- **Schema:** `{ baseUrl, jwt, refreshedAt, note? }` — see [SPEC.md](./SPEC.md#config-file) for the field list.

The bootstrap command writes this file atomically (tmp file + fsync + rename), so a crashed bootstrap never leaves a corrupt config.

## How it stays alive

Wiki.js v2's JWT lifetime is 30 minutes from issue. The server emits a `new-jwt` response header on any authenticated `Content-Type: application/json` request when the token is in its renewal window. This MCP captures that header, updates the in-memory token, and atomically writes the new value back to the config file (debounced ~250 ms).

In practice this means:

- If your MCP client uses the wiki at least once every 30 minutes, the JWT stays refreshed indefinitely.
- If the MCP sits idle for more than 30 minutes, the next call gets an auth-rejection from Wiki.js → the MCP surfaces that as an `AuthExpiredError` McpError with re-bootstrap guidance.
- A file watcher on the config also notices if you re-bootstrap from another shell — the running MCP picks up the new JWT live without needing to restart.

## Re-bootstrapping

When you see a tool call fail with `JWT rejected by server` or `Wiki.js rejected the JWT for <url>`, the stored token has expired beyond auto-refresh range. Two-step fix:

1. Grab a fresh JWT (DevTools console or bookmarklet — see [Getting a JWT](#getting-a-jwt)).
2. Re-run `wikijs-mcp bootstrap <base-url> <jwt>`.

The running MCP server picks up the new config automatically (file watcher); you don't need to restart your MCP client unless a tool call was in flight.

## Limitations (v1)

- **No assets/uploads.** Page bodies only.
- **No page move/delete.** Read and write to existing or new paths only.
- **No admin/user management.** Per-user permissions apply, but you can't manage users/groups through this MCP.
- **No proactive heartbeat.** JWT refresh happens opportunistically, on calls. Idle-longer-than-30-min → expired.
- **One base URL per process.** If you need MCP access to two Wiki.js instances, run two `wikijs-mcp` processes.
- **`pages.search` doesn't expose its `path` prefix filter.** Just `query` and `locale`.

## Security

- The JWT is a bearer credential. Anyone holding it can act as you against Wiki.js until it expires.
- Stored at mode `0600` in your user config dir. The directory is `0700`. Don't copy the file or share its contents.
- The JWT is **never logged** by this MCP — error messages from the underlying HTTP / GraphQL client are run through a redactor that scrubs JWT-shaped substrings before they reach any output. Tool result content carries only the structured `{code, message}`, never the token.
- A new-jwt refresh debounces a write to disk; on process shutdown (SIGINT/SIGTERM/normal exit) any pending write is flushed before exit.
- `stdout` is reserved for MCP stdio framing. All bootstrap output and all error messages go to `stderr`.

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
- `test/bootstrap.test.ts` — `wikijs-mcp bootstrap` end-to-end against an in-process Wiki.js mock.
- `test/server.test.ts` — `wikijs-mcp <url>` startup, signal handling.
- `test/index.test.ts` — argv dispatch.
- `test/tools/*.test.ts` — per-tool happy / Zod / auth-expired / GraphQL paths via `dispatchTool` directly.
- `test/tools/e2e.test.ts` — one round trip per tool through real `Server` + `Client` over an in-memory transport pair, plus JWT-refresh integration.
- `test/mock/graphql-server.ts` — typed mock backend used by everything above except the standalone client tests.

## Reporting issues

This project doesn't yet have a public issues URL. If you've got it from someone, send your feedback to whoever shared it.
