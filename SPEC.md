# wikijs-mcp — Project Spec

> Authoritative working spec for the team. Read this before doing any work.
> If reality diverges from the spec, update this file in the same change.

## Purpose

An MCP server that lets agents and CLIs interact with a Wiki.js v2 instance **as a real human user** — preserving that user's permissions and audit trail. Solves the Wiki.js admin-only API-key problem by riding the same JWT the browser uses (verified via the existing `Authorization: Bearer <jwt>` path on `/graphql`).

## Background — why this works

- Wiki.js v2 already authenticates `/graphql` requests by `Authorization: Bearer <jwt>`. When the JWT carries a real user's `id`/`permissions`/`groups` (and **no `api` claim**), the request is processed as that user — `creatorId` / `authorId` on page mutations are set correctly. Audit is right.
- Default JWT lifetime is **30 minutes** (`server/setup.js:81`).
- Wiki.js emits a `new-jwt` response header only when the JWT is in its renewal window or when the user/group has been flagged for revalidation, AND when the request had `Content-Type: application/json` (see `server/core/auth.js:144-167`). For long-running processes this is enough — most authed responses do NOT refresh, but ones near expiry do. Riding this opportunistic refresh stream is the way to keep a process alive without long-lived tokens.
- The `jwt` cookie is **not** `httpOnly` (`server/helpers/common.js:45-50`), so a power user can copy it from the browser console:
  ```js
  copy(document.cookie.split('; ').find(c => c.startsWith('jwt=')).slice(4))
  ```

## CLI surface

Single binary `wikijs-mcp` with two modes.

### Server mode (default — stdio MCP)
```
wikijs-mcp <base-url>
```
- Reads JWT from the config file derived from `<base-url>`.
- Watches the config file; reloads JWT on change (so a re-bootstrap from another shell takes effect live).
- Speaks MCP over stdio.
- After every Wiki.js call, if the response carried `new-jwt`, writes the refreshed JWT back to the config file atomically.
- If no config is found on disk at startup, exits with a clear error directing the user to `wikijs-mcp bootstrap`. Server mode does NOT probe the JWT at startup — an expired or invalid JWT is detected on the first tool call and surfaces as `AuthExpiredError` with re-bootstrap guidance. Trade-off: faster cold start vs. delayed validity feedback.

### Bootstrap mode
```
wikijs-mcp bootstrap <base-url> <jwt>
```

- Validates the JWT by making `query { users { profile { id email name } } }` against `<base-url>/graphql`. This is the only user-query field on Wiki.js v2 without an `@auth` schema directive whose resolver still rejects guests, so any authenticated user can call it regardless of permissions. Source: `repos/wiki/server/graph/resolvers/user.js`.
- Captures the `new-jwt` header from the response (this is the refreshed token).
- Writes `{ baseUrl, jwt, refreshedAt }` to the config file with mode `0600`.
- All output goes to stderr (stdout is reserved for MCP stdio in server mode).
- Exit codes: `0` on success, `2` on usage / malformed input (missing args, bad URL, malformed JWT shape), `1` on runtime failure (auth rejection, HTTP error, network error, GraphQL error, write failure).
- Reuses `WikiClient` for the probe via a `TokenStore.inMemory(baseUrl, jwt)` factory — same auth header, same `new-jwt` capture, same error classification and redaction as production calls. No file I/O until after the probe succeeds.

## Config file

- Location: `${XDG_CONFIG_HOME:-$HOME/.config}/wikijs-mcp/<host>.json`
  - `<host>` is the URL host (`new URL(baseUrl).host`, lowercased), e.g. `wiki.example.com` or `wiki.example.com:8443`.
  - Override path with `WIKIJS_MCP_CONFIG_DIR` env var (useful for tests).
- File mode `0600`. Containing directory mode `0700`.
- Atomic writes: write to temp file in the same dir, fsync, rename over.
- Schema (TypeScript):
  ```ts
  type ConfigFile = {
    baseUrl: string;       // canonical, no trailing slash
    jwt: string;
    refreshedAt: string;   // ISO 8601 from when this JWT was last written
    note?: string;         // optional user note
  };
  ```

## MCP tools (v1)

All tools call `/graphql` with the in-memory JWT and update the in-memory JWT (plus on-disk for persistent stores) from any `new-jwt` response header. Tool output is a single MCP `text` content block carrying pretty-printed JSON. Input schemas are defined in Zod (`src/tools/*.ts`) and surfaced as JSON Schema via `zod-to-json-schema`.

The dispatcher uses a three-tier error strategy (see `src/tools/index.ts:dispatchTool`):

