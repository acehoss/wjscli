import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { writeConfig } from '../../src/config.js';
import {
  startMockGraphQLServer,
  type MockGraphQLServer,
} from '../mock/graphql-server.js';

const seedJwt =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGkifQ.signaturesignaturesignaturesig';

let tmpRoot: string;
let mock: MockGraphQLServer;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

async function seedConfig(): Promise<void> {
  await writeConfig({
    baseUrl: mock.url,
    jwt: seedJwt,
    refreshedAt: '2026-05-19T00:00:00.000Z',
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wjscli-cli-'));
  savedEnv.WJSCLI_CONFIG_DIR = process.env.WJSCLI_CONFIG_DIR;
  process.env.WJSCLI_CONFIG_DIR = tmpRoot;
  mock = await startMockGraphQLServer();
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await mock.close();
  if (savedEnv.WJSCLI_CONFIG_DIR === undefined) {
    delete process.env.WJSCLI_CONFIG_DIR;
  } else {
    process.env.WJSCLI_CONFIG_DIR = savedEnv.WJSCLI_CONFIG_DIR;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const stdoutText = (): string => stdoutChunks.join('');
const stderrText = (): string => stderrChunks.join('');

describe('runCli — usage', () => {
  it('exits 2 with no command after the URL', async () => {
    expect(await runCli(mock.url, [])).toBe(2);
    expect(stderrText()).toContain('Commands:');
  });

  it('exits 2 with an unknown command', async () => {
    expect(await runCli(mock.url, ['page', 'nope'])).toBe(2);
    expect(stderrText()).toContain('unknown command');
  });

  it('exits 2 on a malformed URL', async () => {
    expect(await runCli('not a url', ['tags', 'list'])).toBe(2);
  });
});

describe('runCli — per-command help flag', () => {
  // Help is a user request → stdout, exit 0. No config required.
  it('pages tree -h prints command-specific usage', async () => {
    expect(await runCli(mock.url, ['pages', 'tree', '-h'])).toBe(0);
    expect(stdoutText()).toContain('wjscli <base-url> pages tree');
    expect(stdoutText()).toContain('--depth');
  });

  it('page get --help describes the id-or-path positional', async () => {
    expect(await runCli(mock.url, ['page', 'get', '--help'])).toBe(0);
    expect(stdoutText()).toContain('wjscli <base-url> page get');
    expect(stdoutText()).toContain('id-or-path');
  });

  it('--help interleaved with other args still triggers help (no validation)', async () => {
    // No config seeded; we'd normally exit 1 on missing config. Help short-
    // circuits before that path even runs.
    expect(
      await runCli(mock.url, ['page', 'update', '42', '-h']),
    ).toBe(0);
    expect(stdoutText()).toContain('wjscli <base-url> page update');
  });

  it('tags list --help', async () => {
    expect(await runCli(mock.url, ['tags', 'list', '--help'])).toBe(0);
    expect(stdoutText()).toContain('wjscli <base-url> tags list');
  });
});

describe('runCli — missing config', () => {
  it('exits 1 with a hint to run validate', async () => {
    expect(await runCli(mock.url, ['tags', 'list'])).toBe(1);
    expect(stderrText()).toContain('wjscli');
    expect(stderrText()).toContain('validate');
  });
});

describe('runCli — tags list (happy path)', () => {
  beforeEach(seedConfig);

  it('renders human output by default', async () => {
    mock.replyToTagsList([
      {
        id: 1,
        tag: 'guide',
        title: 'Guide',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
      {
        id: 2,
        tag: 'spec',
        title: 'Spec',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    ]);
    expect(await runCli(mock.url, ['tags', 'list'])).toBe(0);
    expect(stdoutText()).toContain('guide');
    expect(stdoutText()).toContain('spec');
  });

  it('renders raw JSON with --json', async () => {
    mock.replyToTagsList([
      {
        id: 1,
        tag: 'guide',
        title: 'Guide',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    ]);
    expect(await runCli(mock.url, ['tags', 'list', '--json'])).toBe(0);
    const out = JSON.parse(stdoutText()) as { tags: Array<{ tag: string }> };
    expect(out.tags[0]?.tag).toBe('guide');
  });
});

describe('runCli — pages tree', () => {
  beforeEach(seedConfig);

  it('renders a single-level tree with box-drawing connectors', async () => {
    mock.replyToTreeQuery([
      {
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
      },
      {
        id: 2,
        path: 'about',
        depth: 1,
        title: 'About',
        isPrivate: false,
        isFolder: false,
        privateNS: null,
        parent: 0,
        pageId: 2,
        locale: 'en',
      },
    ]);
    expect(await runCli(mock.url, ['pages', 'tree'])).toBe(0);
    const out = stdoutText();
    // First sibling gets ├──; last gets └──.
    expect(out).toMatch(/^├── \[1\] Home/m);
    expect(out).toMatch(/^└── \[2\] About/m);
  });

  it('with --depth recurses and indents children under their parent', async () => {
    mock.setDispatcher((req) => {
      const variables = (req.parsed?.variables ?? {}) as { parent?: number };
      const parent = variables.parent ?? -1;
      if (parent === 0) {
        return {
          data: {
            pages: {
              tree: [
                {
                  id: 1,
                  path: 'docs',
                  depth: 1,
                  title: 'Docs',
                  isPrivate: false,
                  isFolder: true,
                  privateNS: null,
                  parent: 0,
                  pageId: null,
                  locale: 'en',
                },
                {
                  id: 2,
                  path: 'about',
                  depth: 1,
                  title: 'About',
                  isPrivate: false,
                  isFolder: false,
                  privateNS: null,
                  parent: 0,
                  pageId: 2,
                  locale: 'en',
                },
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
                {
                  id: 11,
                  path: 'docs/setup',
                  depth: 2,
                  title: 'Setup',
                  isPrivate: false,
                  isFolder: false,
                  privateNS: null,
                  parent: 1,
                  pageId: 11,
                  locale: 'en',
                },
                {
                  id: 12,
                  path: 'docs/api',
                  depth: 2,
                  title: 'API',
                  isPrivate: false,
                  isFolder: false,
                  privateNS: null,
                  parent: 1,
                  pageId: 12,
                  locale: 'en',
                },
              ],
            },
          },
        };
      }
      return { data: { pages: { tree: [] } } };
    });
    expect(await runCli(mock.url, ['pages', 'tree', '--depth', '2'])).toBe(0);
    const out = stdoutText();
    // Docs folder gets ├── (first of two top-level) and trailing slash for folder.
    expect(out).toMatch(/^├── \[1\] Docs\//m);
    // Children of Docs are nested under it with │   prefix because Docs is
    // not the last top-level sibling.
    expect(out).toMatch(/^│   ├── \[11\] Setup/m);
    expect(out).toMatch(/^│   └── \[12\] API/m);
    // About is the last top-level sibling → └──.
    expect(out).toMatch(/^└── \[2\] About/m);
  });

  it('renders (empty) when the tree is empty', async () => {
    mock.replyToTreeQuery([]);
    expect(await runCli(mock.url, ['pages', 'tree'])).toBe(0);
    expect(stdoutText()).toContain('(empty)');
  });

  it('rejects an invalid --mode', async () => {
    expect(await runCli(mock.url, ['pages', 'tree', '--mode', 'BOGUS'])).toBe(2);
    expect(stderrText()).toContain('--mode must be');
  });

  it('rejects --depth 0', async () => {
    expect(await runCli(mock.url, ['pages', 'tree', '--depth', '0'])).toBe(2);
    expect(stderrText()).toContain('--depth must be');
  });
});

describe('runCli — page get', () => {
  beforeEach(seedConfig);

  const samplePage = {
    id: 1,
    path: 'home',
    hash: 'h',
    title: 'Home',
    description: 'desc',
    isPrivate: false,
    isPublished: true,
    privateNS: null,
    publishStartDate: '2026-05-19T00:00:00Z',
    publishEndDate: '2099-01-01T00:00:00Z',
    tags: [],
    content: 'hello',
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
  };

  it('requires a positional id-or-path', async () => {
    expect(await runCli(mock.url, ['page', 'get'])).toBe(2);
    expect(stderrText()).toContain('id or path');
  });

  it('rejects legacy --id with a migration hint', async () => {
    expect(await runCli(mock.url, ['page', 'get', '--id', '42'])).toBe(2);
    expect(stderrText()).toContain('no longer accepted');
  });

  it('rejects legacy --path with a migration hint', async () => {
    expect(await runCli(mock.url, ['page', 'get', '--path', 'home'])).toBe(2);
    expect(stderrText()).toContain('no longer accepted');
  });

  it('numeric positional → page get by id', async () => {
    mock.replyToSinglePage(samplePage);
    expect(await runCli(mock.url, ['page', 'get', '1'])).toBe(0);
    expect(stdoutText()).toContain('title: Home');
    expect(stdoutText()).toContain('hello');
    // Verify the GraphQL call used the by-id query (not by-path).
    const body = mock.lastRequest()?.parsed as
      | { query?: string; variables?: Record<string, unknown> }
      | null;
    expect(body?.variables).toMatchObject({ id: 1 });
  });

  it('non-numeric positional → page get by path', async () => {
    mock.replyToSinglePageByPath(samplePage);
    expect(await runCli(mock.url, ['page', 'get', 'home'])).toBe(0);
    expect(stdoutText()).toContain('title: Home');
    const body = mock.lastRequest()?.parsed as
      | { query?: string; variables?: Record<string, unknown> }
      | null;
    expect(body?.variables).toMatchObject({ path: 'home', locale: 'en' });
  });

  it('path with slash → page get by path', async () => {
    mock.replyToSinglePageByPath(samplePage);
    expect(await runCli(mock.url, ['page', 'get', 'team/onboarding'])).toBe(0);
    const body = mock.lastRequest()?.parsed as
      | { query?: string; variables?: Record<string, unknown> }
      | null;
    expect(body?.variables).toMatchObject({ path: 'team/onboarding' });
  });

  it('--locale is forwarded with path-based lookup', async () => {
    mock.replyToSinglePageByPath(samplePage);
    expect(
      await runCli(mock.url, ['page', 'get', 'team/onboarding', '--locale', 'fr']),
    ).toBe(0);
    const body = mock.lastRequest()?.parsed as
      | { query?: string; variables?: Record<string, unknown> }
      | null;
    expect(body?.variables).toMatchObject({
      path: 'team/onboarding',
      locale: 'fr',
    });
  });
});

describe('runCli — page update', () => {
  beforeEach(seedConfig);

  const okResponse = {
    data: {
      pages: {
        update: {
          responseResult: {
            succeeded: true,
            errorCode: 0,
            slug: 'ok',
            message: 'OK',
          },
          page: {
            id: 42,
            path: 'home',
            title: 'Home',
            isPrivate: false,
            isPublished: true,
            createdAt: '2026-05-19T00:00:00Z',
            updatedAt: '2026-05-19T00:00:00Z',
          },
        },
      },
    },
  };

  const fullPageForFetch = {
    id: 42,
    path: 'home',
    hash: 'h',
    title: 'Home',
    description: 'desc',
    isPrivate: false,
    isPublished: true,
    privateNS: null,
    publishStartDate: '2026-05-19T00:00:00Z',
    publishEndDate: '2099-01-01T00:00:00Z',
    tags: [],
    content: 'old',
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
  };

  it('rejects legacy --id with a migration hint', async () => {
    expect(
      await runCli(mock.url, ['page', 'update', '--id', '42', '--title', 'X']),
    ).toBe(2);
    expect(stderrText()).toContain('no longer accepted');
  });

  it('requires a positional and at least one mutable field', async () => {
    expect(await runCli(mock.url, ['page', 'update'])).toBe(2);
    expect(stderrText()).toContain('id or path');
  });

  it('numeric positional → fetch-by-id then update', async () => {
    // First call: PAGE_SINGLE_QUERY (id-based fetch from update tool's
    // fetch-merge-update). Second call: the update mutation.
    let call = 0;
    mock.setDispatcher(() => {
      call += 1;
      if (call === 1) return { data: { pages: { single: fullPageForFetch } } };
      return okResponse;
    });
    expect(
      await runCli(mock.url, ['page', 'update', '42', '--title', 'New']),
    ).toBe(0);
    expect(stdoutText()).toContain('✓');
    expect(call).toBe(2); // no path-resolution step
  });

  it('path positional → resolve via singleByPath, then update', async () => {
    // Three calls: (1) CLI resolveInput → pages.singleByPath; (2) tool's
    // fetch-merge-update → pages.single by the resolved id; (3) update.
    let call = 0;
    mock.setDispatcher(() => {
      call += 1;
      if (call === 1) return { data: { pages: { singleByPath: { id: 42 } } } };
      if (call === 2) return { data: { pages: { single: fullPageForFetch } } };
      return okResponse;
    });
    expect(
      await runCli(mock.url, ['page', 'update', 'home', '--title', 'New']),
    ).toBe(0);
    expect(stdoutText()).toContain('✓');
    expect(call).toBe(3);
  });

  it('path not found → exit 1 with friendly message', async () => {
    mock.setDispatcher(() => ({
      data: { pages: { singleByPath: null } },
    }));
    expect(
      await runCli(mock.url, ['page', 'update', 'nope/page', '--title', 'X']),
    ).toBe(1);
    expect(stderrText()).toContain('Page not found at path');
  });

  it('--path still renames the page (new path, not the lookup)', async () => {
    let call = 0;
    let updateVariables: Record<string, unknown> | null = null;
    mock.setDispatcher((req) => {
      call += 1;
      if (call === 1) return { data: { pages: { single: fullPageForFetch } } };
      updateVariables =
        ((req.parsed?.variables as Record<string, unknown>) ?? null) as
          | Record<string, unknown>
          | null;
      return okResponse;
    });
    expect(
      await runCli(mock.url, ['page', 'update', '42', '--path', 'home/renamed']),
    ).toBe(0);
    expect(updateVariables).not.toBeNull();
    expect(updateVariables).toMatchObject({ id: 42, path: 'home/renamed' });
  });
});

describe('runCli — page history', () => {
  beforeEach(seedConfig);

  const historyResponse = {
    data: {
      pages: {
        history: {
          trail: [
            {
              versionId: 1,
              versionDate: '2026-05-19T00:00:00Z',
              authorId: 7,
              authorName: 'A',
              actionType: 'updated',
              valueBefore: null,
              valueAfter: null,
            },
          ],
          total: 1,
        },
      },
    },
  };

  it('rejects legacy --id', async () => {
    expect(
      await runCli(mock.url, ['page', 'history', '--id', '42']),
    ).toBe(2);
    expect(stderrText()).toContain('no longer accepted');
  });

  it('numeric positional → direct history call', async () => {
    let call = 0;
    let lastVariables: Record<string, unknown> | null = null;
    mock.setDispatcher((req) => {
      call += 1;
      lastVariables = (req.parsed?.variables as Record<string, unknown>) ?? null;
      return historyResponse;
    });
    expect(await runCli(mock.url, ['page', 'history', '42'])).toBe(0);
    expect(call).toBe(1);
    expect(lastVariables).toMatchObject({ id: 42 });
    expect(stdoutText()).toContain('total: 1');
  });

  it('path positional → singleByPath lookup, then history', async () => {
    let call = 0;
    let lastVariables: Record<string, unknown> | null = null;
    mock.setDispatcher((req) => {
      call += 1;
      lastVariables = (req.parsed?.variables as Record<string, unknown>) ?? null;
      if (call === 1) return { data: { pages: { singleByPath: { id: 99 } } } };
      return historyResponse;
    });
    expect(
      await runCli(mock.url, ['page', 'history', 'team/onboarding']),
    ).toBe(0);
    expect(call).toBe(2);
    // Last call (the history call) used the resolved id.
    expect(lastVariables).toMatchObject({ id: 99 });
  });

  it('--locale is used for the path lookup', async () => {
    let firstVariables: Record<string, unknown> | null = null;
    let call = 0;
    mock.setDispatcher((req) => {
      call += 1;
      if (call === 1) {
        firstVariables = (req.parsed?.variables as Record<string, unknown>) ?? null;
        return { data: { pages: { singleByPath: { id: 99 } } } };
      }
      return historyResponse;
    });
    expect(
      await runCli(mock.url, ['page', 'history', 'team/x', '--locale', 'fr']),
    ).toBe(0);
    expect(firstVariables).toMatchObject({ path: 'team/x', locale: 'fr' });
  });
});

describe('runCli — page create', () => {
  beforeEach(seedConfig);

  it('rejects when --path/--title/--content missing', async () => {
    expect(await runCli(mock.url, ['page', 'create'])).toBe(2);
  });

  it('creates a page with required fields', async () => {
    mock.replyToCreatePage({
      responseResult: { succeeded: true, errorCode: 0, slug: 'ok', message: 'OK' },
      page: {
        id: 42,
        path: 'foo/bar',
        title: 'Bar',
        isPrivate: false,
        isPublished: true,
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
      },
    });
    expect(
      await runCli(mock.url, [
        'page',
        'create',
        '--path',
        'foo/bar',
        '--title',
        'Bar',
        '--content',
        'hello',
      ]),
    ).toBe(0);
    expect(stdoutText()).toContain('✓');
    expect(stdoutText()).toContain('id: 42');
  });
});

describe('runCli — search', () => {
  beforeEach(seedConfig);

  it('requires a query positional', async () => {
    expect(await runCli(mock.url, ['search'])).toBe(2);
    expect(stderrText()).toContain('query');
  });

  it('renders results with totalHits', async () => {
    mock.replyToSearch({
      results: [
        { id: '1', title: 'Found', description: '', path: 'foo/bar', locale: 'en' },
      ],
      suggestions: [],
      totalHits: 1,
    });
    expect(await runCli(mock.url, ['search', 'needle'])).toBe(0);
    expect(stdoutText()).toContain('totalHits: 1');
    expect(stdoutText()).toContain('Found');
  });
});

describe('runCli — tool execution error', () => {
  beforeEach(seedConfig);

  it('surfaces a non-auth GraphQL error to stderr, exits 1', async () => {
    mock.setNext({ errors: [{ message: 'upstream barf' }] });
    expect(await runCli(mock.url, ['tags', 'list'])).toBe(1);
    expect(stderrText()).toContain('upstream barf');
    expect(stderrText()).toContain('graphql');
  });

  it('surfaces auth-expired as exit 1 with re-validate hint', async () => {
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    expect(await runCli(mock.url, ['tags', 'list'])).toBe(1);
    expect(stderrText()).toContain('JWT');
  });
});
