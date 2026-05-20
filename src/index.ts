#!/usr/bin/env node
import { runCli } from './cli/index.js';
import { runServer } from './server.js';
import { runValidate } from './validate.js';
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

  if (first === 'validate') {
    return runValidate(rest);
  }

  if (first === 'mcp') {
    return runServer(rest);
  }

  // Anything starting with `-` is an unknown option.
  if (first !== undefined && first.startsWith('-')) {
    process.stderr.write(`wjscli: unknown option: ${first}\n`);
    printUsageToStderr();
    return 2;
  }
  // A bare URL falls through to CLI mode: `wjscli <base-url> <group> [<verb>] [options...]`.
  // Bad URLs and bad subcommands are rejected inside runCli with exit 2.
  return runCli(args);
}

function usageText(): string {
  return [
    'wjscli — Wiki.js v2 CLI and MCP server (auth as a real human user)',
    '',
    'Usage:',
    '  wjscli validate [-t] <base-url> <jwt>     Validate JWT, write config',
    '                                            -t: stay running, keep token refreshed',
    '  wjscli mcp <base-url>                     Start MCP stdio server',
    '  wjscli <base-url> page get   --id N | --path P [--locale L]',
    '  wjscli <base-url> page create --path P --title T --content C [...]',
    '  wjscli <base-url> page update --id N [fields...]',
    '  wjscli <base-url> page history --id N [--offset-page N --offset-size N]',
    '  wjscli <base-url> pages tree [--parent N --mode ALL|PAGES|FOLDERS --locale L]',
    '  wjscli <base-url> search <query> [--locale L]',
    '  wjscli <base-url> tags list',
    '  wjscli --version                          Print version',
    '  wjscli --help                             Print this help',
    '',
    'Add --json to any CLI subcommand for raw JSON output.',
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
  process.argv[1]?.endsWith('/wjscli') === true;

if (invokedAsBin) {
  main(process.argv).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(
        `wjscli: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
