import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { TokenStore } from '../../src/util/token-store.js';
import { WikiClient } from '../../src/wiki/client.js';
import type {
  CreatedPageSummary,
  Page,
  PageHistoryEntry,
  PageTreeItem,
  ResponseStatus,
} from '../../src/wiki/queries.js';
import {
  startMockGraphQLServer,
  type MockGraphQLServer,
} from '../mock/graphql-server.js';

// End-to-end tests for each of the seven v1 tools via the real MCP
// `Server` + `Client` over an in-process linked transport pair. The point
// is not to re-test per-tool logic — that's covered in test/tools/<name>.test.ts
// — but to exercise the SDK serialization layer for every tool exactly once.
// If a tool ever produced output the SDK couldn't serialize (circular ref,
// BigInt, function, etc.), one of these would catch it.

const seedJwt =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlMmUiLCJzY29wZSI6InQifQ.signaturesignaturesignature';

type Harness = {
  mock: MockGraphQLServer;
  mcpClient: Client;
  store: TokenStore;
  teardown: () => Promise<void>;
};

async function startHarness(): Promise<Harness> {
  const mock = await startMockGraphQLServer();
  const store = TokenStore.inMemory(mock.url, seedJwt);
  const wikiClient = new WikiClient({ tokenStore: store });
  const { server } = buildServer({ client: wikiClient });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client(
    { name: 'e2e-test', version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);

  return {
    mock,
    mcpClient,
    store,
    teardown: async () => {
      await mcpClient.close();
      await server.close();
      await mock.close();
    },
  };
}

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.teardown();
});

const okStatus = (): ResponseStatus => ({
  succeeded: true,
  errorCode: 0,
  slug: 'ok',
  message: 'ok',
});

const samplePage = (): Page => ({
  id: 1,
  path: 'home',
  hash: 'h',
  title: 'Home',
  description: '',
  isPrivate: false,
  isPublished: true,
  privateNS: null,
  publishStartDate: '2026-05-19T00:00:00Z',
  publishEndDate: '2099-01-01T00:00:00Z',
  tags: [],
  content: 'hi',
  render: null,
  contentType: 'markdown',
  createdAt: '2026-05-19T00:00:00Z',
  updatedAt: '2026-05-19T00:00:00Z',
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
});

const createdSummary = (): CreatedPageSummary => ({
  id: 100,
  path: 'home',
  title: 'Home',
  isPrivate: false,
  isPublished: true,
  createdAt: '2026-05-19T00:00:00Z',
  updatedAt: '2026-05-19T00:00:00Z',
});

const treeNode = (): PageTreeItem => ({
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
});

const historyEntry = (): PageHistoryEntry => ({
  versionId: 1,
  versionDate: '2026-05-19T00:00:00Z',
  authorId: 7,
  authorName: 'A',
  actionType: 'updated',
  valueBefore: null,
  valueAfter: null,
});

// Pull the first text content block out of a callTool result and JSON-parse it.
function parseTextResult(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  expect(Array.isArray(r.content)).toBe(true);
  const block = r.content?.[0];
  expect(block?.type).toBe('text');
  return JSON.parse(block?.text ?? '');
}

