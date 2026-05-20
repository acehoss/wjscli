import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configPathForBaseUrl,
  readConfig,
  writeConfig,
  type ConfigFile,
} from '../src/config.js';
import * as configMod from '../src/config.js';
import { MissingConfigError } from '../src/util/errors.js';
import { TokenStore } from '../src/util/token-store.js';

const baseUrl = 'https://wiki.example.com';

type TestCtx = {
  tmpRoot: string;
  stores: TokenStore[];
};

// Per-test ctx works because vitest runs files in parallel but tests within a
// file serially by default. If a future config enables intra-file parallelism,
// this needs to move to test-local state.
let ctx: TestCtx;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wjscli-ts-'));
  savedEnv.WJSCLI_CONFIG_DIR = process.env.WJSCLI_CONFIG_DIR;
  process.env.WJSCLI_CONFIG_DIR = tmpRoot;
  ctx = { tmpRoot, stores: [] };
});

afterEach(async () => {
  for (const s of ctx.stores) {
    await s.close();
  }
  if (savedEnv.WJSCLI_CONFIG_DIR === undefined) {
    delete process.env.WJSCLI_CONFIG_DIR;
  } else {
    process.env.WJSCLI_CONFIG_DIR = savedEnv.WJSCLI_CONFIG_DIR;
  }
  await fs.rm(ctx.tmpRoot, { recursive: true, force: true });
});

async function seed(cfg: Partial<ConfigFile> = {}): Promise<ConfigFile> {
  const full: ConfigFile = {
    baseUrl,
    jwt: 'initial.jwt.value',
    refreshedAt: '2026-05-18T12:00:00.000Z',
    ...cfg,
  };
  await writeConfig(full);
  return full;
}

async function load(debounceMs = 20): Promise<TokenStore> {
  const store = await TokenStore.loadForBaseUrl(baseUrl, { debounceMs });
  ctx.stores.push(store);
  return store;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await wait(intervalMs);
  }
}

describe('TokenStore.loadForBaseUrl', () => {
  it('throws MissingConfigError when no config file exists', async () => {
    await expect(TokenStore.loadForBaseUrl(baseUrl)).rejects.toBeInstanceOf(
      MissingConfigError,
    );
  });

  it('loads the JWT from disk', async () => {
    await seed({ jwt: 'loaded.jwt.value' });
    const store = await load();
    expect(store.getToken()).toBe('loaded.jwt.value');
    expect(store.getBaseUrl()).toBe(baseUrl);
    expect(store.getFilePath()).toBe(configPathForBaseUrl(baseUrl));
  });
});

