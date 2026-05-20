import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { dispatchTool } from '../../src/tools/index.js';
import type { PageTreeItem } from '../../src/wiki/queries.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

const treeItem = (over: Partial<PageTreeItem> = {}): PageTreeItem => ({
  id: 1,
  path: 'home',
  depth: 1,
  title: 'Home',
  isPrivate: false,
  isFolder: false,
  privateNS: null,
  parent: 0,
  pageId: 1,
  locale: 'en',
  ...over,
});

describe('wiki_pages_tree', () => {
  it('returns tree array as JSON text on happy path', async () => {
    const { mock, client } = ctx();
    mock.replyToTreeQuery([
      treeItem(),
      treeItem({ id: 2, path: 'docs', title: 'Docs' }),
    ]);
    const result = await dispatchTool('wiki_pages_tree', {}, client);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as { tree: Array<{ id: number }> };
    expect(parsed.tree).toHaveLength(2);
    expect(parsed.tree[0]?.id).toBe(1);
  });

  it('applies defaults (parent=0, mode=ALL, locale=en)', async () => {
    const { mock, client } = ctx();
    mock.replyToTreeQuery([]);
    await dispatchTool('wiki_pages_tree', {}, client);
    const body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({ parent: 0, mode: 'ALL', locale: 'en' });
  });

  it('forwards explicit parent/mode/locale', async () => {
    const { mock, client } = ctx();
    mock.replyToTreeQuery([]);
    await dispatchTool('wiki_pages_tree', { parent: 5, mode: 'FOLDERS', locale: 'fr' }, client);
    const body = mock.lastRequest()?.parsed as { variables?: Record<string, unknown> } | null;
    expect(body?.variables).toEqual({ parent: 5, mode: 'FOLDERS', locale: 'fr' });
  });

  it('rejects an invalid mode with InvalidParams', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_pages_tree', { mode: 'NOPE' }, client).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('propagates AuthExpiredError as McpError(InvalidRequest)', async () => {
    const { mock, client } = ctx();
    // Error-envelope path stays on raw setNext — replyTo* is for data envelopes.
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await dispatchTool('wiki_pages_tree', {}, client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidRequest });
    expect((err as McpError).message).toMatch(/JWT|bootstrap/i);
  });

  it('returns isError content for a generic GraphQL error (not InvalidRequest)', async () => {
    const { mock, client } = ctx();
    mock.setNext({ errors: [{ message: 'Search engine offline' }] });
    const result = await dispatchTool('wiki_pages_tree', {}, client);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toMatch(/Search engine offline/);
  });

  describe('depth > 1 (recursive fetch)', () => {
    it('rejects depth < 1 with InvalidParams', async () => {
      const { client } = ctx();
      const err = await dispatchTool('wiki_pages_tree', { depth: 0 }, client).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
    });

    it('depth=1 issues exactly one query (backward compat)', async () => {
      const { mock, client } = ctx();
      mock.replyToTreeQuery([
        treeItem({ id: 1, parent: 0, depth: 1, isFolder: true, title: 'Docs' }),
      ]);
      await dispatchTool('wiki_pages_tree', { depth: 1 }, client);
      expect(mock.requestCount()).toBe(1);
    });

    it('depth=2 fetches each top-level node\'s subtree in a follow-up query', async () => {
      const { mock, client } = ctx();
      // Per-request dispatcher: respond to each parent variable separately.
      mock.setDispatcher((req) => {
        const variables = (req.parsed?.variables ?? {}) as { parent?: number };
        const parent = variables.parent ?? -1;
        if (parent === 0) {
          return {
            data: {
              pages: {
                tree: [
                  treeItem({ id: 1, parent: 0, depth: 1, isFolder: true, title: 'Docs' }),
                  treeItem({ id: 2, parent: 0, depth: 1, title: 'About' }),
                ],
              },
            },
          };
        }
        if (parent === 1) {
          return {
            data: {
              pages: {
                tree: [
                  treeItem({ id: 11, parent: 1, depth: 2, path: 'docs/setup', title: 'Setup' }),
                  treeItem({ id: 12, parent: 1, depth: 2, path: 'docs/api', title: 'API' }),
                ],
              },
            },
          };
        }
        if (parent === 2) {
          return { data: { pages: { tree: [] } } };
        }
        return null;
      });

      const result = await dispatchTool('wiki_pages_tree', { depth: 2 }, client);
      // 3 requests: root + each of the two top-level children.
      expect(mock.requestCount()).toBe(3);

      const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
        tree: Array<{ id: number; parent: number }>;
      };
      // DFS order: Docs (1), its kids (11, 12), then About (2).
      expect(parsed.tree.map((n) => n.id)).toEqual([1, 11, 12, 2]);
    });

    it('depth=3 walks three levels deep', async () => {
      const { mock, client } = ctx();
      mock.setDispatcher((req) => {
        const variables = (req.parsed?.variables ?? {}) as { parent?: number };
        const parent = variables.parent ?? -1;
        if (parent === 0) {
          return {
            data: { pages: { tree: [treeItem({ id: 1, parent: 0, depth: 1, isFolder: true })] } },
          };
        }
        if (parent === 1) {
          return {
            data: { pages: { tree: [treeItem({ id: 2, parent: 1, depth: 2, isFolder: true })] } },
          };
        }
        if (parent === 2) {
          return {
            data: { pages: { tree: [treeItem({ id: 3, parent: 2, depth: 3 })] } },
          };
        }
        return { data: { pages: { tree: [] } } };
      });
      const result = await dispatchTool('wiki_pages_tree', { depth: 3 }, client);
      const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
        tree: Array<{ id: number }>;
      };
      expect(parsed.tree.map((n) => n.id)).toEqual([1, 2, 3]);
    });

    it('does NOT issue follow-up queries on an empty top-level tree', async () => {
      const { mock, client } = ctx();
      mock.replyToTreeQuery([]);
      await dispatchTool('wiki_pages_tree', { depth: 5 }, client);
      expect(mock.requestCount()).toBe(1);
    });
  });
});
