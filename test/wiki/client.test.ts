import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthExpiredError,
  GraphQLError,
  HttpError,
  NetworkError,
} from '../../src/util/errors.js';
import { TokenStore } from '../../src/util/token-store.js';
import { WikiClient } from '../../src/wiki/client.js';
import {
  startMockGraphQLServer,
  type MockGraphQLServer,
} from '../mock/graphql-server.js';

// Realistic JWT prefix so any redactor regression would be obvious.
const seedJwt =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0Iiwic2NvcGUiOiJ0In0.signaturesignaturesignature';

let mock: MockGraphQLServer;
let store: TokenStore;
let client: WikiClient;

beforeEach(async () => {
  mock = await startMockGraphQLServer();
  store = TokenStore.inMemory(mock.url, seedJwt);
  client = new WikiClient({ tokenStore: store });
});

afterEach(async () => {
  await mock.close();
});

describe('WikiClient — HTTP classification', () => {
  it('200 + valid JSON data → returns data', async () => {
    mock.replyToTagsList([]);
    const out = await client.gql<{ pages: { tags: unknown[] } }>('{ pages { tags { id } } }');
    expect(out.pages.tags).toEqual([]);
  });

  it('HTTP 401 → AuthExpiredError (not HttpError)', async () => {
    mock.setNext({ status: 401, body: 'Unauthorized' });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect((err as AuthExpiredError).message).toMatch(/rebootstrap|bootstrap/i);
  });

  it('HTTP 400 → HttpError carrying the status', async () => {
    mock.setNext({ status: 400, body: 'bad request' });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).message).toMatch(/HTTP 400/);
    expect((err as HttpError).message).toContain('bad request');
  });

  it('HTTP 500 → HttpError carrying the status', async () => {
    mock.setNext({ status: 500, body: 'boom' });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).bodyExcerpt).toContain('boom');
  });

  it('non-JSON 200 body → HttpError with status 200 and a parse note', async () => {
    // Current documented behavior: on a 2xx that doesn't parse as JSON, we
    // throw HttpError(200, "non-JSON response: ... (<JSON parse error>)").
    // The status carries the original 2xx, which may surprise — but it
    // accurately reports what we got. Pin so any change to this path is a
    // deliberate decision. (Mock's 2xx path always emits JSON, so we use a
    // fake fetch to inject the unparseable body directly.)
    const fakeFetch = vi.fn(() =>
      Promise.resolve(
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    ) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    const err = await client2.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(200);
    expect((err as HttpError).message).toMatch(/non-JSON response/);
  });
});

describe('WikiClient — GraphQL error classification', () => {
  it('GraphQL errors[] with "must be authenticated" → AuthExpiredError', async () => {
    // The real Wiki.js shape: passport-jwt rejects → guest fallback → resolver
    // throws AuthRequired with this literal message at HTTP 200.
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
  });

  it('generic GraphQL errors → GraphQLError', async () => {
    mock.setNext({ errors: [{ message: 'something broke' }] });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).errors[0]?.message).toBe('something broke');
  });

  it('permission "not authorized to..." messages do NOT classify as AuthExpired', async () => {
    // Wiki.js's PageUpdateForbidden et al. — valid JWT, missing permission.
    // Re-bootstrapping won't help; the user just lacks rights.
    mock.setNext({ errors: [{ message: 'You are not authorized to update this page.' }] });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err).not.toBeInstanceOf(AuthExpiredError);
  });
});

describe('WikiClient — JWT redaction in error text', () => {
  it('redacts JWT-shaped substrings from HttpError body excerpts', async () => {
    // A misconfigured proxy could echo our Authorization header into a 5xx
    // body. Make sure the redactor catches it before HttpError.message lands.
    const echoed = `proxy error: token was Bearer ${seedJwt}`;
    mock.setNext({ status: 502, body: echoed });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).not.toContain(seedJwt);
    expect((err as HttpError).message).toContain('<jwt-redacted>');
  });

  it('redacts JWT-shaped substrings from GraphQL error messages', async () => {
    mock.setNext({
      errors: [{ message: `query echoed back: ${seedJwt}` }],
    });
    const err = await client.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).message).not.toContain(seedJwt);
    expect((err as GraphQLError).errors[0]?.message).not.toContain(seedJwt);
    expect((err as GraphQLError).errors[0]?.message).toContain('<jwt-redacted>');
  });
});