1. **Zod parse failures** (caller passed bad args) → `throw new McpError(InvalidParams, …)`. The SDK surfaces this as a JSON-RPC error.
2. **`AuthExpiredError`** (re-bootstrap is the only fix) → `throw new McpError(InvalidRequest, …)` with the re-bootstrap-guidance message. Also a JSON-RPC error; the protocol-level surface is right here because the agent has no recovery without user action.
3. **Other `WikiMcpError` subclasses** (`HttpError`, `NetworkError`, `GraphQLError`, etc. — tool-execution errors the agent might react to) → **return** `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }, null, 2) }] }`. The call succeeds at the protocol level; the agent reads `isError` and the structured `{ code, message }` JSON to decide what to do. WikiMcpError messages have already been through the JWT redactor.
4. **Anything truly unexpected** → re-throw; the SDK wraps as `-32603 InternalError`.

Pinned in `test/tools/e2e.test.ts` (E2E layer) and per-tool tests under `test/tools/*.test.ts` (direct `dispatchTool` calls).

| Tool | GraphQL backing | Required input | Optional input (defaults) | Notes |
| --- | --- | --- | --- | --- |
| `wiki_pages_tree` | `pages.tree` | — | `parent` (0), `mode` ('ALL'), `locale` ('en') | `mode` is one of `'ALL' \| 'PAGES' \| 'FOLDERS'`. Returns `{ tree: [...] }` — flat list with `depth`/`parent`; caller rebuilds the hierarchy. |
| `wiki_page_get` | `pages.single` (by id) OR `pages.singleByPath` | exactly one of `id: int` or `path: string` | `locale` ('en', used only with `path`) | XOR enforced by Zod refine; supplying both or neither → `InvalidParams`. Returns `{ page }`. Some Page fields (content, editor, author/creator details) require `write:pages` or `manage:system` server-side — Wiki.js returns a GraphQL error if the user lacks those, which propagates as `GraphQLError`. |
| `wiki_page_create` | `pages.create` mutation | `path: string`, `title: string`, `content: string` | `description` (`''`), `editor` (`'markdown'`), `locale` (`'en'`), `tags` (`[]`), `isPublished` (`true`), `isPrivate` (`false`) | Wiki.js's create mutation requires every listed field server-side (all non-null in `page.graphql`). We always send the full set with defaults. Returns `{ responseResult, page }` — check `responseResult.succeeded`; validation failures (duplicate path etc.) come back here, NOT as GraphQL errors. |
| `wiki_page_update` | `pages.single` then `pages.update` mutation | `id: int` + at least one mutable field | any subset of `content`, `description`, `editor`, `isPrivate`, `isPublished`, `locale`, `path`, `tags`, `title` | **Fetch-merge-update**: tool first reads the current page state via `pages.single(id)`, merges supplied fields on top, then sends a complete update payload with every field. Required because Wiki.js's update resolver silently destroys some fields when they're omitted (verified against Wiki.js v2.5: `isPublished` flips to `false`, publish dates blank out, `tags` crashes with `tags.map` on undefined, `content` is rejected with `PageEmptyContent`). One extra round-trip per call; in exchange the tool's "supplied fields change, others preserved" contract is actually safe. `id`-only input → `InvalidParams`. Returns `{ responseResult, page }`. |
| `wiki_search` | `pages.search` | `query: string` | `locale` (omitted when absent) | Returns `{ results, suggestions, totalHits }` exactly as Wiki.js returns. Empty result is `{ results: [], suggestions: [], totalHits: 0 }`. Wiki.js returns this shape even when no search engine is configured. |
| `wiki_tags_list` | `pages.tags` | — | none (strict — extra keys rejected) | Returns `{ tags: [...] }`. Filtered server-side by `read:pages`. |
| `wiki_page_history` | `pages.history` | `id: int` | `offsetPage`, `offsetSize` | Returns `{ trail, total }`. Requires `manage:system` or `read:history` server-side. |

Out of scope for v1: assets/uploads, page move/delete, admin/user mgmt, page conflicts/diff resolution, `pages.search`'s `path` argument (we expose `query` + `locale` only).

## Wiki.js GraphQL client (internal module)