describe('MCP end-to-end — one happy-path round trip per tool', () => {
  it('wiki_pages_tree', async () => {
    h.mock.replyToTreeQuery([treeNode()]);
    const result = await h.mcpClient.callTool({ name: 'wiki_pages_tree', arguments: {} });
    const data = parseTextResult(result) as { tree: Array<{ id: number }> };
    expect(data.tree[0]?.id).toBe(1);
  });

  it('wiki_page_get (by id)', async () => {
    h.mock.replyToSinglePage(samplePage());
    const result = await h.mcpClient.callTool({
      name: 'wiki_page_get',
      arguments: { id: 1 },
    });
    const data = parseTextResult(result) as { page: { id: number } };
    expect(data.page.id).toBe(1);
  });

  it('wiki_page_get (by path)', async () => {
    h.mock.replyToSinglePageByPath(samplePage());
    const result = await h.mcpClient.callTool({
      name: 'wiki_page_get',
      arguments: { path: 'home' },
    });
    const data = parseTextResult(result) as { page: { id: number } };
    expect(data.page.id).toBe(1);
  });

  it('wiki_page_create', async () => {
    h.mock.replyToCreatePage({ responseResult: okStatus(), page: createdSummary() });
    const result = await h.mcpClient.callTool({
      name: 'wiki_page_create',
      arguments: { path: 'home', title: 'Home', content: 'hi' },
    });
    const data = parseTextResult(result) as {
      responseResult: { succeeded: boolean };
      page: { id: number };
    };
    expect(data.responseResult.succeeded).toBe(true);
    expect(data.page.id).toBe(100);
  });

  it('wiki_page_update', async () => {
    // fetch-merge-update is two GraphQL round-trips: pages.single then
    // pages.update. The mock returns the same payload for both; including
    // both response keys lets each call extract what it needs.
    h.mock.setNext({
      data: {
        pages: {
          single: samplePage(),
          update: { responseResult: okStatus(), page: createdSummary() },
        },
      },
    });
    const result = await h.mcpClient.callTool({
      name: 'wiki_page_update',
      arguments: { id: 100, title: 'Updated' },
    });
    const data = parseTextResult(result) as { responseResult: { succeeded: boolean } };
    expect(data.responseResult.succeeded).toBe(true);
    // Confirm both round-trips actually happened.
    expect(h.mock.requestCount()).toBe(2);
  });

  it('wiki_search', async () => {
    h.mock.replyToSearch({
      results: [{ id: '1', title: 't', description: '', path: 'home', locale: 'en' }],
      suggestions: [],
      totalHits: 1,
    });
    const result = await h.mcpClient.callTool({
      name: 'wiki_search',
      arguments: { query: 't' },
    });
    const data = parseTextResult(result) as { totalHits: number };
    expect(data.totalHits).toBe(1);
  });

  it('wiki_tags_list', async () => {
    h.mock.replyToTagsList([
      {
        id: 1,
        tag: 'guide',
        title: 'Guide',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    ]);
    const result = await h.mcpClient.callTool({ name: 'wiki_tags_list', arguments: {} });
    const data = parseTextResult(result) as { tags: Array<{ tag: string }> };
    expect(data.tags[0]?.tag).toBe('guide');
  });

  it('wiki_page_history', async () => {
    h.mock.replyToHistory({ trail: [historyEntry()], total: 1 });
    const result = await h.mcpClient.callTool({
      name: 'wiki_page_history',
      arguments: { id: 1 },
    });
    const data = parseTextResult(result) as { total: number };
    expect(data.total).toBe(1);
  });
});

describe('MCP end-to-end — error serialization (6b three-tier)', () => {
  it('GraphQLError → isError content (call resolves, does NOT reject)', async () => {
    // Phase 6b: tool-execution errors return `{ isError: true, content: [...] }`
    // rather than throwing as JSON-RPC errors. The agent gets structured
    // { code, message } JSON in a text block — same format as happy-path
    // output, with isError as the discriminator. The call itself does not
    // reject. AuthExpiredError still throws McpError (handled separately
    // below) since re-bootstrap is the only fix.
    h.mock.setNext({ errors: [{ message: 'upstream barf' }] });
    const result = (await h.mcpClient.callTool({
      name: 'wiki_tags_list',
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      code: string;
      message: string;
    };
    expect(body.code).toBe('graphql');
    expect(body.message).toContain('upstream barf');
  });

  it('AuthExpiredError still throws McpError (re-bootstrap is the only fix)', async () => {
    h.mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const err = await h.mcpClient
      .callTool({ name: 'wiki_tags_list', arguments: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/JWT rejected|validate/i);
  });
});

describe('MCP end-to-end — JWT refresh integration (5c)', () => {
  it('a new-jwt response header updates the TokenStore mid-tool-call', async () => {
    const fresh = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWZyZXNoZWQifQ.fresh-signature-1';
    h.mock.replyToTagsList([], { newJwt: fresh });
    expect(h.store.getToken()).toBe(seedJwt);
    await h.mcpClient.callTool({ name: 'wiki_tags_list', arguments: {} });
    expect(h.store.getToken()).toBe(fresh);
  });

  it('two sequential tool calls — the second one uses the refreshed token', async () => {
    // Call 1: returns a refresh. Mock records its incoming auth header.
    const fresh = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWZyZXNoIn0.fresh-signature-2';
    h.mock.replyToTagsList([], { newJwt: fresh });
    await h.mcpClient.callTool({ name: 'wiki_tags_list', arguments: {} });
    expect(h.mock.lastRequest()?.authorization).toBe(`Bearer ${seedJwt}`);
    expect(h.store.getToken()).toBe(fresh);

    // Call 2: no further refresh. Mock should now see `Bearer ${fresh}`.
    h.mock.replyToTagsList([]);
    await h.mcpClient.callTool({ name: 'wiki_tags_list', arguments: {} });
    expect(h.mock.lastRequest()?.authorization).toBe(`Bearer ${fresh}`);
    // Token unchanged since the second response had no new-jwt.
    expect(h.store.getToken()).toBe(fresh);
  });
});
