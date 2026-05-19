import type { TokenStore } from '../util/token-store.js';
import {
  AuthExpiredError,
  GraphQLError,
  HttpError,
  NetworkError,
  type GraphQLErrorEntry,
} from '../util/errors.js';

const BODY_EXCERPT_BYTES = 512;

// Scanned against the GraphQL error `message` field only.
//
// The load-bearing case is `must be authenticated`: when a JWT is rejected by
// passport-jwt, Wiki.js sets req.user to guest (id=2) and returns HTTP 200.
// The `users.profile` resolver (and similar auth-gated resolvers) then throw
// `WIKI.Error.AuthRequired`, whose message is the literal string
// "You must be authenticated to access this resource." Source:
//   repos/wiki/server/helpers/error.js (AuthRequired definition)
//   repos/wiki/server/core/auth.js     (passport-jwt → guest fallback)
//   repos/wiki/server/graph/resolvers/user.js (id<1 || id===2 → throw)
//
// We also match `invalid token`/`jwt expired`/`jwt malformed`/`unauthor[iy]zed`
// for defense in depth — those don't occur in current Wiki.js v2 paths but
// would be unambiguous JWT-validity failures from any upstream proxy or
// alternate auth strategy.
//
// `forbidden` is intentionally OUT — Wiki.js has error classes named
// `PageUpdateForbidden` etc. whose user-facing message is "You are not
// authorized to ...", which is a PERMISSION error (a valid JWT for a user
// without rights), NOT a JWT-expiry condition. Those must surface as a
// normal GraphQLError. We also never scan `extensions.code` or
// `extensions.exception.name` for the same reason: those leak class names.
const AUTH_FAIL_PATTERN =
  /must be authenticated|invalid token|jwt expired|jwt malformed|unauthor[iy]zed/i;

// `eyJ` is the standard base64url prefix of every JWT header. Used to scrub
// JWT-shaped strings from any text we surface (body excerpts from misconfigured
// proxies, etc.) before logging. Belt-and-suspenders for "never log JWT".
const JWT_REDACT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

export type WikiClientOptions = {
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
};

type GraphQLResponseBody = {
  data?: unknown;
  errors?: ReadonlyArray<GraphQLErrorEntry>;
};

export class WikiClient {
  private readonly endpoint: string;
  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WikiClientOptions) {
    // baseUrl is sourced from the TokenStore, which already holds the
    // canonical form loaded from the config file — no duplicate parameter.
    this.endpoint = `${opts.tokenStore.getBaseUrl().replace(/\/+$/, '')}/graphql`;
    this.tokenStore = opts.tokenStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      return await this.executeOnce<T>(query, variables);
    } catch (err) {
      // Retry exactly once on any fetch rejection (classified as NetworkError).
      // HTTP, GraphQL, and auth errors never retry.
      if (err instanceof NetworkError) {
        return this.executeOnce<T>(query, variables);
      }
      throw err;
    }
  }

  private async executeOnce<T>(
    query: string,
    variables: Record<string, unknown> | undefined,
  ): Promise<T> {
    const body = JSON.stringify(
      variables === undefined ? { query } : { query, variables },
    );
    const token = this.tokenStore.getToken();

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body,
      });
    } catch (err) {
      throw toNetworkError(err);
    }

    const fresh = response.headers.get('new-jwt');
    if (fresh !== null && fresh.length > 0) {
      this.tokenStore.update(fresh);
    }

    const text = await response.text();

    if (response.status === 401) {
      throw new AuthExpiredError(
        this.tokenStore.getBaseUrl(),
        `HTTP 401: ${redactAndExcerpt(text)}`,
      );
    }

    if (!response.ok) {
      throw new HttpError(response.status, redactAndExcerpt(text));
    }

    let parsed: GraphQLResponseBody;
    try {
      parsed = JSON.parse(text) as GraphQLResponseBody;
    } catch (err) {
      throw new HttpError(
        response.status,
        `non-JSON response: ${redactAndExcerpt(text)} (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const rawErrors: unknown = parsed.errors;
    if (Array.isArray(rawErrors) && rawErrors.length > 0) {
      const rawEntries: ReadonlyArray<GraphQLErrorEntry> = rawErrors as ReadonlyArray<GraphQLErrorEntry>;
      // Run every message through the JWT redactor before surfacing — a
      // misconfigured proxy or a `query` echoing-back error could include the
      // JWT in its message text. Same belt-and-suspenders as redactAndExcerpt
      // on body excerpts.
      const errors: GraphQLErrorEntry[] = rawEntries.map((e) => ({
        ...e,
        message: redact(e.message),
      }));
      const authy = errors.find((e) => AUTH_FAIL_PATTERN.test(e.message));
      if (authy !== undefined) {
        throw new AuthExpiredError(this.tokenStore.getBaseUrl(), authy.message);
      }
      throw new GraphQLError(errors);
    }

    return parsed.data as T;
  }
}

function toNetworkError(err: unknown): NetworkError {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown network failure';
  // Consistent with HTTP and GraphQL paths: never surface raw text without
  // the JWT redactor. fetch doesn't echo request bodies today, but the cost
  // of this defense is one regex pass.
  return new NetworkError(`network error reaching /graphql: ${redact(raw)}`, {
    cause: err,
  });
}

function redact(text: string): string {
  return text.replace(JWT_REDACT, '<jwt-redacted>');
}

function redactAndExcerpt(text: string): string {
  const redacted = redact(text);
  if (redacted.length <= BODY_EXCERPT_BYTES) return redacted;
  return `${redacted.slice(0, BODY_EXCERPT_BYTES)}…`;
}
