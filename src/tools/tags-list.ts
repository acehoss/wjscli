import { z } from 'zod';
import { PAGE_TAGS_QUERY, type PageTagsResponse } from '../wiki/queries.js';
import { jsonResult, type ToolDef } from './types.js';

const inputSchema = z.object({}).strict();

export const tagsListTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_tags_list',
  description:
    'List all tags across pages the calling user can read. Results are ' +
    'filtered server-side by read:pages permission.',
  inputSchema,
  handler: async (_input, client) => {
    const data = await client.gql<PageTagsResponse>(PAGE_TAGS_QUERY);
    return jsonResult({ tags: data.pages.tags });
  },
};
