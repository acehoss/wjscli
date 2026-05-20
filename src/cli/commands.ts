import {
  CliUsageError,
  rejectUnknownFlags,
  resolveStringValue,
  takeBoolean,
  takeOptionalInt,
  takeOptionalString,
  takeRequiredString,
  takeStringArray,
  type ParsedArgv,
} from './argv.js';

// A CLI command wraps an MCP tool. `path` is the user-facing command words
// (e.g. ['page', 'get']); the runner matches them positionally before the
// flag parser sees anything.
//
// `parseArgs` is per-command — each command builds its underlying tool input
// from a ParsedArgv, applying flag mapping and any value indirection (e.g.
// resolving @file / @- for content). It throws CliUsageError for any
// caller-side problem.
//
// `formatHuman` renders the tool's JSON output for terminal display. Output
// is a string that the runner writes to stdout, with --json bypassing it for
// raw MCP-equivalent payload.
export type CliCommand = {
  path: ReadonlyArray<string>;
  // toolName matches the MCP tool registry — TOOL_DEFS in src/tools/index.ts.
  toolName: string;
  // One-liner shown in the top-level command list.
  help: string;
  // Multi-line help block printed when the user invokes the command with
  // `-h` / `--help`. Goes to stdout (user-requested) and should already end
  // with a trailing newline.
  usage: string;
  // Sync or async — the dispatcher awaits the result either way. Commands
  // that need to resolve `@-` / `@file` content read paths return a Promise.
  parseArgs: (argv: ParsedArgv) => unknown;
  formatHuman: (data: unknown) => string;
};

// Shared utility: format a Wiki.js ResponseStatus + page summary block.
function formatResult(data: unknown): string {
  const d = data as {
    responseResult?: { succeeded?: boolean; message?: string; slug?: string; errorCode?: number };
    page?: Record<string, unknown> | null;
  };
  const r = d.responseResult ?? {};
  const succeeded = r.succeeded === true;
  const head = succeeded
    ? `✓ ${r.message || r.slug || 'OK'}`
    : `✗ ${r.message || r.slug || 'failed'} (code ${(r.errorCode ?? 0).toString()})`;
  const page = d.page;
  if (page === null || page === undefined) return head;
  const lines: string[] = [head];
  for (const k of ['id', 'path', 'title', 'isPublished', 'isPrivate', 'updatedAt']) {
    const v = page[k];
    if (v !== undefined) lines.push(`  ${k}: ${formatScalar(v)}`);
  }
  return lines.join('\n');
}

function formatScalar(v: unknown): string {
  if (v === null) return '<null>';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return JSON.stringify(v);
}

// ---------- page-create / page-update shared field parsing ----------

type PageWriteFields = {
  description?: string;
  editor?: string;
  locale?: string;
  tags?: string[];
  isPublished?: boolean;
  isPrivate?: boolean;
};

async function takePageWriteFields(
  flags: Map<string, string[]>,
): Promise<PageWriteFields> {
  const rawDescription = takeOptionalString(flags, 'description');
  const description =
    rawDescription !== undefined ? await resolveStringValue(rawDescription) : undefined;
  const editor = takeOptionalString(flags, 'editor');
  const locale = takeOptionalString(flags, 'locale');
  const tags = takeStringArray(flags, 'tag');
  const isPublished = takeBoolean(flags, 'published');
  const isPrivate = takeBoolean(flags, 'private');
  const out: PageWriteFields = {};
  if (description !== undefined) out.description = description;
  if (editor !== undefined) out.editor = editor;
  if (locale !== undefined) out.locale = locale;
  if (tags !== undefined) out.tags = tags;
  if (isPublished !== undefined) out.isPublished = isPublished;
  if (isPrivate !== undefined) out.isPrivate = isPrivate;
  return out;
}

// ---------- pages tree ----------

