import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../../src/config.js';
import { runClone } from '../../src/sync/clone.js';
import {
  contentHash,
  deserializePage,
  serializePage,
} from '../../src/sync/format.js';
import { runPull } from '../../src/sync/pull.js';
import { runPush } from '../../src/sync/push.js';
import { computeStatus } from '../../src/sync/status.js';
import { readIndex, loadRepo } from '../../src/sync/repo.js';
import type {
  Page,
  PageTag,
  PageTreeItem,
  ResponseStatus,
} from '../../src/wiki/queries.js';
import {
  startMockGraphQLServer,
  type MockGraphQLServer,
} from '../mock/graphql-server.js';

// JWT shape isn't validated by the mock; we just need something
// `validate`-shaped on disk so TokenStore.loadForBaseUrl succeeds.
const seedJwt =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW5jIn0.signatureplaceholderforsync';

const RR_OK: ResponseStatus = {
  succeeded: true,
  errorCode: 0,
  slug: 'ok',
  message: 'OK',
};

let tmpRoot: string;       // temp dir we put both the wjscli config and the clone in
let cloneDir: string;
let configDir: string;
let mock: MockGraphQLServer;
const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wjscli-sync-e2e-'));
  configDir = path.join(tmpRoot, 'cfg');
  cloneDir = path.join(tmpRoot, 'clone');
  await fs.mkdir(configDir, { recursive: true });
  savedEnv.WJSCLI_CONFIG_DIR = process.env.WJSCLI_CONFIG_DIR;
  process.env.WJSCLI_CONFIG_DIR = configDir;
  mock = await startMockGraphQLServer();
  await writeConfig({
    baseUrl: mock.url,
    jwt: seedJwt,
    refreshedAt: '2026-05-19T00:00:00.000Z',
  });

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

// Fixture builders -----------------------------------------------------

function tag(t: Partial<PageTag> = {}): PageTag {
  return {
    id: 1,
    tag: 'guide',
    title: 'Guide',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...t,
  };
}

function makePage(over: Partial<Page>): Page {
  return {
    id: 1,
    path: 'home',
    hash: 'h',
    title: 'Home',
    description: '',
    isPrivate: false,
    isPublished: true,
    privateNS: null,
    publishStartDate: '',
    publishEndDate: '',
    tags: [],
    content: '# Home\n\nWelcome.',
    render: null,
    contentType: 'markdown',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
    editor: 'markdown',
    locale: 'en',
    scriptCss: null,
    scriptJs: null,
    authorId: 7,
    authorName: 'Aaron',
    authorEmail: 'aaron@example.com',
    creatorId: 7,
    creatorName: 'Aaron',
    creatorEmail: 'aaron@example.com',
    ...over,
  };
}

function makeTreeNode(over: Partial<PageTreeItem>): PageTreeItem {
  return {
    id: 0,
    path: '',
    depth: 1,
    title: '',
    isPrivate: false,
    isFolder: false,
    privateNS: null,
    parent: 0,
    pageId: null,
    locale: 'en',
    ...over,
  };
}

// Wire up the mock to respond as if the wiki has these pages. Tree walk
// returns one parent=0 result with all top-level pages (depth=1); per-page
// pages.single queries return the matching Page record.
function seedWiki(pages: Page[]): void {
  const byId = new Map<number, Page>(pages.map((p) => [p.id, p]));
  mock.setDispatcher((req) => {
    const query = (req.parsed?.query as string | undefined) ?? '';
    const variables = (req.parsed?.variables ?? {}) as {
      id?: number;
      parent?: number;
    };
    if (query.includes('pages {\n    tree(')) {
      if (variables.parent === 0) {
        return {
          data: {
            pages: {
              // Deliberately offset the pageTree row id from the page id
              // (id = pageId + 1000). Wiki.js really does store these in
              // separate tables, so any code that confuses them — e.g.
              // passing the tree row id to `pages.single` — fails loudly.
              tree: pages.map((p) =>
                makeTreeNode({
                  id: p.id + 1000,
                  path: p.path,
                  depth: 1,
                  title: p.title,
                  isFolder: false,
                  parent: 0,
                  pageId: p.id,
                  locale: p.locale,
                }),
              ),
            },
          },
        };
      }
      return { data: { pages: { tree: [] } } };
    }
    if (query.includes('pages {\n    single(')) {
      if (variables.id !== undefined && byId.has(variables.id)) {
        return { data: { pages: { single: byId.get(variables.id) } } };
      }
      return { data: { pages: { single: null } } };
    }
    if (query.includes('pages {\n    update(')) {
      return {
        data: {
          pages: {
            update: {
              responseResult: RR_OK,
              page: { id: variables.id, path: '', title: '', isPrivate: false, isPublished: true, createdAt: '', updatedAt: '' },
            },
          },
        },
      };
    }
    return null;
  });
}

