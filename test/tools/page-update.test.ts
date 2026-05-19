import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/tools/index.js';
import type {
  CreatedPageSummary,
  Page,
  PageUpdateResponse,
  ResponseStatus,
} from '../../src/wiki/queries.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

const okStatus = (msg = 'Page has been updated.'): ResponseStatus => ({
  succeeded: true,
  errorCode: 0,
  slug: 'ok',
  message: msg,
});

// No `locale`/`editor` — Wiki.js can't resolve them on mutation returns
// (see MF1 note in src/wiki/queries.ts).
const updatedSummary = (over: Partial<CreatedPageSummary> = {}): CreatedPageSummary => ({
  id: 42,
  path: 'team/onboarding',
  title: 'Onboarding',
  isPrivate: false,
  isPublished: true,
  createdAt: '2026-05-18T00:00:00Z',
  updatedAt: '2026-05-18T01:00:00Z',
  ...over,
});

// A representative "current page" state for fetch-merge-update tests. The
// merge will fall back to these values for any field the caller doesn't
// supply.
const currentPage = (over: Partial<Page> = {}): Page => ({
  id: 42,
  path: 'team/onboarding',
  hash: 'abc',
  title: 'Onboarding',
  description: 'How we onboard.',
  isPrivate: false,
  isPublished: true,
  privateNS: null,
  publishStartDate: '',
  publishEndDate: '',
  tags: [
    { id: 1, tag: 'team', title: 'Team', createdAt: 'x', updatedAt: 'x' },
    { id: 2, tag: 'docs', title: 'Docs', createdAt: 'x', updatedAt: 'x' },
  ],
  content: '# Onboarding\n\noriginal content',
  render: null,
  contentType: 'markdown',
  createdAt: '2026-05-18T00:00:00Z',
  updatedAt: '2026-05-18T00:30:00Z',
  editor: 'markdown',
  locale: 'en',
  scriptCss: null,
  scriptJs: null,
  authorId: 10,
  authorName: 'Aaron Heise',
  authorEmail: 'a@example.com',
  creatorId: 10,
  creatorName: 'Aaron Heise',
  creatorEmail: 'a@example.com',
  ...over,
});

// Helper: stage a combined response that serves BOTH the fetch (single)
// and the subsequent update mutation. Because the mock returns the same
// script for every request in a test, including both keys under data.pages
// covers the two-call fetch-merge-update flow in one go.
const replyFetchMerge = (
  ctxObj: { mock: { setNext: (script: { data: unknown }) => void } },
  page: Page,
  updateResp: PageUpdateResponse['pages']['update'],
): void => {
  ctxObj.mock.setNext({
    data: { pages: { single: page, update: updateResp } },
  });
};

