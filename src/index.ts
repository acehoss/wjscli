#!/usr/bin/env node
import { runCli } from './cli/index.js';
import { canonicalizeBaseUrl } from './config.js';
import { runServer } from './server.js';
import { runValidate } from './validate.js';
import { getVersion } from './util/version.js';

// Top-level subcommand names that come after <base-url>. Used to give the
// caller a friendlier error if they put a subcommand before the URL.
const TOP_LEVEL_COMMANDS = ['validate', 'mcp'] as const;

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

  // Anything starting with `-` is an unknown option.
  if (first !== undefined && first.startsWith('-')) {
    process.stderr.write(`wjscli: unknown option: ${first}\n`);
    printUsageToStderr();
    return 2;
  }

  // Every other invocation is `<base-url> <command> [args...]`. Catch the
  // common ordering mistake (subcommand first) before passing the URL to
  // canonicalizeBaseUrl, which would otherwise complain with an unhelpful
  // "invalid base URL: validate" message.
  if (
    first !== undefined &&
    TOP_LEVEL_COMMANDS.includes(first as (typeof TOP_LEVEL_COMMANDS)[number])
  ) {
    process.stderr.write(
      `wjscli: \`${first}\` is a subcommand; the base URL must come first.\n` +
        `  try: wjscli <base-url> ${first} ...\n`,
    );
    return 2;
  }

  let baseUrl: string;
  try {
    baseUrl = canonicalizeBaseUrl(first ?? '');
  } catch (err) {
    process.stderr.write(
      `wjscli: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const [command, ...commandArgs] = rest;

  if (command === undefined) {
    process.stderr.write('wjscli: a subcommand is required after <base-url>.\n');
    printUsageToStderr();
    return 2;
  }

  if (command === 'validate') {
    return runValidate(baseUrl, commandArgs);
  }

  if (command === 'mcp') {
    return runServer(baseUrl, commandArgs);
  }

  // Anything else falls through to the CLI dispatcher (page/pages/search/tags).
  return runCli(baseUrl, [command, ...commandArgs]);
}

function usageText(): string {
  return [
    'wjscli — Wiki.js v2 CLI and MCP server (auth as a real human user)',
    '',
    'Usage:',
    '  wjscli <base-url> validate <jwt> [-t]      Validate JWT, write config',
    '                                             -t: stay running, keep token refreshed',
    '  wjscli <base-url> mcp                      Start MCP stdio server',
    '  wjscli <base-url> page get   --id N | --path P [--locale L]',
    '  wjscli <base-url> page create --path P --title T --content C [...]',
    '  wjscli <base-url> page update --id N [fields...]',
    '  wjscli <base-url> page history --id N [--offset-page N --offset-size N]',
    '  wjscli <base-url> pages tree [--parent N --mode ALL|PAGES|FOLDERS --locale L]',
    '  wjscli <base-url> search <query> [--locale L]',
    '  wjscli <base-url> tags list',
    '  wjscli --version                           Print version',
    '  wjscli --help                              Print this help',
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