const pagesTreeCmd: CliCommand = {
  path: ['pages', 'tree'],
  toolName: 'wiki_pages_tree',
  help: 'List the page tree under a parent (recursive by default).',
  usage: [
    'wjscli <base-url> pages tree [options]',
    '',
    '  List the Wiki.js page tree under a parent node. By default the tool',
    '  recurses 20 levels deep (effectively unlimited for most wikis); each',
    '  level fans out one GraphQL query per node at the level above.',
    '  Human-readable output uses tree(1)-style box-drawing connectors.',
    '',
    'Options:',
    '  --parent N      Parent node ID (default 0 = the wiki root)',
    '  --mode MODE     ALL | PAGES | FOLDERS (default ALL)',
    '  --locale L      Locale code (default en)',
    '  --depth N       Levels to recurse, ≥ 1 (default 20)',
    '  --json          Output raw JSON instead of the tree view',
    '  -h, --help      Show this help',
    '',
    'Examples:',
    '  wjscli https://wiki.example.com pages tree',
    '  wjscli https://wiki.example.com pages tree --parent 5 --depth 2',
    '  wjscli https://wiki.example.com pages tree --mode FOLDERS --json',
    '',
  ].join('\n'),
  parseArgs: ({ flags, positionals }) => {
    if (positionals.length > 0) {
      throw new CliUsageError(
        `pages tree: unexpected positional arg(s): ${positionals.join(' ')}`,
      );
    }
    const parent = takeOptionalInt(flags, 'parent');
    const mode = takeOptionalString(flags, 'mode');
    const locale = takeOptionalString(flags, 'locale');
    const depth = takeOptionalInt(flags, 'depth');
    rejectUnknownFlags(flags);
    const input: Record<string, unknown> = {};
    if (parent !== undefined) input.parent = parent;
    if (mode !== undefined) {
      if (mode !== 'ALL' && mode !== 'PAGES' && mode !== 'FOLDERS') {
        throw new CliUsageError(
          `--mode must be ALL, PAGES, or FOLDERS (got ${mode})`,
        );
      }
      input.mode = mode;
    }
    if (locale !== undefined) input.locale = locale;
    if (depth !== undefined) {
      if (depth < 1) {
        throw new CliUsageError(`--depth must be ≥ 1 (got ${depth.toString()})`);
      }
      input.depth = depth;
    }
    return input;
  },
  formatHuman: formatPagesTree,
};

// Render the flat (DFS-ordered) tree from `wiki_pages_tree` as a classic
// `tree(1)`-style indented hierarchy using box-drawing characters. Works
// for any depth: items are grouped by their `parent`, then walked
// recursively from the root parent that all the shallowest items share.
// (Wiki.js's `depth` is absolute, so the smallest-depth entries are the
// top-level ones for this query.)
function formatPagesTree(data: unknown): string {
  const tree = (data as { tree?: Array<Record<string, unknown>> }).tree ?? [];
  if (tree.length === 0) return '(empty)';

  const childrenByParent = new Map<number, Array<Record<string, unknown>>>();
  for (const item of tree) {
    const pid = Number(item.parent ?? 0);
    const arr = childrenByParent.get(pid) ?? [];
    arr.push(item);
    childrenByParent.set(pid, arr);
  }

  const depths = tree.map((t) => Number(t.depth ?? 0));
  const minDepth = Math.min(...depths);
  const tops = tree.filter((t) => Number(t.depth ?? 0) === minDepth);
  // Items at the same min-depth all share the same parent (we only recurse
  // into entries beneath them). Reading the first top-level item gives us
  // that root parent without having to thread the original request input
  // through to the formatter.
  const rootParent = Number(tops[0]?.parent ?? 0);

  const lines: string[] = [];
  const walk = (parentId: number, prefix: string): void => {
    const kids = childrenByParent.get(parentId) ?? [];
    kids.forEach((kid, idx) => {
      const isLast = idx === kids.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const folderMark = kid.isFolder === true ? '/' : '';
      const id = formatScalar(kid.id);
      const title = formatScalar(kid.title);
      const path = formatScalar(kid.path);
      lines.push(`${prefix}${connector}[${id}] ${title}${folderMark}  (${path})`);
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      walk(Number(kid.id), nextPrefix);
    });
  };
  walk(rootParent, '');
  return lines.length > 0 ? lines.join('\n') : '(empty)';
}

// ---------- page get ----------

