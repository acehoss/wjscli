import { GraphQLError } from '../util/errors.js';
import type { WikiClient } from '../wiki/client.js';
import {
  PAGE_SINGLE_BY_PATH_QUERY,
  type PageSingleByPathResponse,
} from '../wiki/queries.js';
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
  // Optional second-stage transform. Runs after parseArgs and before
  // dispatchTool, with a live WikiClient available. Used by `page update`
  // and `page history` to resolve a CLI-supplied path → id (via
  // pages.singleByPath) before calling the id-only underlying tool. May
  // throw WikiMcpError subclasses; runCli's catch handles them.
  resolveInput?: (input: unknown, client: WikiClient) => Promise<unknown>;
  formatHuman: (data: unknown) => string;
};

// Helper used by `page get`, `page update`, and `page history`: a positional
// arg that's all-digits is read as a numeric Page ID; anything else is a
// page path. Returns the normalised pair so callers can stuff it into
// whatever input shape their underlying tool expects (or pre-resolve via
// `resolveInput`).
function parseIdOrPath(value: string): { id: number } | { path: string } {
  if (/^\d+$/.test(value)) {
    return { id: Number(value) };
  }
  return { path: value };
}

// Friendlier error than `rejectUnknownFlags` for the common migration
// stumble: previously `--id` and `--path` were explicit flags on these
// commands; now they're the positional. Throw before any other validation
// so the user sees the migration hint immediately.
function rejectLegacyIdPathFlags(
  flags: Map<string, string[]>,
  cmd: string,
): void {
  if (flags.has('id')) {
    throw new CliUsageError(
      `--id is no longer accepted on \`${cmd}\`; pass the id positionally ` +
        `(e.g. \`${cmd} 42\`).`,
    );
  }
}

// Look up a page by path → return its id. Used by `page update` and
// `page history` to support `wjscli ... page update team/onboarding ...`
// against tools that only accept a numeric id.
async function resolvePathToId(
  client: WikiClient,
  path: string,
  locale: string,
): Promise<number> {
  const data = await client.gql<PageSingleByPathResponse>(
    PAGE_SINGLE_BY_PATH_QUERY,
    { path, locale },
  );
  const page = data.pages.singleByPath;
  if (page === null) {
    throw new GraphQLError([
      { message: `Page not found at path "${path}" (locale ${locale}).` },
    ]);
  }
  return page.id;
}

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
  help: 'Fetch a single page by id (numeric) or path.',
  usage: [
    'wjscli <base-url> page get <id-or-path> [options]',
    '',
    '  Fetch a single Wiki.js page. The positional argument is auto-',
    '  detected: an all-digits value is parsed as a numeric Page ID; any',
    '  other string is treated as a path. Some fields (content, editor,',
    '  author/creator details) require write:pages or manage:system',
    '  permission server-side; if the user lacks them, Wiki.js returns a',
    '  GraphQL error.',
    '',
    'Options:',
    '  --locale L      Locale code (applies to path lookup; default en)',
    '  --json          Output raw JSON instead of human-readable view',
    '  -h, --help      Show this help',
    '',
    'Examples:',
    '  wjscli https://wiki.example.com page get 42',
    '  wjscli https://wiki.example.com page get team/onboarding',
    '  wjscli https://wiki.example.com page get team/onboarding --locale fr',
    '',
  ].join('\n'),
  parseArgs: ({ flags, positionals }) => {
    rejectLegacyIdPathFlags(flags, 'page get');
    if (flags.has('path')) {
      throw new CliUsageError(
        '--path is no longer accepted on `page get`; pass the path positionally.',
      );
    }
    if (positionals.length === 0) {
      throw new CliUsageError(
        'page get requires an id or path: `page get 42` or `page get team/onboarding`.',
      );
    }
    if (positionals.length > 1) {
      throw new CliUsageError(
        `page get: unexpected extra positional arg(s): ${positionals.slice(1).join(' ')}`,
      );
    }
    const locale = takeOptionalString(flags, 'locale');
    rejectUnknownFlags(flags);
    const input: Record<string, unknown> = { ...parseIdOrPath(positionals[0] ?? '') };
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
  help: 'Update a page identified by id (numeric) or path.',
  usage: [
    'wjscli <base-url> page update <id-or-path> [field...]',
    '',
    '  Update an existing Wiki.js page. The positional argument identifies',
    '  the page: all-digits → numeric ID; any other string → path. If a',
    '  path is given, the CLI resolves it to an id via pages.singleByPath',
    '  (one extra round-trip), then issues the update.',
    '',
    '  Only supplied fields are changed; unsupplied fields are preserved',
    '  (the tool fetch-merge-updates under the hood — one more round-trip).',
    '',
    'Mutable fields (supply any one or more):',
    '  --path P        New path (renames the page; distinct from the',
    '                  positional identifier above)',
    '  --title T',
    '  --content C     Supports @-/@path',
    '  --description D Supports @-/@path',
    '  --editor E',
    '  --locale L      New locale value (also used to disambiguate the',
    '                  positional path lookup; default en)',
    '  --tag T         Repeatable; comma-splittable',
    '  --published / --no-published',
    '  --private / --no-private',
    '',
    'Options:',
    '  --json          Output raw JSON',
    '  -h, --help      Show this help',
    '',
    'Examples:',
    '  wjscli https://wiki.example.com page update 42 --title "New title"',
    '  wjscli https://wiki.example.com page update team/onboarding \\',
    '    --content @./new-body.md',
    '  wjscli https://wiki.example.com page update 42 --path team/renamed',
    '',
  ].join('\n'),
  parseArgs: async ({ flags, positionals }) => {
    rejectLegacyIdPathFlags(flags, 'page update');
    if (positionals.length === 0) {
      throw new CliUsageError(
        'page update requires an id or path: `page update 42 ...` or `page update team/foo ...`.',
      );
    }
    if (positionals.length > 1) {
      throw new CliUsageError(
        `page update: unexpected extra positional arg(s): ${positionals.slice(1).join(' ')}`,
      );
    }
    const ref = parseIdOrPath(positionals[0] ?? '');
    // --path on `page update` means "new path to rename to" — the MCP tool's
    // `path` field. It is NOT the identifying path; that's the positional.
    const newPath = takeOptionalString(flags, 'path');
    const title = takeOptionalString(flags, 'title');
    const rawContent = takeOptionalString(flags, 'content');
    const content =
      rawContent !== undefined ? await resolveStringValue(rawContent) : undefined;
    const writeFields = await takePageWriteFields(flags);
    rejectUnknownFlags(flags);

    const input: Record<string, unknown> = {};
    if ('id' in ref) {
      input.id = ref.id;
    } else {
      // _lookupPath is consumed by resolveInput below and never reaches the
      // MCP tool (the leading underscore marks it as a CLI-internal field).
      input._lookupPath = ref.path;
    }
    if (newPath !== undefined) input.path = newPath;
    if (title !== undefined) input.title = title;
    if (content !== undefined) input.content = content;
    Object.assign(input, writeFields);

    // Must have at least one mutable field; the identifier on its own is
    // not enough to do anything useful.
    const mutableKeys = Object.keys(input).filter(
      (k) => k !== 'id' && k !== '_lookupPath',
    );
    if (mutableKeys.length === 0) {
      throw new CliUsageError(
        'page update requires at least one field to change (e.g. --title, --content, --path).',
      );
    }
    return input;
  },
  resolveInput: async (rawInput, client) => {
    const input = rawInput as { _lookupPath?: string; locale?: string } & Record<
      string,
      unknown
    >;
    if (input._lookupPath === undefined) return input;
    const lookupLocale = typeof input.locale === 'string' ? input.locale : 'en';
    const id = await resolvePathToId(client, input._lookupPath, lookupLocale);
    const { _lookupPath: _drop, ...rest } = input;
    void _drop;
    return { ...rest, id };
  },
  formatHuman: formatResult,
};

