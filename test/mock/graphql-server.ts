import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type {
  CreatedPageSummary,
  Page,
  PageHistoryEntry,
  PageSearchResult,
  PageTag,
  PageTreeItem,
  ResponseStatus,
} from '../../src/wiki/queries.js';

export type ResponseScript = {
  // HTTP status. Defaults to 200.
  status?: number;
  // Raw body for non-200 responses. Ignored when status is 200.
  body?: string;
  // GraphQL errors envelope (200 + JSON + errors[]).
  errors?: Array<{ message: string; path?: ReadonlyArray<string | number> }>;
  // GraphQL data envelope (200 + JSON + data).
  data?: unknown;
  // new-jwt header value. Defaults to null. Real Wiki.js emits new-jwt ONLY
  // when the token is in the renewal window AND the request had
  // Content-Type: application/json (see repos/wiki/server/core/auth.js:144-167).
  // Tests must opt in to refresh by setting this explicitly.
  newJwt?: string | null;
};

// Typed reply helpers — each wraps a Wiki.js-shaped payload in the matching
// GraphQL `{ data: { pages: { ... } } }` envelope and calls setNext under the
// hood. Using these instead of raw setNext({data: ...}) pins test fixtures to
// the production response interfaces at compile time: a drift between the
// interface and the fixture becomes a TypeScript error.
//
// Use raw setNext when you need to test error envelopes, non-page queries
// (e.g. the bootstrap users.profile probe), or deliberately-malformed shapes.
export type ReplyOpts = {
  // Pass to opt into the new-jwt refresh path. Mirrors real Wiki.js, which
  // only emits new-jwt during the JWT's renewal window (Phase 3 conformance).
  newJwt?: string;
};

export type RequestDispatcher = (
  req: MockRequest,
) => ResponseScript | null;

export type MockGraphQLServer = {
  url: string;
  lastRequest: () => MockRequest | null;
  requestCount: () => number;
  setNext: (script: ResponseScript) => void;
  // Per-request dispatcher. If set and it returns non-null for a given
  // request, the mock uses that ResponseScript instead of the one set by
  // setNext. Used by tests that need to respond differently to multiple
  // calls in a single test (e.g. recursive `wiki_pages_tree` fetches that
  // fan out parallel sub-queries with different `parent` variables).
  setDispatcher: (fn: RequestDispatcher | null) => void;
  close: () => Promise<void>;
  // Typed reply helpers (5d). See ReplyOpts.
  replyToTreeQuery: (tree: PageTreeItem[], opts?: ReplyOpts) => void;
  replyToSinglePage: (page: Page | null, opts?: ReplyOpts) => void;
  replyToSinglePageByPath: (page: Page | null, opts?: ReplyOpts) => void;
  replyToCreatePage: (
    response: { responseResult: ResponseStatus; page: CreatedPageSummary | null },
    opts?: ReplyOpts,
  ) => void;
  replyToUpdatePage: (
    response: { responseResult: ResponseStatus; page: CreatedPageSummary | null },
    opts?: ReplyOpts,
  ) => void;
  replyToSearch: (
    search: { results: PageSearchResult[]; suggestions: string[]; totalHits: number },
    opts?: ReplyOpts,
  ) => void;
  replyToTagsList: (tags: PageTag[], opts?: ReplyOpts) => void;
  replyToHistory: (
    history: { trail: PageHistoryEntry[] | null; total: number },
    opts?: ReplyOpts,
  ) => void;
};

export type MockRequest = {
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
  parsed: { query?: unknown; variables?: unknown } | null;
};

// Default response: a successful users.profile query, NO new-jwt refresh.
// This matches real Wiki.js behavior — most authed responses don't refresh
// (refresh only fires when the JWT is in its renewal window). Tests that
// want to exercise the refresh path must set `newJwt` explicitly via setNext.
const DEFAULT_SCRIPT: ResponseScript = {
  data: {
    users: {
      profile: { id: 7, email: 'aaron@example.com', name: 'Aaron Heise' },
    },
  },
  newJwt: null,
};