const pageGetCmd: CliCommand = {
  path: ['page', 'get'],
  toolName: 'wiki_page_get',
  help: 'Fetch a single page by --id or by --path.',
  usage: [
    'wjscli <base-url> page get { --id N | --path P } [options]',
    '',
    '  Fetch a single Wiki.js page by id or by path. Pass exactly one of',
    '  --id or --path. Some fields (content, editor, author/creator details)',
    "  require write:pages or manage:system permission server-side; if the",
    '  user lacks them, Wiki.js returns a GraphQL error.',
    '',
    'Options:',
    '  --id N          Page ID (mutually exclusive with --path)',
    '  --path P        Page path (mutually exclusive with --id)',
    '  --locale L      Locale code (used with --path; default en)',
    '  --json          Output raw JSON instead of human-readable view',
    '  -h, --help      Show this help',
    '',
    'Examples:',
    '  wjscli https://wiki.example.com page get --id 42',
    '  wjscli https://wiki.example.com page get --path team/onboarding',
    '',
  ].join('\n'),
  parseArgs: ({ flags, positionals }) => {
    if (positionals.length > 0) {
      throw new CliUsageError(
        `page get: unexpected positional arg(s): ${positionals.join(' ')}`,
      );
    }
    const id = takeOptionalInt(flags, 'id');
    const path = takeOptionalString(flags, 'path');
    const locale = takeOptionalString(flags, 'locale');
    rejectUnknownFlags(flags);
    if ((id === undefined) === (path === undefined)) {
      throw new CliUsageError('page get requires exactly one of --id or --path');
    }
    const input: Record<string, unknown> = {};
    if (id !== undefined) input.id = id;
    if (path !== undefined) input.path = path;
    if (locale !== undefined) input.locale = locale;
    return input;
  },
  formatHuman: (data) => {
    const page = (data as { page?: Record<string, unknown> | null }).page;
    if (page === null || page === undefined) return '<no page>';
    const lines: string[] = [];
    for (const k of [
      'id',
      'path',
      'title',
      'description',
      'editor',
      'locale',
      'isPublished',
      'isPrivate',
      'createdAt',
      'updatedAt',
      'authorName',
      'authorEmail',
    ]) {
      const v = page[k];
      if (v !== undefined) lines.push(`${k}: ${formatScalar(v)}`);
    }
    const tags = page.tags;
    if (Array.isArray(tags) && tags.length > 0) {
      const names = tags
        .map((t: unknown) => (t as { tag?: string }).tag ?? '')
        .filter((s) => s.length > 0);
      lines.push(`tags: ${names.join(', ')}`);
    }
    if (typeof page.content === 'string') {
      lines.push('');
      lines.push('--- content ---');
      lines.push(page.content);
    }
    return lines.join('\n');
  },
};

// ---------- page create ----------

const pageCreateCmd: CliCommand = {
  path: ['page', 'create'],
  toolName: 'wiki_page_create',
  help: 'Create a new page. Required: --path, --title, --content.',
  usage: [
    'wjscli <base-url> page create --path P --title T --content C [options]',
    '',
    '  Create a new Wiki.js page. The created page is attributed to the',
    '  user whose JWT was validated.',
    '',
    'Required:',
    '  --path P        Page path (e.g. "docs/setup")',
    '  --title T       Page title',
    '  --content C     Page body. Supports `@-` (read from stdin)',
    '                  and `@path` (read from file).',
    '',
    'Options:',
    '  --description D Page description. Supports @-/@path. (default "")',
    '  --editor E      Editor key (default "markdown")',
    '  --locale L      Locale code (default "en")',
    '  --tag T         Tag (repeatable; comma-splittable: --tag a,b)',
    '  --published / --no-published   (default published)',
    '  --private / --no-private       (default not private)',
    '  --json          Output raw JSON',
    '  -h, --help      Show this help',
    '',
    'Example:',
    '  wjscli https://wiki.example.com page create \\',
    '    --path docs/setup --title "Setup" --content @./setup.md \\',
    '    --tag docs --tag onboarding',
    '',
  ].join('\n'),
  parseArgs: async ({ flags, positionals }) => {
    if (positionals.length > 0) {
      throw new CliUsageError(
        `page create: unexpected positional arg(s): ${positionals.join(' ')}`,
      );
    }
    const path = takeRequiredString(flags, 'path');
    const title = takeRequiredString(flags, 'title');
    const content = await resolveStringValue(takeRequiredString(flags, 'content'));
    const writeFields = await takePageWriteFields(flags);
    rejectUnknownFlags(flags);
    return { path, title, content, ...writeFields };
  },
  formatHuman: formatResult,
};

// ---------- page update ----------

