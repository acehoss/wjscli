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
  MissingConfigError,
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
  // Optional: when absent, validate uses the cached JWT from disk
  // (TokenStore.loadForBaseUrl). When supplied, it probes with the new
  // JWT and overwrites the config — the first-run flow.
  jwt?: string;
};

const HELP_TEXT = [
  'wjscli <base-url> validate [<jwt>] [-t]',
  '',
  '  Validate the cached JWT (or a freshly-supplied one) against the Wiki.js',
  '  instance at <base-url> and persist any new-jwt refresh the server sends',
  '  back. Without <jwt>, the cached token under .config/wjscli/<host>.json',
  '  is used; this is the no-friction "tickle the wiki to keep my token',
  '  alive" path. With <jwt>, the supplied token replaces whatever was on',
  "  disk — that's the first-run / re-auth flow.",
  '',
  'Arguments:',
  '  <base-url>            Wiki.js base URL (e.g. https://wiki.example.com)',
  '  <jwt>                 Optional. JWT copied from the `jwt` cookie of an',
  '                        authenticated browser session. In DevTools:',
  "                          copy(document.cookie.split('; ')",
  "                            .find(c=>c.startsWith('jwt=')).slice(4))",
  '',
  'Options:',
  '  -t, --token-refresh   Stay running after the probe; poll users.profile',
  '                        every 5 minutes to keep the stored JWT refreshed',
  '                        across idle stretches. Exits on SIGINT/SIGTERM.',
  '  -h, --help            Show this help',
  '',
  'Examples:',
  '  wjscli https://wiki.example.com validate                  # use cached JWT',
  '  wjscli https://wiki.example.com validate -t               # cached + daemon',
  '  wjscli https://wiki.example.com validate eyJ...sig        # first-run / re-auth',
  '  wjscli https://wiki.example.com validate eyJ...sig -t     # re-auth + daemon',
  '',
].join('\n');

function usage(): void {
  process.stderr.write(HELP_TEXT);
}

// Parse argv for the validate subcommand (URL has already been consumed
// upstream in src/index.ts). Accepts `-t` / `--token-refresh` anywhere among
// the args, before or after the JWT. The JWT positional is optional —
// omit it to validate / refresh the JWT cached on disk.
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
  if (positional.length > 1) return null;
  return { daemon, jwt: positional[0] };
}

export async function runValidate(
  baseUrl: string,
  args: string[],
  deps: RunValidateDeps = {},
): Promise<number> {
  // -h / --help anywhere in args is a user request → stdout, exit 0.
  if (args.some((a) => a === '-h' || a === '--help')) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  const parsed = parseArgs(args);
  if (parsed === null) {
    usage();
    return 2;
  }

  // baseUrl was already canonicalized by the caller; defensively re-canonicalize
  // to keep this entry point self-contained and tolerant of direct test calls.
  let canonicalBaseUrl: string;
  try {
    canonicalBaseUrl = canonicalizeBaseUrl(baseUrl);
  } catch (err) {
    process.stderr.write(
      `wjscli: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // Two branches: supplied JWT (first-run / re-auth) vs cached JWT
  // (no-arg validate, used to give the token a chance to refresh).
  const exitCode =
    parsed.jwt !== undefined
      ? await validateWithSuppliedJwt(canonicalBaseUrl, parsed.jwt, deps)
      : await validateFromCache(canonicalBaseUrl, deps);
  if (exitCode !== 0) return exitCode;

  if (!parsed.daemon) {
    return 0;
  }

  const daemonRunner = deps.runDaemon ?? runRefreshDaemon;
  return daemonRunner(canonicalBaseUrl, deps.fetchImpl);
}

// First-run / re-auth path: probe with the supplied JWT through an in-memory
// store, then write a fresh config file. Captures any new-jwt refresh the
// server sent on the probe response.
async function validateWithSuppliedJwt(
  canonicalBaseUrl: string,
  jwt: string,
  deps: RunValidateDeps,
): Promise<number> {
  if (!JWT_SHAPE.test(jwt)) {
    process.stderr.write(
      'wjscli: that does not look like a JWT (expected three dot-separated base64url segments).\n' +
        '  copy the value from the `jwt` cookie of an authenticated browser session.\n',
    );
    return 2;
  }

  process.stderr.write(`Connecting to ${canonicalBaseUrl}…\n`);

  const probeStore = TokenStore.inMemory(canonicalBaseUrl, jwt);
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

  const id = readProbeProfile(profile);
  if (id === null) return 1;

  const cfg: ConfigFile = {
    baseUrl: canonicalBaseUrl,
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

  process.stderr.write(
    `✓ Config written to ${configPathForBaseUrl(canonicalBaseUrl)}\n`,
  );
  return 0;
}

// No-JWT path: load the persistent TokenStore from disk and probe through it.
// Any new-jwt header lands in the store via WikiClient → store.update(...),
// which schedules a debounced atomic disk write; close() flushes it before
// we return. If no config exists, hint the user to supply a JWT.
async function validateFromCache(
  canonicalBaseUrl: string,
  deps: RunValidateDeps,
): Promise<number> {
  let store: TokenStore;
  try {
    store = await TokenStore.loadForBaseUrl(canonicalBaseUrl);
  } catch (err) {
    if (err instanceof MissingConfigError) {
      process.stderr.write(
        `wjscli: ${err.message}\n` +
          '  Supply a JWT positionally for the first-run flow:\n' +
          `    wjscli ${canonicalBaseUrl} validate <jwt>\n`,
      );
      return 1;
    }
    process.stderr.write(
      `wjscli: failed to load cached JWT: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  process.stderr.write(`Validating cached token against ${canonicalBaseUrl}…\n`);

  const client = new WikiClient({
    tokenStore: store,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const tokenBefore = store.getToken();

  let profile: ProbeResponse;
  try {
    profile = await client.gql<ProbeResponse>(PROBE_QUERY);
  } catch (err) {
    await store.close();
    return reportProbeError(err);
  }

  const id = readProbeProfile(profile);
  if (id === null) {
    await store.close();
    return 1;
  }

  // Capture whether a new-jwt was received during the probe. The store has
  // already persisted it via its debounced write; we just want to surface
  // the fact in the user-visible output.
  const tokenAfter = store.getToken();
  const refreshed = tokenAfter !== tokenBefore;

  // Flush + close before returning. If daemon mode is also requested, the
  // daemon will load its own fresh store — slightly wasteful but keeps the
  // lifetimes simple (the daemon's signal handlers etc. own a single store).
  await store.close();

  if (refreshed) {
    process.stderr.write('✓ Cached token refreshed (new-jwt received).\n');
  } else {
    process.stderr.write('✓ Cached token still valid (no refresh needed).\n');
  }
  return 0;
}

// Parse + validate the users.profile response. Returns the user id on
// success; logs and returns null on shape mismatch. Shared by both the
// supplied-JWT and cached-JWT branches.
function readProbeProfile(profile: ProbeResponse): number | null {
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
      'wjscli: server returned an unexpected profile shape; refusing to proceed.\n',
    );
    return null;
  }
  const id = (p as { id: number }).id;
  const email = (p as { email: string }).email;
  const name = (p as { name: string }).name;
  process.stderr.write(`✓ Authenticated as ${name} <${email}> (id=${id.toString()})\n`);
  return id;
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