// Tests ---------------------------------------------------------------

describe('sync clone', () => {
  it('writes a file per page + .wjscli config and index', async () => {
    seedWiki([
      makePage({ id: 1, path: 'home', title: 'Home' }),
      makePage({ id: 2, path: 'docs/setup', title: 'Setup', content: '# Setup' }),
    ]);
    const code = await runClone({ baseUrl: mock.url, targetDir: cloneDir });
    expect(code).toBe(0);

    expect(await fs.readFile(path.join(cloneDir, 'home.md'), 'utf8')).toMatch(
      /title: Home/,
    );
    const setup = await fs.readFile(
      path.join(cloneDir, 'docs', 'setup.md'),
      'utf8',
    );
    expect(setup).toContain('# Setup');

    const repo = await loadRepo(cloneDir);
    expect(repo.config.baseUrl).toBe(mock.url);
    const idx = await readIndex(repo);
    expect(idx.entries.map((e) => e.path).sort()).toEqual([
      'docs/setup',
      'home',
    ]);
    // index hash matches what's on disk.
    for (const entry of idx.entries) {
      const text = await fs.readFile(
        path.join(cloneDir, entry.file),
        'utf8',
      );
      expect(contentHash(text)).toBe(entry.hash);
    }
  });

  it('refuses to clone into a non-empty directory', async () => {
    await fs.mkdir(cloneDir, { recursive: true });
    await fs.writeFile(path.join(cloneDir, 'existing.txt'), 'hi');
    const code = await runClone({ baseUrl: mock.url, targetDir: cloneDir });
    expect(code).toBe(2);
  });
});

describe('sync status', () => {
  beforeEach(async () => {
    seedWiki([
      makePage({ id: 1, path: 'home', title: 'Home', content: '# Home' }),
      makePage({ id: 2, path: 'about', title: 'About', content: '# About' }),
    ]);
    await runClone({ baseUrl: mock.url, targetDir: cloneDir });
  });

  it('reports a clean working tree right after clone', async () => {
    const report = await computeStatus({ dir: cloneDir, withRemote: false });
    expect(report.modified).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.untracked).toEqual([]);
  });

  it('flags a locally modified file', async () => {
    const home = path.join(cloneDir, 'home.md');
    const orig = await fs.readFile(home, 'utf8');
    await fs.writeFile(home, `${orig}\n\nLocal edit.\n`);
    const report = await computeStatus({ dir: cloneDir, withRemote: false });
    expect(report.modified).toEqual(['home']);
  });

  it('flags a deleted file and an untracked file', async () => {
    await fs.unlink(path.join(cloneDir, 'about.md'));
    await fs.writeFile(path.join(cloneDir, 'scratch.md'), '# scratch');
    const report = await computeStatus({ dir: cloneDir, withRemote: false });
    expect(report.deleted).toEqual(['about']);
    expect(report.untracked).toEqual(['scratch.md']);
  });
});

