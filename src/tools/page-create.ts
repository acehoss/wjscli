import { z } from 'zod';
import {
  PAGE_CREATE_MUTATION,
  type PageCreateResponse,
} from '../wiki/queries.js';
import { jsonResult, type ToolDef } from './types.js';

const inputSchema = z.object({
  path: z.string().min(1).describe('Page path, e.g. "team/onboarding".'),
  title: z.string().min(1),
  content: z.string(),
  description: z
    .string()
    .optional()
    .describe('Page description / summary. Default: "".'),
  editor: z
    .string()
    .optional()
    .describe('Editor key (e.g. "markdown", "code"). Default: "markdown".'),
  locale: z.string().optional().describe('Locale code. Default: "en".'),
  tags: z.array(z.string()).optional().describe('Tag list. Default: [].'),
  isPublished: z.boolean().optional().describe('Default: true.'),
  isPrivate: z.boolean().optional().describe('Default: false.'),
});

export const pageCreateTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_page_create',
  description:
    'Create a Wiki.js page. Required: path, title, content. ' +
    'Defaults applied for unspecified fields: description="", ' +
    'editor="markdown", locale="en", tags=[], isPublished=true, ' +
    'isPrivate=false. The created page is attributed to the user whose ' +
    'JWT was used at bootstrap (preserves audit). Returns ' +
    '{ responseResult, page }; check responseResult.succeeded — Wiki.js ' +
    "reports validation failures via the result, not GraphQL errors.",
  inputSchema,
  handler: async (input, client) => {
    const variables = {
      path: input.path,
      title: input.title,
      content: input.content,
      description: input.description ?? '',
      editor: input.editor ?? 'markdown',
      locale: input.locale ?? 'en',
      tags: input.tags ?? [],
      isPublished: input.isPublished ?? true,
      isPrivate: input.isPrivate ?? false,
    };
    const data = await client.gql<PageCreateResponse>(
      PAGE_CREATE_MUTATION,
      variables,
    );
    return jsonResult(data.pages.create);
  },
};
