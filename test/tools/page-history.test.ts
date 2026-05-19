import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/tools/index.js';
import type { PageHistoryEntry } from '../../src/wiki/queries.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

const oneEntry = (): PageHistoryEntry => ({
  versionId: 1,
  versionDate: '2026-05-18T00:00:00Z',
  authorId: 7,
  authorName: 'A',
  actionType: 'updated',
  valueBefore: null,
  valueAfter: null,
});

describe('wiki_page_history', () => {
  it('returns history envelope on happy path', async () => {
    const { mock, client } = ctx();
    mock.replyToHistory({ trail: [oneEntry()], total: 1 });
    const result = await dispatchTool('wiki_page_history', { id: 42 }, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      trail: Array<{ versionId: number }>;
      total: number;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.trail[0]?.versionId).toBe(1);
  });

  it('omits pagination variables when not supplied', async () => {
    const { mock, client } = ctx();
    mock.replyToHistory({ trail: [oneEntry()], total: 1 });
    await dispatchTool('wiki_page_history', { id: 42 }, client);
    const body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({ id: 42 });
  });

  it('forwards pagination args', async () => {
    const { mock, client } = ctx();
    mock.replyToHistory({ trail: [oneEntry()], total: 1 });
    await dispatchTool(
      'wiki_page_history',
      { id: 42, offsetPage: 2, offsetSize: 50 },
      client,
    );
    const body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({ id: 42, offsetPage: 2, offsetSize: 50 });
  });

  it('rejects missing id', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_page_history', {}, client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects negative pagination args', async () => {
    const { client } = ctx();
    const err = await dispatchTool(
      'wiki_page_history',
      { id: 1, offsetPage: -1 },
      client,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates AuthExpiredError', async () => {
    const { mock, client } = ctx();
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await dispatchTool('wiki_page_history', { id: 1 }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('returns isError content for a generic GraphQL error', async () => {
    const { mock, client } = ctx();
    mock.setNext({ errors: [{ message: 'History engine unavailable' }] });
    const result = await dispatchTool('wiki_page_history', { id: 1 }, client);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/History engine unavailable/);
  });
});
