import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findRoot,
  initRepo,
  loadRepo,
  readIndex,
  writeIndex,
  type SyncIndex,
} from '../../src/sync/repo.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wjscli-sync-repo-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('initRepo', () => {
  it('writes .wjscli/config.json and an empty .wjscli/index.json', async () => {
    const repo = await initRepo(tmpRoot, {
      baseUrl: 'https://wiki.example.com',
      locale: 'en',
      clonedAt: '2026-05-19T00:00:00.000Z',
    });
    expect(repo.root).toBe(path.resolve(tmpRoot));
    const cfg = JSON.parse(await fs.readFile(repo.configPath, 'utf8')) as {
      baseUrl: string;
      version: number;
    };
    expect(cfg.baseUrl).toBe('https://wiki.example.com');
    expect(cfg.version).toBe(1);
    const idx = JSON.parse(await fs.readFile(repo.indexPath, 'utf8')) as {
      entries: unknown[];
    };
    expect(idx.entries).toEqual([]);
  });

  it('refuses to overwrite an existing .wjscli/', async () => {
    await initRepo(tmpRoot, {
      baseUrl: 'https://wiki.example.com',
      locale: 'en',
      clonedAt: 'x',
    });
    await expect(
      initRepo(tmpRoot, {
        baseUrl: 'https://wiki.example.com',
        locale: 'en',
        clonedAt: 'x',
      }),
    ).rejects.toThrow(/refusing to overwrite/);
  });
});

describe('findRoot', () => {
  it('returns the directory containing .wjscli/', async () => {
    await initRepo(tmpRoot, {
      baseUrl: 'https://wiki.example.com',
      locale: 'en',
      clonedAt: 'x',
    });
    expect(await findRoot(tmpRoot)).toBe(path.resolve(tmpRoot));
  });

  it('walks up from a nested directory', async () => {
    await initRepo(tmpRoot, {
      baseUrl: 'https://wiki.example.com',
      locale: 'en',
      clonedAt: 'x',
    });
    const nested = path.join(tmpRoot, 'docs', 'subdir');
    await fs.mkdir(nested, { recursive: true });
    expect(await findRoot(nested)).toBe(path.resolve(tmpRoot));
  });

  it('returns null when no .wjscli/ is found', async () => {
    expect(await findRoot(tmpRoot)).toBeNull();
  });
});

describe('loadRepo', () => {
  it('returns the parsed config when a valid clone exists', async () => {
    await initRepo(tmpRoot, {
      baseUrl: 'https://wiki.example.com',
      locale: 'en',
      clonedAt: '2026-05-19T00:00:00.000Z',
    });
    const repo = await loadRepo(tmpRoot);
    expect(repo.config.baseUrl).toBe('https://wiki.example.com');
    expect(repo.config.locale).toBe('en');
  });

  it('throws a useful error when no clone is present', async () => {
    await expect(loadRepo(tmpRoot)).rejects.toThrow(/not a wjscli sync clone/);
  });

  it('throws when the config has a bad schema', async () => {
    await fs.mkdir(path.join(tmpRoot, '.wjscli'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, '.wjscli', 'config.json'),
      JSON.stringify({ baseUrl: 'x' }),
    );
    await expect(loadRepo(tmpRoot)).rejects.toThrow(/version mismatch/);
  });
});

describe('readIndex / writeIndex', () => {
  it('round-trips and sorts entries by path', async () => {
    const repo = await initRepo(tmpRoot, {
      baseUrl: 'https://wiki.example.com',
      locale: 'en',
      clonedAt: 'x',
    });
    const idx: SyncIndex = {
      version: 1,
      entries: [
        {
          id: 2,
          path: 'zeta',
          file: 'zeta.md',
          hash: 'h2',
          remoteUpdatedAt: 't2',
          syncedAt: 's2',
        },
        {
          id: 1,
          path: 'alpha',
          file: 'alpha.md',
          hash: 'h1',
          remoteUpdatedAt: 't1',
          syncedAt: 's1',
        },
      ],
    };
    await writeIndex(repo, idx);
    const back = await readIndex(repo);
    expect(back.entries.map((e) => e.path)).toEqual(['alpha', 'zeta']);
  });

  it('readIndex returns an empty index when the file is missing', async () => {
    const repo = await initRepo(tmpRoot, {
      baseUrl: 'https://wiki.example.com',
      locale: 'en',
      clonedAt: 'x',
    });
    await fs.rm(repo.indexPath);
    const back = await readIndex(repo);
    expect(back.entries).toEqual([]);
  });
});