describe('sync push', () => {
  beforeEach(async () => {
    seedWiki([makePage({ id: 1, path: 'home', title: 'Home' })]);
    await runClone({ baseUrl: mock.url, targetDir: cloneDir });
    // Clear the dispatcher's history-aware tracking by reseeding.
    seedWiki([makePage({ id: 1, path: 'home', title: 'Home' })]);
  });

  it('no-ops when nothing has changed locally', async () => {
    stdoutChunks.length = 0;
    const code = await runPush({
      dir: cloneDir,
      force: false,
      dryRun: false,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain('nothing to push');
  });

  it('pushes a locally modified page and updates the index hash', async () => {
    // Keep the remote `updatedAt` unchanged so the pre-push conflict check
    // (compare-and-swap against the index) succeeds. The hash on disk has
    // changed, which is what we expect push to ship.
    const home = path.join(cloneDir, 'home.md');
    const orig = await fs.readFile(home, 'utf8');
    const { frontmatter, body } = deserializePage(orig);
    const newText = serializePage({
      ...makePage({
        id: frontmatter.id,
        path: frontmatter.path,
        title: frontmatter.title,
        content: `${body}\n\nFresh edit.`,
      }),
    });
    await fs.writeFile(home, newText);

    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    const code = await runPush({
      dir: cloneDir,
      force: false,
      dryRun: false,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain('pushed: home');

    const repo = await loadRepo(cloneDir);
    const idx = await readIndex(repo);
    const entry = idx.entries.find((e) => e.id === 1);
    // Hash should match the newly-pushed file on disk now.
    const finalText = await fs.readFile(home, 'utf8');
    expect(entry?.hash).toBe(contentHash(finalText));
  });

  it('refuses to push when remote updatedAt has drifted', async () => {
    const home = path.join(cloneDir, 'home.md');
    const orig = await fs.readFile(home, 'utf8');
    await fs.writeFile(home, `${orig}\n\nLocal edit.\n`);

    // Pretend remote moved on without us.
    seedWiki([
      makePage({
        id: 1,
        path: 'home',
        title: 'Home',
        updatedAt: '2099-01-01T00:00:00Z',
      }),
    ]);

    stderrChunks.length = 0;
    const code = await runPush({
      dir: cloneDir,
      force: false,
      dryRun: false,
    });
    expect(code).toBe(1);
    expect(stderrChunks.join('')).toMatch(/remote changed/);
  });

  it('--force overrides the conflict check', async () => {
    const home = path.join(cloneDir, 'home.md');
    const orig = await fs.readFile(home, 'utf8');
    await fs.writeFile(home, `${orig}\n\nLocal edit.\n`);
    seedWiki([
      makePage({
        id: 1,
        path: 'home',
        title: 'Home',
        updatedAt: '2099-01-01T00:00:00Z',
      }),
    ]);

    stdoutChunks.length = 0;
    const code = await runPush({
      dir: cloneDir,
      force: true,
      dryRun: false,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain('pushed: home');
  });

  it('--dry-run lists changes without contacting the server for an update', async () => {
    const home = path.join(cloneDir, 'home.md');
    const orig = await fs.readFile(home, 'utf8');
    await fs.writeFile(home, `${orig}\n\nLocal edit.\n`);
    stdoutChunks.length = 0;
    const code = await runPush({
      dir: cloneDir,
      force: false,
      dryRun: true,
    });
    expect(code).toBe(0);
    expect(stdoutText()).toContain('would push: home');
  });
});

describe('sync pull', () => {
  beforeEach(async () => {
    seedWiki([
      makePage({
        id: 1,
        path: 'home',
        title: 'Home',
        content: '# Home',
        updatedAt: '2026-05-19T00:00:00Z',
      }),
    ]);
    await runClone({ baseUrl: mock.url, targetDir: cloneDir });
  });

  it('does not falsely report "gone on server" when nothing changed', async () => {
    // Regression: the first cut compared the index's page ids against the
    // pageTree row ids in the remote tree (different id namespaces), so
    // every page in the index looked deleted and got re-pushed into the
    // new entries list, doubling the index. With the fix, a pull right
    // after clone is a true no-op.
    stdoutChunks.length = 0;
    const code = await runPull({ dir: cloneDir, force: false });
    expect(code).toBe(0);
    expect(stdoutText()).not.toContain('gone on server');

    const repo = await loadRepo(cloneDir);
    const idx = await readIndex(repo);
    const ids = idx.entries.map((e) => e.id);
    // No duplicates introduced by the pull.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('heals a previously-duplicated index in a single pull', async () => {
    // Simulate the buggy state left behind by an old pull: index entries
    // appear twice. With the dedupe pass the next pull cleans it up.
    const repo = await loadRepo(cloneDir);
    const idx = await readIndex(repo);
    const doubled = { version: 1 as const, entries: [...idx.entries, ...idx.entries] };
    await (await import('node:fs')).promises.writeFile(
      repo.indexPath,
      `${JSON.stringify(doubled, null, 2)}\n`,
      'utf8',
    );

    const code = await runPull({ dir: cloneDir, force: false });
    expect(code).toBe(0);

    const healed = await readIndex(repo);
    const ids = healed.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('picks up a remote update on an untouched file', async () => {
    seedWiki([
      makePage({
        id: 1,
        path: 'home',
        title: 'Home',
        content: '# Home (updated)',
        updatedAt: '2026-05-20T00:00:00Z',
      }),
    ]);
    stdoutChunks.length = 0;
    const code = await runPull({ dir: cloneDir, force: false });
    expect(code).toBe(0);
    expect(stdoutText()).toContain('updated: home');
    const home = await fs.readFile(path.join(cloneDir, 'home.md'), 'utf8');
    expect(home).toContain('# Home (updated)');
  });

  it('adds a brand-new page that did not exist at clone time', async () => {
    seedWiki([
      makePage({ id: 1, path: 'home', title: 'Home', content: '# Home' }),
      makePage({ id: 2, path: 'docs/new', title: 'New', content: '# New' }),
    ]);
    stdoutChunks.length = 0;
    await runPull({ dir: cloneDir, force: false });
    expect(stdoutText()).toContain('added:   docs/new');
    const file = await fs.readFile(
      path.join(cloneDir, 'docs', 'new.md'),
      'utf8',
    );
    expect(file).toContain('# New');
  });

  it('skips a locally-modified file by default', async () => {
    const home = path.join(cloneDir, 'home.md');
    const orig = await fs.readFile(home, 'utf8');
    await fs.writeFile(home, `${orig}\n\nLocal edit.\n`);

    // Remote also changed — should still be skipped.
    seedWiki([
      makePage({
        id: 1,
        path: 'home',
        title: 'Home',
        content: '# Home (remote)',
        updatedAt: '2026-05-20T00:00:00Z',
      }),
    ]);

    stderrChunks.length = 0;
    const code = await runPull({ dir: cloneDir, force: false });
    expect(code).toBe(0);
    expect(stderrChunks.join('')).toContain('locally modified');
    // File on disk is unchanged.
    const after = await fs.readFile(home, 'utf8');
    expect(after).toContain('Local edit.');
  });

  it('--force overwrites locally-modified files', async () => {
    const home = path.join(cloneDir, 'home.md');
    const orig = await fs.readFile(home, 'utf8');
    await fs.writeFile(home, `${orig}\n\nLocal edit.\n`);
    seedWiki([
      makePage({
        id: 1,
        path: 'home',
        title: 'Home',
        content: '# Home (remote)',
        updatedAt: '2026-05-20T00:00:00Z',
      }),
    ]);
    const code = await runPull({ dir: cloneDir, force: true });
    expect(code).toBe(0);
    const after = await fs.readFile(home, 'utf8');
    expect(after).toContain('# Home (remote)');
    expect(after).not.toContain('Local edit.');
  });

  it('detects renames and moves the local file', async () => {
    seedWiki([
      makePage({
        id: 1,
        path: 'home-renamed',
        title: 'Home',
        content: '# Home',
        updatedAt: '2026-05-20T00:00:00Z',
      }),
    ]);
    stdoutChunks.length = 0;
    const code = await runPull({ dir: cloneDir, force: false });
    expect(code).toBe(0);
    expect(stdoutText()).toContain('renamed: home → home-renamed');
    await expect(fs.stat(path.join(cloneDir, 'home.md'))).rejects.toThrow();
    await expect(
      fs.stat(path.join(cloneDir, 'home-renamed.md')),
    ).resolves.toBeTruthy();
  });
});
