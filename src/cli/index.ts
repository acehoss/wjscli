import { canonicalizeBaseUrl } from '../config.js';
import { dispatchTool } from '../tools/index.js';
import { MissingConfigError, WikiMcpError } from '../util/errors.js';
import { TokenStore } from '../util/token-store.js';
import { WikiClient } from '../wiki/client.js';
import { CliUsageError, readArgv } from './argv.js';
import { CLI_COMMANDS, matchCommand, type CliCommand } from './commands.js';

export type RunCliDeps = {
  fetchImpl?: typeof fetch;
};

// `args` are the tokens after `<base-url>` — i.e. the command path
// (e.g. `page get` or `pages tree`) followed by its flags and positionals.
// Top-level argv parsing (URL canonicalization, validate/mcp subcommand
// dispatch) is done in src/index.ts; runCli only sees CLI-mode invocations.
export async function runCli(
  rawBaseUrl: string,
  args: ReadonlyArray<string>,
  deps: RunCliDeps = {},
): Promise<number> {
  let baseUrl: string;
  try {
    baseUrl = canonicalizeBaseUrl(rawBaseUrl);
  } catch (err) {
    process.stderr.write(
      `wjscli: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  if (args.length === 0) {
    printCliUsage();
    return 2;
  }

  const matched = matchCommand(args);
  if (matched === null) {
    process.stderr.write(
      `wjscli: unknown command: ${args.join(' ') || '(none)'}\n`,
    );
    printCliUsage();
    return 2;
  }
  const { command, rest: afterCommand } = matched;

  // `-h` / `--help` at any position in the command's args prints that
  // command's detailed usage to stdout (user-requested → pipeable) and
  // returns 0. Doing this before readArgv keeps boolean-vs-value flag
  // disambiguation out of the picture for help.
  if (afterCommand.some((a) => a === '-h' || a === '--help')) {
    process.stdout.write(command.usage);
    return 0;
  }

  // --json is a global flag; consume it before per-command parsing.
  const argv = readArgv(afterCommand);
  const jsonValues = argv.flags.get('json');
  const jsonOutput = jsonValues !== undefined;
  if (jsonOutput) argv.flags.delete('json');

  let input: unknown;
  try {
    input = await command.parseArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`wjscli: ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  let store: TokenStore;
  try {
    store = await TokenStore.loadForBaseUrl(baseUrl);
  } catch (err) {
    if (err instanceof MissingConfigError) {
      process.stderr.write(
        `wjscli: ${err.message}\n` +
          `  No config found. Run: wjscli ${baseUrl} validate <jwt>\n`,
      );
      return 1;
    }
    process.stderr.write(
      `wjscli: failed to load config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const wikiClient = new WikiClient({
    tokenStore: store,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  let exitCode = 0;
  try {
    const result = await dispatchTool(command.toolName, input, wikiClient);
    const text = result.content[0]?.text ?? '';
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // The tool always emits JSON-stringified content; if parsing fails we
      // pass through the raw text so the user can still see it.
      payload = text;
    }
    if (result.isError === true) {
      // Tool-execution error (WikiMcpError-classified, non-auth). The text
      // payload carries { code, message }. Print to stderr for shell ergonomics.
      const body = payload as { code?: string; message?: string };
      process.stderr.write(
        `wjscli: tool error: ${body.message ?? text}\n` +
          `  code: ${body.code ?? 'unknown'}\n`,
      );
      exitCode = 1;
    } else if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      const human = command.formatHuman(payload);
      process.stdout.write(`${human}\n`);
    }
  } catch (err) {
    // AuthExpiredError, ZodError → InvalidParams, MethodNotFound, or truly
    // unexpected errors all land here. WikiMcpError messages have been
    // through the JWT redactor.
    if (err instanceof WikiMcpError) {
      process.stderr.write(`wjscli: ${err.message}\n`);
    } else if (err instanceof Error) {
      // McpError subclasses (Zod failure, auth-expired McpError) end up here.
      process.stderr.write(`wjscli: ${err.message}\n`);
    } else {
      process.stderr.write(`wjscli: ${String(err)}\n`);
    }
    exitCode = 1;
  } finally {
    await store.close();
  }
  return exitCode;
}

function printCliUsage(): void {
  const lines = [
    'usage: wjscli <base-url> <command> [args...]',
    '',
    'Commands:',
  ];
  for (const cmd of CLI_COMMANDS) {
    lines.push(`  ${cmd.path.join(' ').padEnd(16)}  ${cmd.help}`);
  }
  lines.push('');
  lines.push('Add --json for raw MCP-equivalent JSON output.');
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

// Re-export for test convenience.
export { CLI_COMMANDS };
export type { CliCommand };