export async function startMockGraphQLServer(
  initial: ResponseScript = {},
): Promise<MockGraphQLServer> {
  let script: ResponseScript = mergeScript(DEFAULT_SCRIPT, initial);
  let dispatcher: RequestDispatcher | null = null;
  let last: MockRequest | null = null;
  let count = 0;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed: { query?: unknown; variables?: unknown } | null = null;
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        parsed = null;
      }
      last = {
        method: req.method ?? '',
        authorization: req.headers.authorization ?? null,
        contentType: req.headers['content-type'] ?? null,
        body,
        parsed,
      };

      if (req.url !== '/graphql' || req.method !== 'POST') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      count += 1;

      // If a dispatcher is installed and produces a script for this
      // request, prefer it over the static `script`. This lets a single
      // test answer multiple queries with different payloads.
      const effective: ResponseScript = (() => {
        if (dispatcher === null) return script;
        const out = dispatcher(last as MockRequest);
        return out === null ? script : mergeScript(DEFAULT_SCRIPT, out);
      })();

      const status = effective.status ?? 200;

      // Mirror Wiki.js: new-jwt only on 2xx responses, only when the client
      // sent Content-Type EXACTLY "application/json". The real server uses
      // strict equality (server/core/auth.js:155), so any future drift toward
      // "application/json; charset=utf-8" would silently lose refresh in
      // production — tightening here surfaces that early.
      const reqContentType = req.headers['content-type'] ?? '';
      const reqIsJson = reqContentType === 'application/json';
      const eligibleForRefresh = status >= 200 && status < 300 && reqIsJson;
      if (
        eligibleForRefresh &&
        effective.newJwt !== null &&
        effective.newJwt !== undefined
      ) {
        res.setHeader('new-jwt', effective.newJwt);
      }

      if (status < 200 || status >= 300) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'text/plain');
        res.end(effective.body ?? '');
        return;
      }

      const payload: Record<string, unknown> = {};
      if (effective.errors !== undefined) {
        payload.errors = effective.errors;
      } else {
        payload.data = effective.data ?? null;
      }
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port.toString()}`;

  const setNextRaw = (next: ResponseScript): void => {
    script = mergeScript(DEFAULT_SCRIPT, next);
  };

  // Tiny helper to fold ReplyOpts into a ResponseScript.
  const withOpts = (data: unknown, opts: ReplyOpts | undefined): ResponseScript => {
    const out: ResponseScript = { data };
    if (opts?.newJwt !== undefined) out.newJwt = opts.newJwt;
    return out;
  };

  return {
    url,
    lastRequest: () => last,
    requestCount: () => count,
    // setNext replaces the script for the NEXT request (and all subsequent
    // ones until called again). Each call starts from DEFAULT_SCRIPT and
    // merges the caller's fields on top — explicit `undefined` reverts a
    // field to its default; explicit `null` is preserved (so passing
    // `newJwt: null` keeps the no-refresh default rather than picking up
    // the prior script's value).
    setNext: setNextRaw,
    setDispatcher: (fn) => {
      dispatcher = fn;
    },
    replyToTreeQuery: (tree, opts) => {
      // The tool now defaults to depth=20 — replyToTreeQuery used to set a
      // static response which would loop on the same payload during a
      // recursive walk. Install a dispatcher instead: answer the tree-query
      // whose `parent` matches the topmost item's parent with the given
      // payload, and answer any other tree query (i.e. the recursive
      // children-of-X calls) with an empty tree. Non-tree queries fall
      // through (`return null`) so other helpers still work.
      const topParent =
        tree.length > 0 ? Number((tree[0] as { parent?: number }).parent ?? 0) : 0;
      dispatcher = (req) => {
        const vars = (req.parsed?.variables ?? {}) as { parent?: number };
        if (vars.parent === undefined) return null;
        if (vars.parent === topParent) {
          return withOpts({ pages: { tree } }, opts);
        }
        return { data: { pages: { tree: [] } } };
      };
    },
    replyToSinglePage: (page, opts) => {
      setNextRaw(withOpts({ pages: { single: page } }, opts));
    },
    replyToSinglePageByPath: (page, opts) => {
      setNextRaw(withOpts({ pages: { singleByPath: page } }, opts));
    },
    replyToCreatePage: (response, opts) => {
      setNextRaw(withOpts({ pages: { create: response } }, opts));
    },
    replyToUpdatePage: (response, opts) => {
      setNextRaw(withOpts({ pages: { update: response } }, opts));
    },
    replyToSearch: (search, opts) => {
      setNextRaw(withOpts({ pages: { search } }, opts));
    },
    replyToTagsList: (tags, opts) => {
      setNextRaw(withOpts({ pages: { tags } }, opts));
    },
    replyToHistory: (history, opts) => {
      setNextRaw(withOpts({ pages: { history } }, opts));
    },
    close: async () => {
      if (!server.listening) return;
      // closeAllConnections (Node 18+) terminates keep-alive sockets that
      // server.close() alone wouldn't drain — without this, parallel
      // bootstrap tests can race on teardown.
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

function mergeScript(base: ResponseScript, over: ResponseScript): ResponseScript {
  return { ...base, ...over };
}
