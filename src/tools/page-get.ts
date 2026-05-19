import { z } from 'zod';
import {
  PAGE_SINGLE_BY_PATH_QUERY,
  PAGE_SINGLE_QUERY,
  type PageSingleByPathResponse,
  type PageSingleResponse,
} from '../wiki/queries.js';
import { jsonResult, type ToolDef } from './types.js';

// XOR discriminator: either {id} OR {path, locale?}. The MCP spec requires
// inputSchema to be a single JSON Schema object (`type: "object"`), so we
// model the XOR as a flat object with both `id` and `path` optional, and
// enforce the "exactly one of {id, path}" rule with a refine. The handler
// then narrows by presence.
const inputSchema = z
  .object({
    id: z.number().int().positive().optional(),
    path: z.string().min(1).optional(),
    locale: z.string().optional(),
  })
  .strict()
  .refine(
    (v) => (v.id !== undefined) !== (v.path !== undefined),
    {
      message:
        'wiki_page_get requires exactly one of `id` or `path` (got both or neither).',
    },
  );

export const pageGetTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_page_get',
  description:
    'Fetch a single Wiki.js page. REQUIRED: exactly one of `id` (integer) ' +
    'or `path` (string). Passing both or neither yields InvalidParams. ' +
    '`locale` defaults to "en" and applies only when looking up by path. ' +
    'Returns the full Page record (title, path, content, contentType, ' +
    'tags, isPublished, createdAt, updatedAt, authorName, etc.). Some ' +
    'Page fields (content, editor, author/creator details) require ' +
    'write:pages or manage:system permission — a GraphQL error indicates ' +
    'the current user lacks access to those specific fields.',
  inputSchema,
  // We deliberately do NOT emit a top-level `oneOf` to signal the XOR.
  // The Anthropic Messages API rejects top-level `oneOf`/`anyOf`/`allOf`
  // in tool input_schema (400: "input_schema does not support oneOf,
  // allOf, or anyOf at the top level"), so the prior patch broke that
  // client even though it was valid per JSON Schema and the MCP spec.
  // The XOR is enforced at runtime by the Zod refine above, and the
  // description above makes the constraint explicit for schema-readers.
  handler: async (input, client) => {
    if (input.id !== undefined) {
      const data = await client.gql<PageSingleResponse>(PAGE_SINGLE_QUERY, {
        id: input.id,
      });
      return jsonResult({ page: data.pages.single });
    }
    // Refine guarantees path is set here.
    const data = await client.gql<PageSingleByPathResponse>(
      PAGE_SINGLE_BY_PATH_QUERY,
      { path: input.path ?? '', locale: input.locale ?? 'en' },
    );
    return jsonResult({ page: data.pages.singleByPath });
  },
};
