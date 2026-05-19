import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/tools/index.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

const emptySearch = (): { results: []; suggestions: []; totalHits: 0 } => ({
  results: [],
  suggestions: [],
  totalHits: 0,
});

describe('wiki_search', () => {
  it('returns the full search envelope', async () => {
    const { mock, client } = ctx();
    mock.replyToSearch({
      results: [{ id: '1', title: 'Hit', description: '', path: 'home', locale: 'en' }],
      suggestions: [],
      totalHits: 1,
    });
    const result = await dispatchTool('wiki_search', { query: 'hit' }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      results: Array<{ id: string }>;
      totalHits: number;
    };
    expect(parsed.totalHits).toBe(1);
    expect(parsed.results[0]?.id).toBe('1');
  });

  it('returns empty results structure when nothing matches', async () => {
    const { mock, client } = ctx();
    mock.replyToSearch(emptySearch());
    const result = await dispatchTool('wiki_search', { query: 'nothing' }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { results: unknown[]; totalHits: number };
    expect(parsed.results).toEqual([]);
    expect(parsed.totalHits).toBe(0);
  });

  it('forwards an explicit locale; omits when not given', async () => {
    const { mock, client } = ctx();
    mock.replyToSearch(emptySearch());
    await dispatchTool('wiki_search', { query: 'a', locale: 'fr' }, client);
    let body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({ query: 'a', locale: 'fr' });

    mock.replyToSearch(emptySearch());
    await dispatchTool('wiki_search', { query: 'b' }, client);
    body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({ query: 'b' });
  });

  it('rejects empty query', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_search', { query: '' }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates AuthExpiredError', async () => {
    const { mock, client } = ctx();
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await dispatchTool('wiki_search', { query: 'x' }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('returns isError content for a generic GraphQL error', async () => {
    const { mock, client } = ctx();
    mock.setNext({ errors: [{ message: 'Search engine offline' }] });
    const result = await dispatchTool('wiki_search', { query: 'x' }, client);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/Search engine offline/);
  });
});
