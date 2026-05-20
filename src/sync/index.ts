import { runClone } from './clone.js';
import { runPull } from './pull.js';
import { runPush } from './push.js';
import { runStatus } from './status.js';

// Top-level entry point for `wjscli sync …`. Dispatch is hand-rolled
// because the sync surface differs from the URL-first CLI: the URL is
// only on `clone`; the other verbs read it from `.wjscli/config.json`.
//
// Recognised invocations (each verb also accepts `-h` / `--help`):
//
//   wjscli sync clone  <base-url> <dir> [--locale L]
//   wjscli sync status [-C <dir>] [--remote]
//   wjscli sync pull   [-C <dir>] [--force]
//   wjscli sync push   [-C <dir>] [--force] [--dry-run]
export async function runSync(args: ReadonlyArray<string>): Promise<number> {
  if (args.length === 0) {
    process.stderr.write(syncUsageText());
    return 2;
  }
  if (args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(syncUsageText());
    return 0;
  }
  const [verb, ...rest] = args;
  switch (verb) {
    case 'clone':
      return handleClone(rest);
    case 'status':
      return handleStatus(rest);
    case 'pull':
      return handlePull(rest);
    case 'push':
      return handlePush(rest);
    default:
      process.stderr.write(
        `wjscli sync: unknown verb \`${verb ?? ''}\`. Try \`wjscli sync --help\`.\n`,
      );
      return 2;
  }
}

function syncUsageText(): string {
  return [
    'wjscli sync — clone a Wiki.js instance to local markdown files',
    '',
    'Usage:',
    '  wjscli sync clone <base-url> <dir> [--locale L]',
    '      Pull every page from <base-url> into <dir> as markdown files',
    '      with YAML frontmatter. <dir> must be empty or not yet exist.',
    '',
    '  wjscli sync status [-C <dir>] [--remote]',
    '      Show modified/deleted/untracked files relative to the last',
    '      sync. `--remote` also checks the server for changes (one query',
    '      per tracked page; can be slow on big wikis).',
    '',
    '  wjscli sync pull [-C <dir>] [--force]',
    '      Re-fetch all pages from the server. Skips locally-modified',
    '      files unless `--force` is given.',
    '',
    '  wjscli sync push [-C <dir>] [--force] [--dry-run]',
    '      Upload locally-modified pages. Refuses to overwrite a page',
    '      whose server-side updatedAt has drifted since last sync unless',
    '      `--force` is given. `--dry-run` lists what would be pushed.',
    '',
    '  wjscli sync -h | --help    Show this help',
    '',
    'Sync state lives in `<dir>/.wjscli/` (config.json + index.json).',
    'Per-page files are markdown with a YAML frontmatter block — see',
    'SPEC.md "Sync clone format".',
    '',
  ].join('\n');
}

// Minimal flag/positional reader, sized to sync's small argv surface.
// (We don't share src/cli/argv.ts because the CLI commands' boolean-vs-
// value heuristics aren't a great fit here — sync flags are all known
// in advance.)
type ParsedSyncArgs = {
  positionals: string[];
  flags: Map<string, string>;
  booleans: Set<string>;
};

function parseSyncArgs(args: ReadonlyArray<string>): ParsedSyncArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      for (let j = i + 1; j < args.length; j++) {
        positionals.push(args[j] ?? '');
      }
      break;
    }
    if (a === '-C') {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error('-C requires a directory argument');
      }
      flags.set('C', next);
      i++;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        booleans.add(a.slice(2));
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags, booleans };
}

function checkHelp(args: ReadonlyArray<string>, helpText: string): number | null {
  if (args.some((a) => a === '-h' || a === '--help')) {
    process.stdout.write(helpText);
    return 0;
  }
  return null;
}