// ---------- page history ----------

const pageHistoryCmd: CliCommand = {
  path: ['page', 'history'],
  toolName: 'wiki_page_history',
  help: 'Fetch revision history of a page (id or path).',
  usage: [
    'wjscli <base-url> page history <id-or-path> [options]',
    '',
    '  Fetch the revision history of a Wiki.js page. The positional',
    '  argument is auto-detected: all-digits → numeric ID; any other',
    '  string → path. Path identifiers are resolved to an id via',
    '  pages.singleByPath (one extra round-trip). Requires manage:system',
    '  or read:history permission server-side.',
    '',
    'Options:',
    '  --offset-page N   Page offset for pagination (default 0)',
    '  --offset-size N   Page size for pagination (Wiki.js default 100)',
    '  --locale L        Locale for the path → id lookup (default en)',
    '  --json            Output raw JSON',
    '  -h, --help        Show this help',
    '',
    'Examples:',
    '  wjscli https://wiki.example.com page history 42',
    '  wjscli https://wiki.example.com page history team/onboarding',
    '',
  ].join('\n'),
  parseArgs: ({ flags, positionals }) => {
    rejectLegacyIdPathFlags(flags, 'page history');
    if (positionals.length === 0) {
      throw new CliUsageError(
        'page history requires an id or path: `page history 42` or `page history team/foo`.',
      );
    }
    if (positionals.length > 1) {
      throw new CliUsageError(
        `page history: unexpected extra positional arg(s): ${positionals.slice(1).join(' ')}`,
      );
    }
    const ref = parseIdOrPath(positionals[0] ?? '');
    const offsetPage = takeOptionalInt(flags, 'offset-page');
    const offsetSize = takeOptionalInt(flags, 'offset-size');
    const lookupLocale = takeOptionalString(flags, 'locale');
    rejectUnknownFlags(flags);
    const input: Record<string, unknown> = {};
    if ('id' in ref) {
      input.id = ref.id;
    } else {
      input._lookupPath = ref.path;
      if (lookupLocale !== undefined) input._lookupLocale = lookupLocale;
    }
    if (offsetPage !== undefined) input.offsetPage = offsetPage;
    if (offsetSize !== undefined) input.offsetSize = offsetSize;
    return input;
  },
  resolveInput: async (rawInput, client) => {
    const input = rawInput as {
      _lookupPath?: string;
      _lookupLocale?: string;
    } & Record<string, unknown>;
    if (input._lookupPath === undefined) return input;
    const lookupLocale = input._lookupLocale ?? 'en';
    const id = await resolvePathToId(client, input._lookupPath, lookupLocale);
    const { _lookupPath: _dropPath, _lookupLocale: _dropLocale, ...rest } = input;
    void _dropPath;
    void _dropLocale;
    return { ...rest, id };
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
