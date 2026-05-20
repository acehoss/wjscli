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

// Default refresh-daemon poll interval. Wiki.js's default JWT lifetime is
// 30 minutes; the new-jwt header is only emitted during the renewal window
// (the back half of the lifetime). 5 minutes is well below 30 and below the
// renewal window, so we comfortably hit a refresh before expiry.
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type RunValidateDeps = {
  fetchImpl?: typeof fetch;
  // Test seam for the daemon path: overrides the poll interval and the
  // "wait forever" promise. When `runDaemon` is set, the daemon code path
  // runs through it instead of installing real signal handlers / setInterval.
  refreshIntervalMs?: number;
  runDaemon?: (baseUrl: string, fetchImpl?: typeof fetch) => Promise<number>;
};

export type ParsedValidateArgs = {
  daemon: boolean;
  baseUrl: string;
  jwt: string;
};

function usage(): void {
  process.stderr.write(
    'usage: wjscli validate [-t] <base-url> <jwt>\n' +
      '  -t / --token-refresh   stay running and keep the JWT refreshed\n' +
      '  copy <jwt> from the `jwt` cookie of an authenticated browser session:\n' +
      "  in DevTools console:  copy(document.cookie.split('; ').find(c=>c.startsWith('jwt=')).slice(4))\n",
  );
}

// Parse argv for the validate subcommand. Accepts `-t` / `--token-refresh`
// anywhere among the args (before, between, or after the two positionals).
function parseArgs(args: string[]): ParsedValidateArgs | null {
  let daemon = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === '-t' || a === '--token-refresh') {
      daemon = true;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) return null;
  const [baseUrl, jwt] = positional;
  return { daemon, baseUrl, jwt };
}

export async function runValidate(
  args: string[],
  deps: RunValidateDeps = {},
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null) {
    usage();
    return 2;
  }

  let baseUrl: string;
  try {
    baseUrl = canonicalizeBaseUrl(parsed.baseUrl);
  } catch (err) {
    process.stderr.write(
      `wjscli: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  if (!JWT_SHAPE.test(parsed.jwt)) {
    process.stderr.write(
      'wjscli: that does not look like a JWT (expected three dot-separated base64url segments).\n' +
        '  copy the value from the `jwt` cookie of an authenticated browser session.\n',
    );
    return 2;
  }

  process.stderr.write(`Connecting to ${baseUrl}…\n`);

  const probeStore = TokenStore.inMemory(baseUrl, parsed.jwt);
  const probeClient = new WikiClient({
    tokenStore: probeStore,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  let profile: ProbeResponse;
  try {
    profile = await probeClient.gql<ProbeResponse>(PROBE_QUERY);
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
      'wjscli: server returned an unexpected profile shape; refusing to write config.\n',
    );
    return 1;
  }
  const id = (p as { id: number }).id;
  const email = (p as { email: string }).email;
  const name = (p as { name: string }).name;

  process.stderr.write(`✓ Authenticated as ${name} <${email}> (id=${id})\n`);

  // probeStore.getToken() reflects any new-jwt refresh the server included on
  // the probe response. That's the value we want to persist.
  const cfg: ConfigFile = {
    baseUrl,
    jwt: probeStore.getToken(),
    refreshedAt: probeStore.getRefreshedAt(),
  };

  try {
    await writeConfig(cfg);
  } catch (err) {
    process.stderr.write(
      `wjscli: failed to write config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stderr.write(`✓ Config written to ${configPathForBaseUrl(baseUrl)}\n`);

  if (!parsed.daemon) {
    return 0;
  }

  const daemonRunner = deps.runDaemon ?? runRefreshDaemon;
  return daemonRunner(baseUrl, deps.fetchImpl);
}

function reportProbeError(err: unknown): number {
  if (err instanceof AuthExpiredError) {
    process.stderr.write(
      'wjscli: JWT rejected by server.\n' +
        '  copy a fresh value from the `jwt` cookie of an authenticated browser session and retry.\n' +
        `  detail: ${err.message}\n`,
    );
    return 1;
  }
  if (err instanceof NetworkError) {
    process.stderr.write(
      `wjscli: could not reach the wiki: ${err.message}\n`,
    );
    return 1;
  }
  if (err instanceof HttpError) {
    process.stderr.write(`wjscli: ${err.message}\n`);
    return 1;
  }
  if (err instanceof GraphQLError) {
    process.stderr.write(`wjscli: ${err.message}\n`);
    return 1;
  }
  process.stderr.write(
    `wjscli: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  return 1;
}

export type RunRefreshDaemonOpts = {
  intervalMs?: number;
};

// Long-running token-refresh daemon. Loads the persistent TokenStore (which
// starts the file watcher and persists every new-jwt refresh via debounced
// atomic write), then polls users.profile at `intervalMs` to elicit a
// new-jwt header from the server. Exits on SIGINT/SIGTERM or on
// AuthExpiredError (the JWT can't be refreshed in place — re-validate needed).
export async function runRefreshDaemon(
  baseUrl: string,
  fetchImpl?: typeof fetch,
  opts: RunRefreshDaemonOpts = {},
): Promise<number> {
  const intervalMs = opts.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  let store: TokenStore;
  try {
    store = await TokenStore.loadForBaseUrl(baseUrl);
  } catch (err) {
    process.stderr.write(
      `wjscli: failed to load config for daemon: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  const client = new WikiClient({
    tokenStore: store,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });

  process.stderr.write(
    `wjscli: token-refresh daemon running for ${baseUrl} (interval ${(intervalMs / 1000).toString()}s). Ctrl-C to stop.\n`,
  );

  let exitCode = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stopSignal = (signal: NodeJS.Signals): void => {
    process.stderr.write(`wjscli: ${signal} received, stopping daemon…\n`);
    resolveDone();
  };
  process.once('SIGINT', () => stopSignal('SIGINT'));
  process.once('SIGTERM', () => stopSignal('SIGTERM'));

  const tick = async (): Promise<void> => {
    try {
      await client.gql<ProbeResponse>(PROBE_QUERY);
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        process.stderr.write(
          `wjscli: ${err.message}\n` +
            '  daemon cannot self-recover; exiting.\n',
        );
        exitCode = 1;
        resolveDone();
        return;
      }
      // Network / HTTP / GraphQL errors: log and keep going. The wiki may
      // be temporarily unreachable; we'll try again next tick.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`wjscli: refresh probe failed (will retry): ${msg}\n`);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  try {
    await done;
  } finally {
    clearInterval(timer);
    await store.close();
  }
  return exitCode;
}