describe('WikiClient — new-jwt capture', () => {
  it('updates TokenStore when new-jwt header arrives on a 2xx response', async () => {
    const fresh = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWZyZXNoZWQifQ.fresh-sig-fresh-sig';
    mock.replyToTagsList([], { newJwt: fresh });
    await client.gql('{ pages { tags { id } } }');
    expect(store.getToken()).toBe(fresh);
  });

  it('does NOT update when new-jwt header is absent', async () => {
    mock.replyToTagsList([]);
    await client.gql('{ pages { tags { id } } }');
    expect(store.getToken()).toBe(seedJwt);
  });

  it('also captures new-jwt that arrives alongside a non-2xx response', async () => {
    // Defensive: the client reads `new-jwt` BEFORE checking response.ok, so a
    // 500 carrying a fresh JWT still refreshes our token even though the call
    // ultimately fails. This matches Wiki.js's middleware ordering (the auth
    // middleware sets new-jwt before any resolver runs). Pin so future
    // refactors don't accidentally move the header read after the status
    // gate. Note: real Wiki.js gates new-jwt on 2xx + JSON Content-Type, so
    // this is mostly a theoretical defense. The mock has the same gate, so
    // we have to bypass it by directly issuing a 500 via a custom server —
    // simulated here by using a fake fetch that yields the desired response.
    const freshJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWZyZXNoIn0.fresh-sig-from-500';
    const fakeFetch = vi.fn(() =>
      Promise.resolve(
        new Response('upstream barf', {
          status: 500,
          headers: {
            'Content-Type': 'text/plain',
            'new-jwt': freshJwt,
          },
        }),
      ),
    ) as unknown as typeof fetch;
    const store2 = TokenStore.inMemory(mock.url, seedJwt);
    const client2 = new WikiClient({ tokenStore: store2, fetchImpl: fakeFetch });
    const err = await client2.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(store2.getToken()).toBe(freshJwt);
  });

  it('ignores an empty new-jwt header', async () => {
    // TokenStore.update has an empty-string guard, but verify the client
    // still calls it with the empty value — i.e. relies on the store's
    // guard, doesn't have its own.
    const updateSpy = vi.spyOn(store, 'update');
    const fakeFetch = vi.fn(() =>
      Promise.resolve(
        new Response('{"data":null}', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'new-jwt': '' },
        }),
      ),
    ) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    await client2.gql('q');
    // The client checks fresh.length > 0 and skips update when empty.
    // So the spy should NOT have been called.
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });
});

describe('WikiClient — network errors and retry', () => {
  it('fetch rejection → NetworkError', async () => {
    const fakeFetch = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    const err = await client2.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toMatch(/network error/i);
  });

  it('retries exactly once on a transient network failure, then succeeds', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(
        new Response('{"data":{"ok":true}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    const out = await client2.gql<{ ok: boolean }>('q');
    expect(out.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('throws after the second consecutive network failure (no third try)', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(() => {
      calls += 1;
      return Promise.reject(new TypeError('fetch failed'));
    }) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    const err = await client2.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(calls).toBe(2);
  });

  it('does NOT retry HttpError', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        new Response('boom', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    }) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    await client2.gql('q').catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('does NOT retry AuthExpiredError (HTTP 401)', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        new Response('Unauthorized', {
          status: 401,
          headers: { 'Content-Type': 'text/plain' },
        }),
      );
    }) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    await client2.gql('q').catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('does NOT retry GraphQLError', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        new Response('{"errors":[{"message":"boom"}]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    await client2.gql('q').catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('NetworkError message is redacted (no JWT echoes through)', async () => {
    // If the underlying fetch error message ever contained a JWT-shaped
    // substring (theoretical: misconfigured proxy lib echoing the bearer
    // header into the error), the toNetworkError redactor should scrub it.
    const fakeFetch = vi.fn(() =>
      Promise.reject(new TypeError(`fetch failed: proxy echoed ${seedJwt}`)),
    ) as unknown as typeof fetch;
    const client2 = new WikiClient({ tokenStore: store, fetchImpl: fakeFetch });
    const err = await client2.gql('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).not.toContain(seedJwt);
    expect((err as NetworkError).message).toContain('<jwt-redacted>');
  });
});

describe('WikiClient — request shape', () => {
  it('sends Authorization, Content-Type: application/json, and POST body with query/variables', async () => {
    mock.replyToTagsList([]);
    await client.gql('{ q }', { x: 1 });
    const req = mock.lastRequest();
    expect(req?.method).toBe('POST');
    expect(req?.authorization).toBe(`Bearer ${seedJwt}`);
    expect(req?.contentType).toBe('application/json');
    const body = req?.parsed;
    expect(body?.query).toBe('{ q }');
    expect(body?.variables).toEqual({ x: 1 });
  });

  it('omits the variables key when no variables passed', async () => {
    mock.replyToTagsList([]);
    await client.gql('{ q }');
    const body = mock.lastRequest()?.parsed as Record<string, unknown> | null;
    expect(body).not.toBeNull();
    expect('variables' in (body ?? {})).toBe(false);
  });
});