- `class WikiClient` constructed with `{ tokenStore, fetchImpl? }`. The base URL is derived from `tokenStore.getBaseUrl()` — there is no duplicate `baseUrl` option.
- `async gql<T>(query, variables?): Promise<T>`.
- Always sends `Authorization: Bearer <tokenStore.getToken()>` and `Content-Type: application/json`.
- After every response (success or failure): read the `new-jwt` header; if present and non-empty, call `tokenStore.update(fresh)`. The store decides whether to persist (disk write for the loaded-from-file store, no-op for in-memory).
- Errors:
  - Network / fetch rejection → `NetworkError`. Retried exactly once. Second failure throws.
  - HTTP 401 → `AuthExpiredError` with rebootstrap guidance.
  - HTTP non-2xx (other) → `HttpError` with status + redacted body excerpt (≤ 512 bytes, JWT-shaped substrings replaced with `<jwt-redacted>`).
  - GraphQL `errors[]` whose `message` matches `/must be authenticated|invalid token|jwt expired|jwt malformed|unauthor[iy]zed/i` → `AuthExpiredError`. The load-bearing case is `must be authenticated`: when passport-jwt rejects the token, Wiki.js sets `req.user` to guest (id=2), responds HTTP 200, and the `users.profile` resolver throws `WIKI.Error.AuthRequired` whose message is `"You must be authenticated to access this resource."` (see `server/helpers/error.js`, `server/core/auth.js`, `server/graph/resolvers/user.js`). Other entries → `GraphQLError`. Messages are run through the JWT redactor before reaching the thrown error. We never scan `extensions.code` or `extensions.exception.name` (Wiki.js leaks class names like `PageUpdateForbidden` there), and `forbidden` is intentionally NOT in the pattern (Wiki.js `Page*Forbidden` errors carry messages like "You are not authorized to ..." which are permission errors, not JWT-expiry).
- All error types extend an abstract `WikiMcpError` base with a `code` discriminator (`'network' | 'http' | 'graphql' | 'auth_expired' | 'config_parse' | 'missing_config'`).

## JWT lifecycle

