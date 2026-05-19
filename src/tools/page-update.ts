import { z } from 'zod';
import {
  buildPageUpdateMutation,
  PAGE_SINGLE_QUERY,
  PAGE_UPDATE_FIELDS,
  type PageSingleResponse,
  type PageUpdateResponse,
} from '../wiki/queries.js';
import { GraphQLError } from '../util/errors.js';
import { jsonResult, type ToolDef } from './types.js';

const inputSchema = z
  .object({
    id: z.number().int().positive(),
    content: z.string().optional(),
    description: z.string().optional(),
    editor: z.string().optional(),
    isPrivate: z.boolean().optional(),
    isPublished: z.boolean().optional(),
    locale: z.string().optional(),
    path: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    title: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      v.content !== undefined ||
      v.description !== undefined ||
      v.editor !== undefined ||
      v.isPrivate !== undefined ||
      v.isPublished !== undefined ||
      v.locale !== undefined ||
      v.path !== undefined ||
      v.tags !== undefined ||
      v.title !== undefined,
    'wiki_page_update requires at least one field to change besides `id`.',
  );

export const pageUpdateTool: ToolDef<typeof inputSchema> = {
  name: 'wiki_page_update',
  description:
    'Update a Wiki.js page. Requires `id` plus at least one field to ' +
    'change. Only the supplied fields are changed — unsupplied fields are ' +
    'preserved at their current values. Implemented as fetch-merge-update ' +
    "(one extra round-trip) because Wiki.js's update resolver silently " +
    'destroys some fields when they are omitted (isPublished flips to ' +
    'false, publish dates blank out, tags crashes, content is rejected). ' +
    'The update is attributed to the user whose JWT was used at bootstrap. ' +
    'Returns { responseResult, page }; check responseResult.succeeded for ' +
    'server-side validation failures.',
  inputSchema,
  handler: async (input, client) => {
    // Wiki.js's update resolver does NOT honor "omitted = preserved" for
    // every field. Observed against real Wiki.js v2.5:
    //   - opts.content undefined → PageEmptyContent thrown (server/models/pages.js:386).
    //   - opts.tags undefined    → tags.map() crashes in associateTags (server/models/tags.js:58).
    //   - opts.isPublished undefined → silently flipped to false
    //     (resolver expresses `opts.isPublished === true || opts.isPublished === 1`,
    //     which evaluates to false for undefined, so Knex writes false to
    //     the column — destructive).
    //   - opts.publishStartDate/EndDate undefined → silently set to '' .
    // To honor our tool contract (partial update with field preservation),
    // we fetch the current page state, merge supplied fields on top, then
    // send a complete update payload with every PAGE_UPDATE_FIELDS field.
    // Cost: one extra round-trip per call. Benefit: no destructive defaults.
    const current = await client.gql<PageSingleResponse>(PAGE_SINGLE_QUERY, {
      id: input.id,
    });
    const page = current.pages.single;
    if (page === null) {
      // Mirrors Wiki.js's "Invalid Page Id" error from server/models/pages.js:374.
      throw new GraphQLError([{ message: `Page ${input.id.toString()} not found.` }]);
    }

    const variables: Record<string, unknown> = {
      id: input.id,
      content: input.content ?? page.content,
      description: input.description ?? page.description,
      editor: input.editor ?? page.editor,
      isPrivate: input.isPrivate ?? page.isPrivate,
      isPublished: input.isPublished ?? page.isPublished,
      locale: input.locale ?? page.locale,
      path: input.path ?? page.path,
      // Page returns tags as [{tag, title, ...}]; the mutation wants [String]
      // of tag names. Extract names from the current state on the fallback.
      tags: input.tags ?? page.tags.map((t) => t.tag),
      title: input.title ?? page.title,
    };

    const mutation = buildPageUpdateMutation(PAGE_UPDATE_FIELDS);
    const data = await client.gql<PageUpdateResponse>(mutation, variables);
    return jsonResult(data.pages.update);
  },
};