async function handleClone(args: ReadonlyArray<string>): Promise<number> {
  const helpText = [
    'wjscli sync clone <base-url> <dir> [--locale L]',
    '',
    '  Clone every page from <base-url> into <dir> as markdown files with',
    '  YAML frontmatter. Creates <dir>/.wjscli/{config,index}.json to',
    '  track sync state. <dir> must be empty or not exist.',
    '',
    'Options:',
    '  --locale L       Locale to clone (default en)',
    '  -h, --help       Show this help',
    '',
    'Example:',
    '  wjscli sync clone https://wiki.example.com ./wiki',
    '',
  ].join('\n');
  const hc = checkHelp(args, helpText);
  if (hc !== null) return hc;

  let parsed: ParsedSyncArgs;
  try {
    parsed = parseSyncArgs(args);
  } catch (err) {
    process.stderr.write(
      `wjscli sync clone: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }
  if (parsed.positionals.length !== 2) {
    process.stderr.write(
      'usage: wjscli sync clone <base-url> <dir> [--locale L]\n',
    );
    return 2;
  }
  const [baseUrl, targetDir] = parsed.positionals;
  const locale = parsed.flags.get('locale');
  return runClone({
    baseUrl: baseUrl,
    targetDir: targetDir,
    ...(locale !== undefined ? { locale } : {}),
  });
}

async function handleStatus(args: ReadonlyArray<string>): Promise<number> {
  const helpText = [
    'wjscli sync status [-C <dir>] [--remote]',
    '',
    '  Show which tracked files are modified, deleted, or untracked since',
    '  the last sync. `--remote` also queries the server to flag pages',
    '  that have changed remotely (one query per tracked page).',
    '',
    'Options:',
    '  -C <dir>         Operate as if started in <dir> (default: cwd)',
    '  --remote         Also compare against current server state',
    '  -h, --help       Show this help',
    '',
  ].join('\n');
  const hc = checkHelp(args, helpText);
  if (hc !== null) return hc;
  const parsed = parseSyncArgs(args);
  if (parsed.positionals.length > 0) {
    process.stderr.write(
      `wjscli sync status: unexpected positional arg(s): ${parsed.positionals.join(' ')}\n`,
    );
    return 2;
  }
  const dir = parsed.flags.get('C') ?? '.';
  const withRemote = parsed.booleans.has('remote');
  return runStatus({ dir, withRemote });
}

async function handlePush(args: ReadonlyArray<string>): Promise<number> {
  const helpText = [
    'wjscli sync push [-C <dir>] [--force] [--dry-run]',
    '',
    '  Upload locally-modified pages to the server. Each push fetches the',
    '  current remote page first and refuses to overwrite if its',
    '  updatedAt has drifted since last sync (use --force to override).',
    '',
    'Options:',
    '  -C <dir>         Operate as if started in <dir> (default: cwd)',
    '  --force          Overwrite even if remote has changed',
    '  --dry-run        List what would be pushed, do not modify server',
    '  -h, --help       Show this help',
    '',
  ].join('\n');
  const hc = checkHelp(args, helpText);
  if (hc !== null) return hc;
  const parsed = parseSyncArgs(args);
  const dir = parsed.flags.get('C') ?? '.';
  return runPush({
    dir,
    force: parsed.booleans.has('force'),
    dryRun: parsed.booleans.has('dry-run'),
  });
}

async function handlePull(args: ReadonlyArray<string>): Promise<number> {
  const helpText = [
    'wjscli sync pull [-C <dir>] [--force]',
    '',
    '  Re-fetch every page from the server, updating local files and the',
    '  index. Locally-modified files are skipped unless --force is given.',
    '  Detects remote-side renames (file is moved to match the new path)',
    '  and reports pages removed from the server.',
    '',
    'Options:',
    '  -C <dir>         Operate as if started in <dir> (default: cwd)',
    '  --force          Overwrite locally-modified files',
    '  -h, --help       Show this help',
    '',
  ].join('\n');
  const hc = checkHelp(args, helpText);
  if (hc !== null) return hc;
  const parsed = parseSyncArgs(args);
  const dir = parsed.flags.get('C') ?? '.';
  return runPull({ dir, force: parsed.booleans.has('force') });
}
