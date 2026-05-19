import { z } from 'zod';
import {
  PAGES_TREE_QUERY,
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
});

export const pagesTreeTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_pages_tree',
  description:
    'List a flat slice of the Wiki.js page tree under a parent node. ' +
    'Each entry includes `depth` and `parent` so the caller can rebuild ' +
    'the hierarchy. Defaults: parent=0 (root), mode=ALL, locale=en.',
  inputSchema,
  handler: async (input, client) => {
    const variables = {
      parent: input.parent ?? 0,
      mode: input.mode ?? 'ALL',
      locale: input.locale ?? 'en',
    };
    const data = await client.gql<PagesTreeResponse>(PAGES_TREE_QUERY, variables);
    return jsonResult({ tree: data.pages.tree ?? [] });
  },
};