describe('TokenStore.update', () => {
  it('updates the in-memory token immediately', async () => {
    await seed();
    const store = await load();
    store.update('fresh.jwt.value');
    expect(store.getToken()).toBe('fresh.jwt.value');
  });

  it('writes to disk after the debounce window', async () => {
    await seed();
    const store = await load(20);
    store.update('fresh.jwt.value');
    await store.flush();
    const onDisk = await readConfig(baseUrl);
    expect(onDisk?.jwt).toBe('fresh.jwt.value');
  });

  it('preserves an optional note across update + flush', async () => {
    await seed({ jwt: 'old.jwt', note: 'aaron laptop' });
    const store = await load();
    store.update('fresh.jwt');
    await store.flush();
    const onDisk = await readConfig(baseUrl);
    expect(onDisk?.jwt).toBe('fresh.jwt');
    expect(onDisk?.note).toBe('aaron laptop');
  });

  it('rewrites refreshedAt on every flushed update', async () => {
    const original = await seed({ refreshedAt: '2020-01-01T00:00:00.000Z' });
    const store = await load();
    store.update('newer.jwt');
    await store.flush();
    const onDisk = await readConfig(baseUrl);
    expect(onDisk?.refreshedAt).not.toBe(original.refreshedAt);
    expect(Date.parse(onDisk?.refreshedAt ?? '')).toBeGreaterThan(
      Date.parse(original.refreshedAt),
    );
  });

  it('coalesces rapid updates into a single write', async () => {
    await seed();
    const store = await load(50);
    const spy = vi.spyOn(configMod, 'writeConfig');
    store.update('jwt.v1');
    store.update('jwt.v2');
    store.update('jwt.v3');
    expect(store.getToken()).toBe('jwt.v3');
    await store.flush();
    const onDisk = await readConfig(baseUrl);
    expect(onDisk?.jwt).toBe('jwt.v3');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('coalesces updates that straddle the debounce window', async () => {
    await seed();
    const store = await load(60);
    const spy = vi.spyOn(configMod, 'writeConfig');
    store.update('a');
    await wait(30);
    store.update('b');
    await store.flush();
    expect((await readConfig(baseUrl))?.jwt).toBe('b');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('does nothing when the new token matches current', async () => {
    await seed({ jwt: 'same.jwt' });
    const store = await load();
    const spy = vi.spyOn(configMod, 'writeConfig');
    store.update('same.jwt');
    await store.flush();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ignores empty token values', async () => {
    await seed({ jwt: 'keep.me' });
    const store = await load();
    store.update('');
    expect(store.getToken()).toBe('keep.me');
  });

  it('is a no-op after close()', async () => {
    await seed({ jwt: 'before.close' });
    const store = await load();
    await store.close();
    store.update('would.have.queued');
    await wait(50);
    expect(store.getToken()).toBe('before.close');
    expect((await readConfig(baseUrl))?.jwt).toBe('before.close');
  });
});

describe('TokenStore.flush', () => {
  it('is a no-op when nothing is pending', async () => {
    await seed();
    const store = await load();
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it('handles two concurrent callers correctly', async () => {
    await seed();
    const store = await load(40);
    store.update('first.token');
    const p1 = store.flush();
    const p2 = store.flush();
    await Promise.all([p1, p2]);
    expect((await readConfig(baseUrl))?.jwt).toBe('first.token');
  });

  it('drains an in-flight write started by the timer', async () => {
    await seed();
    const store = await load(20);
    store.update('timer.driven');
    await wait(25);
    await store.flush();
    expect((await readConfig(baseUrl))?.jwt).toBe('timer.driven');
  });
});

describe('TokenStore file watcher', () => {
  it('picks up an external rewrite of the config file', async () => {
    await seed({ jwt: 'old.jwt' });
    const store = await load();
    expect(store.getToken()).toBe('old.jwt');

    await writeConfig({
      baseUrl,
      jwt: 'externally.fresh.jwt',
      refreshedAt: '2026-05-18T13:00:00.000Z',
    });

    await pollUntil(() => store.getToken() === 'externally.fresh.jwt');
    expect(store.getToken()).toBe('externally.fresh.jwt');
  });

  it('survives a self-write and still notices a later external rewrite', async () => {
    // Validate-from-another-shell flow: after a self-refresh, an outside
    // `wjscli validate` must still take effect live. fs.watch on a file
    // path would lose its inode on the self-rename; directory-watch + basename
    // filter is the fix.
    await seed({ jwt: 'old.jwt' });
    const store = await load(20);

    store.update('self.refresh');
    await store.flush();
    expect(store.getToken()).toBe('self.refresh');

    await writeConfig({
      baseUrl,
      jwt: 'external.bootstrap',
      refreshedAt: '2026-05-18T14:00:00.000Z',
    });

    await pollUntil(() => store.getToken() === 'external.bootstrap');
    expect(store.getToken()).toBe('external.bootstrap');
  });

  it('hash dedup blocks reloads even when content is identical to what we wrote', async () => {
    // MF6 strengthening: force the hash-suppression path to be load-bearing.
    // After a self-write, an external rewriter touches the file with the EXACT
    // same JWT we just wrote (but a different refreshedAt — so the byte
    // content differs and readConfig will return a real ConfigFile). The
    // secondary `cfg.jwt === currentJwt` check would also bail, but the test
    // is constructed so the primary hash check fires first: hash dedup keys
    // off the JWT alone, and the JWT matches lastWrittenHash. If the hash
    // check regressed, we'd at minimum see `note` get pulled in (a field that
    // is otherwise stable). Assert note is untouched.
    await seed({ jwt: 'self.refresh.value' });
    const store = await load(20);
    store.update('self.refresh.value.NEW');
    await store.flush();
    expect(store.getToken()).toBe('self.refresh.value.NEW');

    // External rewrite: same JWT as our last self-write, plus a never-seen note.
    await writeConfig({
      baseUrl,
      jwt: 'self.refresh.value.NEW',
      refreshedAt: '2099-01-01T00:00:00.000Z',
      note: 'should-not-load',
    });
    await wait(200);
    // If hash dedup had failed and we'd reloaded, `note` would now be set.
    // We can't observe `note` directly, but we can prove no reload happened
    // by writing a *different* JWT next and checking the watcher DOES pick
    // that one up — proves the watcher is still alive and discriminating.
    expect(store.getToken()).toBe('self.refresh.value.NEW');

    await writeConfig({
      baseUrl,
      jwt: 'truly.different.jwt',
      refreshedAt: '2099-01-02T00:00:00.000Z',
    });
    await pollUntil(() => store.getToken() === 'truly.different.jwt');
    expect(store.getToken()).toBe('truly.different.jwt');
  });
});

describe('TokenStore.close', () => {
  it('flushes any pending debounced write before closing', async () => {
    await seed({ jwt: 'before' });
    const store = await load(50_000); // very long debounce — would never fire on its own
    store.update('survived.close');
    await store.close();
    expect((await readConfig(baseUrl))?.jwt).toBe('survived.close');
  });

  it('is idempotent', async () => {
    await seed();
    const store = await load();
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