- **In-memory state is the source of truth during a process lifetime.** The `TokenStore` class owns it.
- **Two TokenStore modes:**
  - `TokenStore.loadForBaseUrl(baseUrl)` — persistent. Reads the config file, starts a directory watcher (basename-filtered, so atomic-rename writes don't kill it on macOS), and persists every `update()` via a ~250ms-debounced atomic write. Self-writes are suppressed via a SHA-256 hash of the last-written content plus an in-flight-write hash for the rename window. Throws `MissingConfigError` when there's no config on disk.
  - `TokenStore.inMemory(baseUrl, jwt)` — non-persistent. Same `getToken()`/`update()` surface, but no file I/O and no watcher. Used by bootstrap to run a one-shot probe through `WikiClient` and read out the refreshed JWT via `getToken()` before writing the config explicitly with `writeConfig`.
- **On startup (server mode):** `TokenStore.loadForBaseUrl(baseUrl)`. Construct `WikiClient` from it.
- **On any API response:** `tokenStore.update(newJwt)` if the `new-jwt` header is set. Persistent stores schedule a debounced atomic write; in-memory stores just update the field.
- **Process lifecycle (server mode):** SIGINT/SIGTERM/`beforeExit` handlers call `await tokenStore.close()`, which awaits any pending or in-flight write before returning. `close()` is idempotent.
- **No proactive heartbeat** in v1. If an MCP sits idle > 30 minutes between calls, the next call gets HTTP 200 with a GraphQL errors envelope containing `"You must be authenticated to access this resource."` (the `AuthRequired` message; see `WikiClient` error classification) → we surface `AuthExpiredError` to the agent.

## Testing strategy

- **Mock-first.** Tests run against an in-process mock GraphQL server at `test/mock/graphql-server.ts`:
  - Listens on a random localhost port (`startMockGraphQLServer()`); torn down per-test via `closeAllConnections()` + `close()`.
  - Does NOT validate JWT signatures — the mock trusts whatever Authorization header arrives. JWT validity is the real Wiki.js server's job; our coverage proves the *client* sends and refreshes JWTs correctly, not that the server validates them.
  - Has a generic `setNext(script)` knob for error envelopes and arbitrary shapes (used for bootstrap, error-path, and edge-case tests).
  - Has **typed `replyTo*` helpers** — one per Wiki.js response type (`replyToTreeQuery`, `replyToSinglePage`, `replyToSinglePageByPath`, `replyToCreatePage`, `replyToUpdatePage`, `replyToSearch`, `replyToTagsList`, `replyToHistory`). These take Wiki.js-typed fixtures and wrap them in the matching GraphQL `{ data: { pages: { ... } } }` envelope. Using the helpers pins test fixtures to the production response interfaces at compile time — a drift between an interface and a fixture becomes a TypeScript error.
  - Mirrors Wiki.js's `new-jwt` emission semantics from `server/core/auth.js:144-167`: header is sent only on 2xx responses, only when the request had `Content-Type: application/json`, and only when the test opts in via `{ newJwt: '...' }` on the helper or script.
- **Test runner:** Vitest.
- **Coverage layout:**
  - `test/config.test.ts` — URL canonicalization, atomic file writes, XDG/$HOME fallback.
  - `test/token-store.test.ts` — JWT lifecycle, debounced writes, file watcher, shutdown.
  - `test/wiki/client.test.ts` — HTTP/network/GraphQL classification, JWT redaction in error text, retry policy (exactly once on `NetworkError`, never on `HttpError`/`AuthExpiredError`/`GraphQLError`), `new-jwt` capture including the corner case of a refresh arriving with a non-2xx response.
  - `test/wiki/queries.test.ts` — pins the `pages.create` and `pages.update` `page { ... }` sub-selections to NOT include `locale` or `editor` (Wiki.js's mutation resolvers can't resolve those — see MF1 in repo history).
  - `test/bootstrap.test.ts` — full subcommand coverage including the real Wiki.js auth-rejection shape (HTTP 200 + AuthRequired GraphQL error).
  - `test/server.test.ts` — `runServer`'s argv/config paths and `installShutdownHandlers` routing (SIGINT/SIGTERM/beforeExit/double-signal force-exit).
  - `test/index.test.ts` — argv dispatch, `--help` to stdout vs stderr, `--version`.
  - `test/tools/*.test.ts` — per-tool happy/Zod/AuthExpired/GraphQL paths via `dispatchTool` directly.
  - `test/tools/e2e.test.ts` — one happy-path round trip per tool through real `Server` + `Client` over `InMemoryTransport.createLinkedPair()`, plus the JWT refresh integration scenarios (mid-tool-call refresh + sequential calls using the refreshed token).
  - `test/tools/dispatcher.test.ts` — registry surface, JSON Schema `type: object` invariant, regression pin that no tool emits top-level `oneOf`/`anyOf`/`allOf` (Anthropic Messages API rejects these in `input_schema`), multi-issue ZodError formatting.
- **No live-server tests in CI for v1.** Docker-based integration tests against real Wiki.js are a future track once we have a permanent instance.

## Project layout

```text
repos/wikijs-mcp/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── README.md           # user-facing docs: install, bookmarklet, tool reference
├── SPEC.md             # this file — design source of truth
├── src/
│   ├── index.ts        # main bin entry; argv dispatch (server vs bootstrap)
│   ├── server.ts       # MCP stdio server wiring + shutdown handlers
│   ├── bootstrap.ts    # `bootstrap` subcommand (probe + config write)
│   ├── config.ts       # config-file read/write, atomic-rename, URL canonicalization
│   ├── wiki/
│   │   ├── client.ts   # GraphQL client, new-jwt refresh, error types
│   │   └── queries.ts  # GraphQL query/mutation strings + hand-typed response interfaces
│   ├── tools/          # one file per MCP tool (pages-tree.ts, …) + index.ts dispatcher + types.ts
│   └── util/           # errors, token-store, version, small helpers
└── test/
    ├── mock/           # in-process mock GraphQL server with typed replyTo* helpers
    ├── tools/          # per-tool tests + e2e + dispatcher
    ├── wiki/           # client.ts and queries.ts tests
    └── *.test.ts       # config, token-store, bootstrap, server, index
```

## Conventions

- Node ≥ 20 (we use `fs/promises`, `fs.watch`, top-level `fetch`, `closeAllConnections`). Pinned in `engines`.
- TypeScript strict mode on. No `any` in committed code; one localized `eslint-disable-next-line` in the dispatcher covers the unavoidable Zod erasure-output assignment (commented in place).
- Pure stdlib + `@modelcontextprotocol/sdk` + `zod` + `zod-to-json-schema`. No GraphQL client library — we hand-roll `fetch`, since we're just POSTing JSON to one endpoint.
- ESM, not CJS.
- No business logic in `index.ts` — it's pure argv routing.
- **Never log the JWT.** The GraphQL client redactor (`JWT_REDACT` regex matching `eyJ…`) runs over every error message before it lands in any thrown error.
- `stdout` is reserved for MCP stdio framing and the `--version` / `--help` one-shots. All bootstrap output and all error messages go to `stderr`.
- Single-line shebang `#!/usr/bin/env node` on the built `dist/index.js`; `chmod 0755` applied by the build script.

## Team protocol

This spec was built in six phases by a small multi-agent team (a `team-lead` planner, a `worker` implementer, and several reviewer roles — `code-reviewer`, `test-reviewer`, and from Phase 4 onward a `mock-conformance-reviewer`). Each phase followed brief → implement → review → rework if needed → approval. Reviewers were spawned fresh per pass to avoid context drift. Phase boundaries are visible in commit history (when commits land — Phase 6 is the final deliverable; commits await user approval).
