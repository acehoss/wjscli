#!/usr/bin/env node
import { runBootstrap } from './bootstrap.js';
import { runServer } from './server.js';
import { getVersion } from './util/version.js';

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0) {
    printUsageToStderr();
    return 2;
  }

  const [first, ...rest] = args;

  // --help is a user request, so its output goes to stdout (pipeable). The
  // no-args usage banner and unknown-option errors go to stderr (error path).
  if (first === '--help' || first === '-h') {
    process.stdout.write(usageText());
    return 0;
  }

  if (first === '--version' || first === '-v') {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }

  if (first === 'bootstrap') {
    return runBootstrap(rest);
  }

  // Anything starting with `-` is an unknown option.
  if (first !== undefined && first.startsWith('-')) {
    process.stderr.write(`wikijs-mcp: unknown option: ${first}\n`);
    printUsageToStderr();
    return 2;
  }
  // A bare URL falls through to server mode; bad URLs and stray words are
  // rejected there by canonicalizeBaseUrl with exit 2.
  return runServer(args);
}

function usageText(): string {
  return [
    'wikijs-mcp — MCP server for Wiki.js v2 (auth as a real human user)',
    '',
    'Usage:',
    '  wikijs-mcp <base-url>                       Start MCP stdio server',
    '  wikijs-mcp bootstrap <base-url> <jwt>       Validate JWT and write config',
    '  wikijs-mcp --version                        Print version',
    '  wikijs-mcp --help                           Print this help',
    '',
    'See SPEC.md for the full design.',
    '',
  ].join('\n');
}

function printUsageToStderr(): void {
  process.stderr.write(usageText());
}

// Skip auto-run when imported as a module (so tests can import `main` cleanly).
// In production we're always the entrypoint (`node dist/index.js`).
const invokedAsBin =
  import.meta.url === `file://${process.argv[1] ?? ''}` ||
  process.argv[1]?.endsWith('/dist/index.js') === true ||
  process.argv[1]?.endsWith('/wikijs-mcp') === true;

if (invokedAsBin) {
  main(process.argv).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(
        `wikijs-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
