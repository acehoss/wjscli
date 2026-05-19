import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/tools/index.js';
import type { Page } from '../../src/wiki/queries.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

const samplePage = (over: Partial<Page> = {}): Page => ({
  id: 42,
  path: 'team/onboarding',
  hash: 'abc',
  title: 'Onboarding',
  description: '',
  isPrivate: false,
  isPublished: true,
  privateNS: null,
  publishStartDate: '2026-05-18T00:00:00Z',
  publishEndDate: '2099-01-01T00:00:00Z',
  tags: [],
  content: '# Hello',
  render: null,
  contentType: 'markdown',
  createdAt: '2026-05-18T00:00:00Z',
  updatedAt: '2026-05-18T00:00:00Z',
  editor: 'markdown',
  locale: 'en',
  scriptCss: null,
  scriptJs: null,
  authorId: 7,
  authorName: 'A',
  authorEmail: 'a@b',
  creatorId: 7,
  creatorName: 'A',
  creatorEmail: 'a@b',
  ...over,
});

describe('wiki_page_get', () => {
  it('fetches by id (happy path)', async () => {
    const { mock, client } = ctx();
    mock.replyToSinglePage(samplePage());
    const result = await dispatchTool('wiki_page_get', { id: 42 }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { page: { id: number } };
    expect(parsed.page.id).toBe(42);
    const body = mock.lastRequest()?.parsed as { query?: string; variables?: Record<string, unknown> } | null;
    expect(body?.query).toMatch(/single\(id:/);
    expect(body?.variables).toEqual({ id: 42 });
  });

  it('fetches by path with default locale', async () => {
    const { mock, client } = ctx();
    mock.replyToSinglePageByPath(samplePage({ path: 'docs/intro' }));
    await dispatchTool('wiki_page_get', { path: 'docs/intro' }, client);
    const body = mock.lastRequest()?.parsed as { query?: string; variables?: Record<string, unknown> } | null;
    expect(body?.query).toMatch(/singleByPath/);
    expect(body?.variables).toEqual({ path: 'docs/intro', locale: 'en' });
  });

  it('passes explicit locale', async () => {
    const { mock, client } = ctx();
    mock.replyToSinglePageByPath(samplePage());
    await dispatchTool('wiki_page_get', { path: 'a', locale: 'fr' }, client);
    const body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({ path: 'a', locale: 'fr' });
  });

  it('rejects when neither id nor path provided', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_page_get', {}, client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects when both id and path provided', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_page_get', { id: 1, path: 'home' }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates AuthExpiredError as InvalidRequest', async () => {
    const { mock, client } = ctx();
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await dispatchTool('wiki_page_get', { id: 1 }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('returns isError content for a generic GraphQL error', async () => {
    const { mock, client } = ctx();
    mock.setNext({ errors: [{ message: 'Page not found' }] });
    const result = await dispatchTool('wiki_page_get', { id: 999 }, client);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/Page not found/);
  });
});