const pageUpdateCmd: CliCommand = {
  path: ['page', 'update'],
  toolName: 'wiki_page_update',
  help: 'Update a page. Requires --id plus at least one mutable field.',
  usage: [
    'wjscli <base-url> page update --id N [field...]',
    '',
    '  Update an existing Wiki.js page. Only supplied fields are changed;',
    '  unsupplied fields are preserved (the tool fetch-merge-updates under',
    '  the hood — one extra GraphQL round-trip per call).',
    '',
    'Required:',
    '  --id N          Page ID',
    '',
    'Mutable fields (supply any one or more):',
    '  --path P',
    '  --title T',
    '  --content C     Supports @-/@path',
    '  --description D Supports @-/@path',
    '  --editor E',
    '  --locale L',
    '  --tag T         Repeatable; comma-splittable',
    '  --published / --no-published',
    '  --private / --no-private',
    '',
    'Options:',
    '  --json          Output raw JSON',
    '  -h, --help      Show this help',
    '',
    'Example:',
    '  wjscli https://wiki.example.com page update --id 42 \\',
    '    --title "New title" --content @./new-body.md',
    '',
  ].join('\n'),
  parseArgs: async ({ flags, positionals }) => {
    if (positionals.length > 0) {
      throw new CliUsageError(
        `page update: unexpected positional arg(s): ${positionals.join(' ')}`,
      );
    }
    const id = takeOptionalInt(flags, 'id');
    if (id === undefined) {
      throw new CliUsageError('page update requires --id');
    }
    const path = takeOptionalString(flags, 'path');
    const title = takeOptionalString(flags, 'title');
    const rawContent = takeOptionalString(flags, 'content');
    const content =
      rawContent !== undefined ? await resolveStringValue(rawContent) : undefined;
    const writeFields = await takePageWriteFields(flags);
    rejectUnknownFlags(flags);
    const input: Record<string, unknown> = { id };
    if (path !== undefined) input.path = path;
    if (title !== undefined) input.title = title;
    if (content !== undefined) input.content = content;
    Object.assign(input, writeFields);
    if (Object.keys(input).length === 1) {
      throw new CliUsageError('page update requires at least one field besides --id');
    }
    return input;
  },
  formatHuman: formatResult,
};

// ---------- page history ----------

const pageHistoryCmd: CliCommand = {
  path: ['page', 'history'],
  toolName: 'wiki_page_history',
  help: 'Fetch revision history of a page.',
  usage: [
    'wjscli <base-url> page history --id N [options]',
    '',
    '  Fetch the revision history of a Wiki.js page. Requires manage:system',
    '  or read:history permission server-side.',
    '',
    'Required:',
    '  --id N            Page ID',
    '',
    'Options:',
    '  --offset-page N   Page offset for pagination (default 0)',
    '  --offset-size N   Page size for pagination (Wiki.js default 100)',
    '  --json            Output raw JSON',
    '  -h, --help        Show this help',
    '',
    'Example:',
    '  wjscli https://wiki.example.com page history --id 42',
    '',
  ].join('\n'),
  parseArgs: ({ flags, positionals }) => {
    if (positionals.length > 0) {
      throw new CliUsageError(
        `page history: unexpected positional arg(s): ${positionals.join(' ')}`,
      );
    }
    const id = takeOptionalInt(flags, 'id');
    if (id === undefined) {
      throw new CliUsageError('page history requires --id');
    }
    const offsetPage = takeOptionalInt(flags, 'offset-page');
    const offsetSize = takeOptionalInt(flags, 'offset-size');
    rejectUnknownFlags(flags);
    const input: Record<string, unknown> = { id };
    if (offsetPage !== undefined) input.offsetPage = offsetPage;
    if (offsetSize !== undefined) input.offsetSize = offsetSize;
    return input;
  },
  formatHuman: (data) => {
    const d = data as { trail?: Array<Record<string, unknown>> | null; total?: number };
    const trail = d.trail ?? [];
    if (trail.length === 0) return `total: ${(d.total ?? 0).toString()}\n(no entries)`;
    const lines: string[] = [`total: ${(d.total ?? 0).toString()}`];
    for (const e of trail) {
      const v = formatScalar(e.versionId);
      const date = formatScalar(e.versionDate);
      const author = formatScalar(e.authorName);
      const action = formatScalar(e.actionType);
      lines.push(`  v${v}  ${date}  ${author}  ${action}`);
    }
    return lines.join('\n');
  },
};

// ---------- search ----------

