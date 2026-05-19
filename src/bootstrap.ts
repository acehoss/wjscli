import {
  canonicalizeBaseUrl,
  configPathForBaseUrl,
  writeConfig,
  type ConfigFile,
} from './config.js';
import {
  AuthExpiredError,
  GraphQLError,
  HttpError,
  NetworkError,
} from './util/errors.js';
import { TokenStore } from './util/token-store.js';
import { WikiClient } from './wiki/client.js';
import { PROBE_QUERY, type ProbeResponse } from './wiki/queries.js';

// A JWT is three dot-separated base64url segments. We only enforce shape here
// — the server is the source of truth for validity.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type RunBootstrapDeps = {
  fetchImpl?: typeof fetch;
};

export async function runBootstrap(
  args: string[],
  deps: RunBootstrapDeps = {},
): Promise<number> {
  if (args.length !== 2) {
    process.stderr.write(
      'usage: wikijs-mcp bootstrap <base-url> <jwt>\n' +
        '  copy <jwt> from the `jwt` cookie of an authenticated browser session:\n' +
        "  in DevTools console:  copy(document.cookie.split('; ').find(c=>c.startsWith('jwt=')).slice(4))\n",
    );
    return 2;
  }

  const [rawBaseUrl, jwt] = args as [string, string];

  let baseUrl: string;
  try {
    baseUrl = canonicalizeBaseUrl(rawBaseUrl);
  } catch (err) {
    process.stderr.write(
      `wikijs-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  if (!JWT_SHAPE.test(jwt)) {
    process.stderr.write(
      'wikijs-mcp: that does not look like a JWT (expected three dot-separated base64url segments).\n' +
        '  copy the value from the `jwt` cookie of an authenticated browser session.\n',
    );
    return 2;
  }

  process.stderr.write(`Connecting to ${baseUrl}…\n`);

  const store = TokenStore.inMemory(baseUrl, jwt);
  const client = new WikiClient({
    tokenStore: store,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  let profile: ProbeResponse;
  try {
    profile = await client.gql<ProbeResponse>(PROBE_QUERY);
  } catch (err) {
    return reportProbeError(err);
  }

  // Defensively read profile fields — Wiki.js could (in principle) return
  // null at any layer. Treat any access failure or shape mismatch as
  // "unexpected response" and refuse to write a config.
  const p = (profile as { users?: { profile?: unknown } } | null)?.users?.profile;
  if (
    p === undefined ||
    p === null ||
    typeof p !== 'object' ||
    typeof (p as { id?: unknown }).id !== 'number' ||
    typeof (p as { email?: unknown }).email !== 'string' ||
    typeof (p as { name?: unknown }).name !== 'string'
  ) {
    process.stderr.write(
      'wikijs-mcp: server returned an unexpected profile shape; refusing to write config.\n',
    );
    return 1;
  }
  const id = (p as { id: number }).id;
  const email = (p as { email: string }).email;
  const name = (p as { name: string }).name;

  process.stderr.write(`✓ Authenticated as ${name} <${email}> (id=${id})\n`);

  // store.getToken() reflects any new-jwt refresh the server included on
  // the probe response. That's the value we want to persist.
  const cfg: ConfigFile = {
    baseUrl,
    jwt: store.getToken(),
    refreshedAt: store.getRefreshedAt(),
  };

  try {
    await writeConfig(cfg);
  } catch (err) {
    process.stderr.write(
      `wikijs-mcp: failed to write config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stderr.write(`✓ Config written to ${configPathForBaseUrl(baseUrl)}\n`);
  return 0;
}

function reportProbeError(err: unknown): number {
  if (err instanceof AuthExpiredError) {
    process.stderr.write(
      'wikijs-mcp: JWT rejected by server.\n' +
        '  copy a fresh value from the `jwt` cookie of an authenticated browser session and retry.\n' +
        `  detail: ${err.message}\n`,
    );
    return 1;
  }
  if (err instanceof NetworkError) {
    process.stderr.write(
      `wikijs-mcp: could not reach the wiki: ${err.message}\n`,
    );
    return 1;
  }
  if (err instanceof HttpError) {
    process.stderr.write(`wikijs-mcp: ${err.message}\n`);
    return 1;
  }
  if (err instanceof GraphQLError) {
    process.stderr.write(`wikijs-mcp: ${err.message}\n`);
    return 1;
  }
  process.stderr.write(
    `wikijs-mcp: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  return 1;
}