describe('wiki_page_update', () => {
  it('fetch-merge-update: supplied fields override, omitted preserved from current', async () => {
    const ctxObj = ctx();
    replyFetchMerge(ctxObj, currentPage(), {
      responseResult: okStatus(),
      page: updatedSummary({ title: 'Onboarding v2' }),
    });
    await dispatchTool(
      'wiki_page_update',
      { id: 42, title: 'Onboarding v2' },
      ctxObj.client,
    );
    // Two round-trips: one fetch, one update.
    expect(ctxObj.mock.requestCount()).toBe(2);
    const body = ctxObj.mock.lastRequest()?.parsed as {
      query?: string;
      variables?: Record<string, unknown>;
    } | null;
    // Update payload merges: supplied title, everything else from current page.
    expect(body?.variables).toEqual({
      id: 42,
      title: 'Onboarding v2',
      content: '# Onboarding\n\noriginal content',
      description: 'How we onboard.',
      editor: 'markdown',
      isPrivate: false,
      isPublished: true,
      locale: 'en',
      path: 'team/onboarding',
      tags: ['team', 'docs'],
    });
    // Mutation declares every PAGE_UPDATE_FIELDS variable, not a dynamic
    // subset. This is the load-bearing change vs the prior partial-mutation
    // behavior — keeps Wiki.js from silently destroying omitted fields.
    expect(body?.query).toMatch(/\$id: Int!/);
    expect(body?.query).toMatch(/\$content: String/);
    expect(body?.query).toMatch(/\$tags: \[String\]/);
    expect(body?.query).toMatch(/\$isPublished: Boolean/);
    expect(body?.query).toMatch(/\$title: String/);
    expect(body?.query).toMatch(/\$path: String/);
    expect(body?.query).toMatch(/\$locale: String/);
    expect(body?.query).toMatch(/\$description: String/);
    expect(body?.query).toMatch(/\$editor: String/);
    expect(body?.query).toMatch(/\$isPrivate: Boolean/);
  });

  it('supports multiple changed fields at once', async () => {
    const ctxObj = ctx();
    replyFetchMerge(ctxObj, currentPage(), {
      responseResult: okStatus(),
      page: updatedSummary({ isPublished: false }),
    });
    await dispatchTool(
      'wiki_page_update',
      { id: 42, content: '# new content', tags: ['x'], isPublished: false },
      ctxObj.client,
    );
    expect(ctxObj.mock.requestCount()).toBe(2);
    const body = ctxObj.mock.lastRequest()?.parsed as {
      query?: string;
      variables?: Record<string, unknown>;
    } | null;
    // Supplied: content, tags, isPublished. Everything else from current.
    expect(body?.variables).toMatchObject({
      id: 42,
      content: '# new content',
      tags: ['x'],
      isPublished: false,
      title: 'Onboarding',
      description: 'How we onboard.',
      editor: 'markdown',
      isPrivate: false,
      locale: 'en',
      path: 'team/onboarding',
    });
  });

  it('regression: omitting isPublished preserves current value (not silently false)', async () => {
    // This is the load-bearing regression test for the Wiki.js destructive
    // default. Without fetch-merge-update, omitting isPublished would let
    // the server flip the page from published → unpublished.
    const ctxObj = ctx();
    replyFetchMerge(ctxObj, currentPage({ isPublished: true }), {
      responseResult: okStatus(),
      page: updatedSummary({ isPublished: true }),
    });
    await dispatchTool(
      'wiki_page_update',
      { id: 42, content: 'updated' },
      ctxObj.client,
    );
    const body = ctxObj.mock.lastRequest()?.parsed as {
      variables?: Record<string, unknown>;
    } | null;
    expect(body?.variables).toMatchObject({ isPublished: true });
  });

  it('regression: omitting tags preserves current tags (not undefined which crashes)', async () => {
    // Wiki.js's associateTags does tags.map() on opts.tags without a guard.
    // Sending the current tag names keeps the same set associated.
    const ctxObj = ctx();
    replyFetchMerge(
      ctxObj,
      currentPage({
        tags: [
          { id: 1, tag: 'a', title: 'A', createdAt: 'x', updatedAt: 'x' },
          { id: 2, tag: 'b', title: 'B', createdAt: 'x', updatedAt: 'x' },
        ],
      }),
      { responseResult: okStatus(), page: updatedSummary() },
    );
    await dispatchTool(
      'wiki_page_update',
      { id: 42, title: 'new title' },
      ctxObj.client,
    );
    const body = ctxObj.mock.lastRequest()?.parsed as {
      variables?: Record<string, unknown>;
    } | null;
    expect(body?.variables).toMatchObject({ tags: ['a', 'b'] });
  });

  it('rejects when only id is provided (no fields to change)', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_page_update', { id: 42 }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects when id is missing', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_page_update', { title: 'A' }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates AuthExpiredError as InvalidRequest', async () => {
    // The auth check fails on the FIRST request (the single() fetch),
    // before the merge or the update mutation is sent.
    const { mock, client } = ctx();
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await dispatchTool(
      'wiki_page_update',
      { id: 1, title: 'A' },
      client,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCode.InvalidRequest });
    // Only the single() fetch happened; update never sent.
    expect(mock.requestCount()).toBe(1);
  });

  it('returns isError content for a generic GraphQL error on the fetch', async () => {
    const { mock, client } = ctx();
    mock.setNext({ errors: [{ message: 'Internal server error' }] });
    const result = await dispatchTool(
      'wiki_page_update',
      { id: 1, title: 'A' },
      client,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/Internal server error/);
    expect(mock.requestCount()).toBe(1);
  });

  it('returns isError when the page does not exist (single returned null)', async () => {
    const { mock, client } = ctx();
    mock.setNext({ data: { pages: { single: null } } });
    const result = await dispatchTool(
      'wiki_page_update',
      { id: 9999, title: 'A' },
      client,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/Page 9999 not found/);
    expect(mock.requestCount()).toBe(1);
  });
});
