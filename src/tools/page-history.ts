import { z } from 'zod';
import {
  PAGE_HISTORY_QUERY,
  type PageHistoryResponse,
} from '../wiki/queries.js';
import { jsonResult, type ToolDef } from './types.js';

const inputSchema = z.object({
  id: z.number().int().positive(),
  offsetPage: z.number().int().nonnegative().optional(),
  offsetSize: z.number().int().positive().optional(),
});

export const pageHistoryTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_page_history',
  description:
    'Fetch the revision history of a Wiki.js page. Paginated via ' +
    'offsetPage (default 0) and offsetSize (Wiki.js default 100). ' +
    'Requires the calling user have manage:system or read:history.',
  inputSchema,
  handler: async (input, client) => {
    const variables: Record<string, unknown> = { id: input.id };
    if (input.offsetPage !== undefined) variables.offsetPage = input.offsetPage;
    if (input.offsetSize !== undefined) variables.offsetSize = input.offsetSize;
    const data = await client.gql<PageHistoryResponse>(
      PAGE_HISTORY_QUERY,
      variables,
    );
    return jsonResult(data.pages.history);
  },
};
