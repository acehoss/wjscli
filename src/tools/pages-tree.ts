import { z } from 'zod';
import type { WikiClient } from '../wiki/client.js';
import {
  PAGES_TREE_QUERY,
  type PageTreeItem,
  type PageTreeMode,
  type PagesTreeResponse,
} from '../wiki/queries.js';
import { jsonResult, type ToolDef } from './types.js';

const inputSchema = z.object({
  parent: z.number().int().optional().describe('Parent node ID; default 0 (root).'),
  mode: z
    .enum(['ALL', 'PAGES', 'FOLDERS'])
    .optional()
    .describe('Filter: ALL (default), PAGES, or FOLDERS.'),
  locale: z.string().optional().describe('Locale code; default "en".'),
  depth: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'How many levels below `parent` to recurse. Default 20 — deep ' +
        'enough to print the full tree for almost any wiki. Each level ' +
        'fans out one extra GraphQL query per node at the level above, ' +
        'so set this lower on very large wikis if cost matters.',
    ),
});

// Default depth: 20 levels covers any realistic wiki structure without
// running away, and matches the user expectation of "show the full tree
// unless I say otherwise".
const DEFAULT_DEPTH = 20;

// Recursively fetch the page tree under `parentId`. Wiki.js's `pages.tree`
// resolver only returns immediate children of the given parent, so we have
// to issue one query per level per node. Siblings at the same level are
// queried in parallel via Promise.all — this trades the latency of the
// slowest sibling for what would otherwise be a serial walk.
//
// Output is the depth-first concatenation: each parent immediately followed
// by its subtree. That ordering is what the human-readable tree renderer
// expects (so the renderer doesn't have to topologically re-sort).
async function fetchSubtree(
  client: WikiClient,
  parentId: number,
  mode: PageTreeMode,
  locale: string,
  remainingDepth: number,
): Promise<PageTreeItem[]> {
  if (remainingDepth <= 0) return [];
  const data = await client.gql<PagesTreeResponse>(PAGES_TREE_QUERY, {
    parent: parentId,
    mode,
    locale,
  });
  const items = data.pages.tree ?? [];
  if (remainingDepth === 1 || items.length === 0) {
    return items;
  }
  const subtrees = await Promise.all(
    items.map((item) =>
      fetchSubtree(client, item.id, mode, locale, remainingDepth - 1),
    ),
  );
  const out: PageTreeItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    out.push(item);
    out.push(...(subtrees[i] ?? []));
  }
  return out;
}

export const pagesTreeTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_pages_tree',
  description:
    'List a slice of the Wiki.js page tree under a parent node. Each entry ' +
    'includes `depth` (absolute from the wiki root) and `parent` so the ' +
    'caller can rebuild the hierarchy. Defaults: parent=0 (root), mode=ALL, ' +
    'locale=en, depth=20 (deep enough to print the full tree for most ' +
    'wikis). Each extra level adds one GraphQL round-trip per node at the ' +
    'level above. The returned list is flat but ordered DFS — parent first, ' +
    'then its subtree, then the next sibling.',
  inputSchema,
  handler: async (input, client) => {
    const parent = input.parent ?? 0;
    const mode: PageTreeMode = input.mode ?? 'ALL';
    const locale = input.locale ?? 'en';
    const depth = input.depth ?? DEFAULT_DEPTH;
    const tree = await fetchSubtree(client, parent, mode, locale, depth);
    return jsonResult({ tree });
  },
};
