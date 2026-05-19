import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/tools/index.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

describe('wiki_tags_list', () => {
  it('returns tags array on happy path', async () => {
    const { mock, client } = ctx();
    mock.replyToTagsList([
      {
        id: 1,
        tag: 'guide',
        title: 'Guide',
        createdAt: '2026-05-18T00:00:00Z',
        updatedAt: '2026-05-18T00:00:00Z',
      },
    ]);
    const result = await dispatchTool('wiki_tags_list', {}, client);
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
      tags: Array<{ tag: string }>;
    };
    expect(parsed.tags).toHaveLength(1);
    expect(parsed.tags[0]?.tag).toBe('guide');
  });

  it('rejects unexpected input keys (strict)', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_tags_list', { unexpected: true }, client).catch(
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
    const err = await dispatchTool('wiki_tags_list', {}, client).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('returns isError content for a generic GraphQL error', async () => {
    const { mock, client } = ctx();
    mock.setNext({ errors: [{ message: 'Internal server error' }] });
    const result = await dispatchTool('wiki_tags_list', {}, client);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/Internal server error/);
  });
});
