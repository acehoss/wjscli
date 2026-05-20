import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Page } from '../wiki/queries.js';

// What we serialise into a page file's frontmatter. We deliberately project
// the Wiki.js Page record down to a finite, documented set of fields rather
// than YAML-dumping the whole thing — extra fields would be confusing
// (read-only? round-tripped? mutable?). On push, mutable fields go to
// `wiki_page_update`; informational fields are ignored.
export type PageFrontmatter = {
  // Identifier + mutable settings (sent to update).
  id: number;
  path: string;
  title: string;
  description: string;
  locale: string;
  editor: string;
  isPublished: boolean;
  isPrivate: boolean;
  tags: string[];
  // Informational, read-only — useful for humans reading the file and for
  // conflict detection on push (we compare server's current updatedAt
  // against this stored value before issuing an update).
  createdAt: string;
  updatedAt: string;
  authorId: number;
  authorName: string;
};

// Mutable subset of frontmatter that maps 1:1 onto `wiki_page_update` input.
export type MutableFrontmatter = Pick<
  PageFrontmatter,
  | 'path'
  | 'title'
  | 'description'
  | 'locale'
  | 'editor'
  | 'isPublished'
  | 'isPrivate'
  | 'tags'
>;

// Render a Wiki.js Page as a markdown file with YAML frontmatter on top.
// Output always uses '\n' line endings and an explicit `---` delimiter
// pair; never includes a trailing newline beyond what the page body has.
export function serializePage(page: Page): string {
  const fm: PageFrontmatter = {
    id: page.id,
    path: page.path,
    title: page.title,
    description: page.description,
    locale: page.locale,
    editor: page.editor,
    isPublished: page.isPublished,
    isPrivate: page.isPrivate,
    tags: page.tags.map((t) => t.tag),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    authorId: page.authorId,
    authorName: page.authorName,
  };
  // yaml's stringify always ends in '\n'; trimEnd then add a single '\n' so
  // the layout is unambiguous: `---\n<yaml>\n---\n<body>`.
  const yamlBlock = stringifyYaml(fm).trimEnd();
  return `---\n${yamlBlock}\n---\n${page.content}`;
}

// Parse a file (frontmatter + body). Throws on malformed shape; we want
// users to see a real error rather than silently round-tripping garbage
// back to the wiki on push.
export function deserializePage(text: string): {
  frontmatter: PageFrontmatter;
  body: string;
} {
  if (!text.startsWith('---\n')) {
    throw new Error(
      'page file does not begin with YAML frontmatter (missing leading "---\\n")',
    );
  }
  const rest = text.slice(4);
  // Closing `---` must be at the start of its own line. Multiline mode so
  // ^ matches line starts.
  const closing = /^---\n/m.exec(rest);
  if (closing === null) {
    throw new Error(
      'YAML frontmatter is unterminated (no closing "---\\n" delimiter)',
    );
  }
  const yamlBlock = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + 4);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock);
  } catch (err) {
    throw new Error(
      `YAML frontmatter parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('YAML frontmatter did not parse to an object');
  }
  const fm = validateFrontmatter(parsed as Record<string, unknown>);
  return { frontmatter: fm, body };
}

// Validate the parsed YAML object against the documented frontmatter shape.
// Surfaces precise errors so the user knows what field needs fixing.
function validateFrontmatter(raw: Record<string, unknown>): PageFrontmatter {
  const need = (key: string, type: 'string' | 'number' | 'boolean'): unknown => {
    const v = raw[key];
    if (typeof v !== type) {
      throw new Error(
        `frontmatter field \`${key}\` must be a ${type} (got ${v === undefined ? 'missing' : typeof v})`,
      );
    }
    return v;
  };
  // Tags: array of strings.
  const rawTags = raw.tags;
  if (rawTags !== undefined && !Array.isArray(rawTags)) {
    throw new Error('frontmatter field `tags` must be an array of strings');
  }
  const tags: string[] = (rawTags ?? []).map((t: unknown, i: number) => {
    if (typeof t !== 'string') {
      throw new Error(`frontmatter \`tags[${i.toString()}]\` is not a string`);
    }
    return t;
  });
  return {
    id: need('id', 'number') as number,
    path: need('path', 'string') as string,
    title: need('title', 'string') as string,
    description: (raw.description as string) ?? '',
    locale: need('locale', 'string') as string,
    editor: need('editor', 'string') as string,
    isPublished: need('isPublished', 'boolean') as boolean,
    isPrivate: need('isPrivate', 'boolean') as boolean,
    tags,
    createdAt: (raw.createdAt as string) ?? '',
    updatedAt: (raw.updatedAt as string) ?? '',
    authorId: typeof raw.authorId === 'number' ? raw.authorId : 0,
    authorName: typeof raw.authorName === 'string' ? raw.authorName : '',
  };
}

// SHA-256 hex digest. Used for local change detection: hash the file's
// full text (frontmatter + body) at pull time, store it in the index, and
// recompute on `sync status` to spot edits. Sub-millisecond per page even
// for large bodies, so it's cheap to call freely.
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Project frontmatter onto the field set `wiki_page_update` accepts. Filters
// out informational fields that the update mutation would reject or ignore.
export function frontmatterToUpdateInput(
  fm: PageFrontmatter,
  body: string,
): {
  id: number;
  path: string;
  title: string;
  description: string;
  locale: string;
  editor: string;
  isPublished: boolean;
  isPrivate: boolean;
  tags: string[];
  content: string;
} {
  return {
    id: fm.id,
    path: fm.path,
    title: fm.title,
    description: fm.description,
    locale: fm.locale,
    editor: fm.editor,
    isPublished: fm.isPublished,
    isPrivate: fm.isPrivate,
    tags: fm.tags,
    content: body,
  };
}

// Translate a Wiki.js path (e.g. "team/onboarding") to a relative file
// path inside the clone. We append `.md` and validate that no segment
// starts with `..` or contains a NUL byte — defence in depth against a
// malicious / corrupted wiki tree trying to escape the clone root.
export function pathToFile(wikiPath: string): string {
  if (wikiPath.length === 0) {
    throw new Error('refusing to map empty wiki path to a file');
  }
  const segments = wikiPath.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('\0')) {
      throw new Error(
        `refusing to map suspicious wiki path "${wikiPath}" — bad segment "${seg}"`,
      );
    }
  }
  return `${segments.join('/')}.md`;
}

// Inverse of pathToFile (best-effort; expects a file path produced by us).
export function fileToPath(relFilePath: string): string {
  if (!relFilePath.endsWith('.md')) {
    throw new Error(`expected a .md file path, got "${relFilePath}"`);
  }
  return relFilePath.slice(0, -3);
}
