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

  it('renders a tree with an indented prefix per depth', async () => {
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
        path: 'home/child',
        depth: 2,
        title: 'Child',
        isPrivate: false,
        isFolder: false,
        privateNS: null,
        parent: 1,
        pageId: 2,
        locale: 'en',
      },
    ]);
    expect(await runCli(mock.url, ['pages', 'tree'])).toBe(0);
    expect(stdoutText()).toMatch(/- \[1\] Home/);
    expect(stdoutText()).toMatch(/  - \[2\] Child/);
  });

  it('rejects an invalid --mode', async () => {
    expect(await runCli(mock.url, ['pages', 'tree', '--mode', 'BOGUS'])).toBe(2);
    expect(stderrText()).toContain('--mode must be');
  });
});

describe('runCli — page get', () => {
  beforeEach(seedConfig);

  it('requires exactly one of --id / --path', async () => {
    expect(await runCli(mock.url, ['page', 'get'])).toBe(2);
    expect(stderrText()).toContain('exactly one of --id or --path');
  });

  it('rejects both --id and --path', async () => {
    expect(
      await runCli(mock.url, ['page', 'get', '--id', '1', '--path', 'home']),
    ).toBe(2);
  });

  it('fetches by --id and renders human output', async () => {
    mock.replyToSinglePage({
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
    });
    expect(await runCli(mock.url, ['page', 'get', '--id', '1'])).toBe(0);
    expect(stdoutText()).toContain('title: Home');
    expect(stdoutText()).toContain('--- content ---');
    expect(stdoutText()).toContain('hello');
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
