import { z } from 'zod';
import {
  PAGE_SEARCH_QUERY,
  type PageSearchResponse,
} from '../wiki/queries.js';
import { jsonResult, type ToolDef } from './types.js';

const inputSchema = z.object({
  query: z.string().min(1),
  locale: z.string().optional(),
});

export const searchTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_search',
  description:
    'Search Wiki.js pages. Returns { results, suggestions, totalHits } ' +
    'as Wiki.js does — results may be empty with totalHits=0 if no ' +
    'search engine is configured on the server. Results are filtered by ' +
    "the calling user's read:pages permission.",
  inputSchema,
  handler: async (input, client) => {
    const variables: Record<string, unknown> = { query: input.query };
    if (input.locale !== undefined) variables.locale = input.locale;
    const data = await client.gql<PageSearchResponse>(
      PAGE_SEARCH_QUERY,
      variables,
    );
    return jsonResult(data.pages.search);
  },
};
