import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/tools/index.js';
import type {
  CreatedPageSummary,
  PageCreateResponse,
  ResponseStatus,
} from '../../src/wiki/queries.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

const okStatus = (msg = 'Page created successfully.'): ResponseStatus => ({
  succeeded: true,
  errorCode: 0,
  slug: 'ok',
  message: msg,
});

// Page summary deliberately omits `locale`/`editor` — real Wiki.js can not
// resolve those on the mutation return path (see MF1 note in
// src/wiki/queries.ts). Selecting them would produce a non-null violation.
const createdSummary = (over: Partial<CreatedPageSummary> = {}): CreatedPageSummary => ({
  id: 100,
  path: 'team/onboarding',
  title: 'Onboarding',
  isPrivate: false,
  isPublished: true,
  createdAt: '2026-05-18T00:00:00Z',
  updatedAt: '2026-05-18T00:00:00Z',
  ...over,
});

const goodCreate = (): PageCreateResponse['pages']['create'] => ({
  responseResult: okStatus(),
  page: createdSummary(),
});

describe('wiki_page_create', () => {
  it('sends required + defaulted fields and returns the create response', async () => {
    const { mock, client } = ctx();
    mock.replyToCreatePage(goodCreate());
    const result = await dispatchTool(
      'wiki_page_create',
      { path: 'team/onboarding', title: 'Onboarding', content: '# Welcome' },
      client,
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      responseResult: { succeeded: boolean };
      page: { id: number };
    };
    expect(parsed.responseResult.succeeded).toBe(true);
    expect(parsed.page.id).toBe(100);
    const body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({
      path: 'team/onboarding',
      title: 'Onboarding',
      content: '# Welcome',
      description: '',
      editor: 'markdown',
      locale: 'en',
      tags: [],
      isPublished: true,
      isPrivate: false,
    });
  });

  it('forwards caller-supplied overrides instead of defaults', async () => {
    const { mock, client } = ctx();
    mock.replyToCreatePage(goodCreate());
    await dispatchTool(
      'wiki_page_create',
      {
        path: 'docs/draft',
        title: 'Draft',
        content: '',
        description: 'A draft.',
        editor: 'code',
        locale: 'fr',
        tags: ['draft', 'doc'],
        isPublished: false,
        isPrivate: true,
      },
      client,
    );
    const body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toMatchObject({
      description: 'A draft.',
      editor: 'code',
      locale: 'fr',
      tags: ['draft', 'doc'],
      isPublished: false,
      isPrivate: true,
    });
  });

  it('rejects missing required fields', async () => {
    const { client } = ctx();
    const err = await dispatchTool(
      'wiki_page_create',
      { path: 'x' /* missing title and content */ },
      client,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('passes through a server-side validation failure as JSON (not an error)', async () => {
    // pages.create returns responseResult.succeeded=false for validation
    // failures; that is NOT a GraphQL error, so the tool returns it as data.
    const { mock, client } = ctx();
    // Matches the real Wiki.js PageDuplicateCreate definition
    // (repos/wiki/server/helpers/error.js: errorCode 6002, slug 'PageDuplicateCreate').
    mock.replyToCreatePage({
      responseResult: {
        succeeded: false,
        errorCode: 6002,
        slug: 'PageDuplicateCreate',
        message: 'Cannot create this page because an entry already exists at the same path.',
      },
      page: null,
    });
    const result = await dispatchTool(
      'wiki_page_create',
      { path: 'home', title: 'Home', content: '' },
      client,
    );
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      responseResult: { succeeded: boolean };
    };
    expect(parsed.responseResult.succeeded).toBe(false);
  });

  it('propagates AuthExpiredError as InvalidRequest', async () => {
    const { mock, client } = ctx();
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await dispatchTool(
      'wiki_page_create',
      { path: 'a', title: 'A', content: '' },
      client,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('returns isError content for a generic GraphQL error', async () => {
    const { mock, client } = ctx();
    mock.setNext({ errors: [{ message: 'Internal server error' }] });
    const result = await dispatchTool(
      'wiki_page_create',
      { path: 'a', title: 'A', content: '' },
      client,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/Internal server error/);
  });
});