const searchCmd: CliCommand = {
  path: ['search'],
  toolName: 'wiki_search',
  help: 'Search pages. First positional after the URL is the query.',
  usage: [
    'wjscli <base-url> search <query> [options]',
    '',
    '  Search Wiki.js pages. Returns { results, suggestions, totalHits }',
    '  as Wiki.js does — results may be empty with totalHits=0 if no search',
    "  engine is configured on the server. Results are filtered by the",
    "  calling user's read:pages permission.",
    '',
    'Arguments:',
    '  <query>         Search query string (positional, after the command)',
    '',
    'Options:',
    '  --locale L      Restrict to a specific locale',
    '  --json          Output raw JSON',
    '  -h, --help      Show this help',
    '',
    'Example:',
    '  wjscli https://wiki.example.com search "onboarding"',
    '',
  ].join('\n'),
  parseArgs: ({ flags, positionals }) => {
    if (positionals.length === 0) {
      throw new CliUsageError('search requires a query positional argument');
    }
    if (positionals.length > 1) {
      throw new CliUsageError(
        `search: unexpected extra positional arg(s): ${positionals.slice(1).join(' ')}`,
      );
    }
    const query = positionals[0] ?? '';
    const locale = takeOptionalString(flags, 'locale');
    rejectUnknownFlags(flags);
    const input: Record<string, unknown> = { query };
    if (locale !== undefined) input.locale = locale;
    return input;
  },
  formatHuman: (data) => {
    const d = data as {
      results?: Array<Record<string, unknown>>;
      suggestions?: string[];
      totalHits?: number;
    };
    const results = d.results ?? [];
    const lines: string[] = [`totalHits: ${(d.totalHits ?? 0).toString()}`];
    if (results.length === 0) {
      lines.push('(no results)');
    } else {
      for (const r of results) {
        const id = formatScalar(r.id);
        const path = formatScalar(r.path);
        const title = formatScalar(r.title);
        lines.push(`  [${id}] ${title}  (${path})`);
      }
    }
    const sugg = d.suggestions ?? [];
    if (sugg.length > 0) {
      lines.push(`suggestions: ${sugg.join(', ')}`);
    }
    return lines.join('\n');
  },
};

// ---------- tags list ----------

const tagsListCmd: CliCommand = {
  path: ['tags', 'list'],
  toolName: 'wiki_tags_list',
  help: 'List all tags the user can read.',
  usage: [
    'wjscli <base-url> tags list [options]',
    '',
    '  List all tags across pages the calling user can read. Filtered',
    '  server-side by the read:pages permission.',
    '',
    'Options:',
    '  --json          Output raw JSON',
    '  -h, --help      Show this help',
    '',
    'Example:',
    '  wjscli https://wiki.example.com tags list',
    '',
  ].join('\n'),
  parseArgs: ({ flags, positionals }) => {
    if (positionals.length > 0) {
      throw new CliUsageError(
        `tags list: unexpected positional arg(s): ${positionals.join(' ')}`,
      );
    }
    rejectUnknownFlags(flags);
    return {};
  },
  formatHuman: (data) => {
    const tags = (data as { tags?: Array<Record<string, unknown>> }).tags ?? [];
    if (tags.length === 0) return '(no tags)';
    return tags
      .map((t) => {
        const tag = formatScalar(t.tag);
        const title = formatScalar(t.title);
        return `${tag}  (${title})`;
      })
      .join('\n');
  },
};

export const CLI_COMMANDS: ReadonlyArray<CliCommand> = [
  pagesTreeCmd,
  pageGetCmd,
  pageCreateCmd,
  pageUpdateCmd,
  pageHistoryCmd,
  searchCmd,
  tagsListCmd,
];

// Find a command by walking the args positionally. Returns the matched
// command + the remaining args after the matched prefix.
export function matchCommand(
  args: ReadonlyArray<string>,
): { command: CliCommand; rest: string[] } | null {
  // Sort longer-path matches first so `page get` wins over a hypothetical
  // bare `page`. Today all `page` commands are two words, so this is
  // future-proofing only.
  const sorted = [...CLI_COMMANDS].sort((a, b) => b.path.length - a.path.length);
  for (const cmd of sorted) {
    if (args.length < cmd.path.length) continue;
    let match = true;
    for (let i = 0; i < cmd.path.length; i++) {
      if (args[i] !== cmd.path[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return { command: cmd, rest: args.slice(cmd.path.length) };
    }
  }
  return null;
}
