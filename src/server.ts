import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { canonicalizeBaseUrl } from './config.js';
import { registerTools } from './tools/index.js';
import { MissingConfigError } from './util/errors.js';
import { TokenStore } from './util/token-store.js';
import { WikiClient } from './wiki/client.js';
import { getVersion } from './util/version.js';

export type RunServerDeps = {
  // Hook for tests: skips signal handlers, the StdioServerTransport, and the
  // await-forever loop — runs the full config-load + buildServer path then
  // returns 0. Tests asserting protocol surface should call buildServer
  // directly via InMemoryTransport instead.
  smokeOnly?: boolean;
};

export async function runServer(
  args: string[],
  deps: RunServerDeps = {},
): Promise<number> {
  if (args.length !== 1) {
    process.stderr.write('usage: wikijs-mcp <base-url>\n');
    return 2;
  }

  let baseUrl: string;
  try {
    baseUrl = canonicalizeBaseUrl(args[0] ?? '');
  } catch (err) {
    process.stderr.write(
      `wikijs-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  let store: TokenStore;
  try {
    store = await TokenStore.loadForBaseUrl(baseUrl);
  } catch (err) {
    if (err instanceof MissingConfigError) {
      process.stderr.write(
        `wikijs-mcp: ${err.message}\n` +
          `  No config found. Run: wikijs-mcp bootstrap ${baseUrl} <jwt>\n`,
      );
      return 1;
    }
    process.stderr.write(
      `wikijs-mcp: failed to load config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const client = new WikiClient({ tokenStore: store });
  const { server } = buildServer({ client });

  if (deps.smokeOnly === true) {
    // Test-only path. Don't register signal handlers (they'd leak across
    // tests) and clean up the store we loaded for the smoke-load check.
    await store.close();
    return 0;
  }

  installShutdownHandlers({ store });

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    process.stderr.write(
      `wikijs-mcp: MCP transport failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await store.close();
    return 1;
  }

  // server.connect attaches the transport's onclose; the process stays alive
  // because stdio is open. We return a never-resolving promise so the caller
  // doesn't fall through to process.exit.
  await new Promise<void>(() => undefined);
  return 0; // unreachable
}

export type BuildServerArgs = {
  client: WikiClient;
};

export type BuiltServer = {
  server: Server;
  client: WikiClient;
};

// Exported for tests and for the tools dispatcher. registerTools wires the
// seven v1 tool handlers onto the Server (see src/tools/index.ts).
export function buildServer(args: BuildServerArgs): BuiltServer {
  const server = new Server(
    { name: 'wikijs-mcp', version: getVersion() },
    { capabilities: { tools: {} } },
  );
  registerTools(server, args.client);
  return { server, client: args.client };
}

// Subset of Node's process used by the shutdown machinery. Test seam.
export type ShutdownProcess = {
  on: (event: NodeJS.Signals | 'beforeExit', listener: () => void) => unknown;
  exit: (code: number) => never;
  stderr: { write: (chunk: string) => boolean };
};

export type InstallShutdownArgs = {
  store: Pick<TokenStore, 'close'>;
  proc?: ShutdownProcess;
};

export type ShutdownHandle = {
  // Exposed for tests to drive the routing without raising real signals.
  trigger: (signal: NodeJS.Signals | 'beforeExit') => void;
};

const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  beforeExit: 0,
};

// Wires SIGINT / SIGTERM / beforeExit handlers onto `proc` (defaults to the
// real `process`). The first signal triggers a graceful shutdown: await
// `store.close()`, then `proc.exit(code)`. A second occurrence of the same
// signal mid-shutdown force-exits immediately — this keeps Ctrl-C from
// becoming a dead key if close() hangs (e.g. slow fsync).
export function installShutdownHandlers(args: InstallShutdownArgs): ShutdownHandle {
  const proc: ShutdownProcess = args.proc ?? process;
  const store = args.store;
  let shuttingDown = false;

  const trigger = (signal: NodeJS.Signals | 'beforeExit'): void => {
    const exitCode = SIGNAL_EXIT_CODES[signal] ?? 0;
    if (shuttingDown) {
      // Second occurrence: force-exit without waiting on close().
      // beforeExit is excluded because it can fire repeatedly during a slow
      // normal exit and we don't want it to short-circuit the graceful path.
      if (signal !== 'beforeExit') {
        proc.stderr.write(
          `wikijs-mcp: ${signal} received again, forcing exit\n`,
        );
        proc.exit(exitCode);
      }
      return;
    }
    shuttingDown = true;
    if (signal !== 'beforeExit') {
      proc.stderr.write(`wikijs-mcp: ${signal} received, shutting down…\n`);
    }
    void (async () => {
      try {
        await store.close();
      } catch (err) {
        proc.stderr.write(
          `wikijs-mcp: shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      } finally {
        if (signal !== 'beforeExit') {
          proc.exit(exitCode);
        }
      }
    })();
  };

  proc.on('SIGINT', () => trigger('SIGINT'));
  proc.on('SIGTERM', () => trigger('SIGTERM'));
  proc.on('beforeExit', () => trigger('beforeExit'));

  return { trigger };
}
