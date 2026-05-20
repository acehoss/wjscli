import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeBaseUrl,
  configDir,
  configPathForBaseUrl,
  hostFromBaseUrl,
  readConfig,
  writeConfig,
  type ConfigFile,
} from '../src/config.js';
import { ConfigParseError } from '../src/util/errors.js';

let tmpRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wjscli-cfg-'));
  savedEnv.WJSCLI_CONFIG_DIR = process.env.WJSCLI_CONFIG_DIR;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.WJSCLI_CONFIG_DIR = tmpRoot;
});

afterEach(async () => {
  if (savedEnv.WJSCLI_CONFIG_DIR === undefined) {
    delete process.env.WJSCLI_CONFIG_DIR;
  } else {
    process.env.WJSCLI_CONFIG_DIR = savedEnv.WJSCLI_CONFIG_DIR;
  }
  if (savedEnv.XDG_CONFIG_HOME === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('canonicalizeBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(canonicalizeBaseUrl('https://wiki.example.com/')).toBe(
      'https://wiki.example.com',
    );
  });

  it('preserves no-trailing-slash URLs', () => {
    expect(canonicalizeBaseUrl('https://wiki.example.com')).toBe(
      'https://wiki.example.com',
    );
  });

  it('preserves non-default ports', () => {
    expect(canonicalizeBaseUrl('https://wiki.example.com:8443')).toBe(
      'https://wiki.example.com:8443',
    );
  });

  it('strips a query string', () => {
    expect(canonicalizeBaseUrl('https://wiki.example.com/?x=1&y=2')).toBe(
      'https://wiki.example.com',
    );
  });

  it('strips a fragment', () => {
    expect(canonicalizeBaseUrl('https://wiki.example.com/#anchor')).toBe(
      'https://wiki.example.com',
    );
  });

  it('strips both query string and fragment together', () => {
    expect(canonicalizeBaseUrl('https://wiki.example.com/?x=1#frag')).toBe(
      'https://wiki.example.com',
    );
  });

  it('normalizes a mixed-case scheme', () => {
    // WHATWG URL lowercases the scheme automatically; pin that behavior.
    expect(canonicalizeBaseUrl('HTTPS://wiki.example.com/')).toBe(
      'https://wiki.example.com',
    );
  });

  it('keeps an explicit default port off the canonical form', () => {
    // WHATWG URL strips :443 from https URLs as a default-port normalization.
    expect(canonicalizeBaseUrl('https://wiki.example.com:443/')).toBe(
      'https://wiki.example.com',
    );
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => canonicalizeBaseUrl('file:///etc/passwd')).toThrow(
      /http:\/\/ or https:\/\//,
    );
  });

  it('rejects malformed URLs', () => {
    expect(() => canonicalizeBaseUrl('not a url')).toThrow(/invalid base URL/);
  });

  it('rejects URLs missing a protocol', () => {
    // `new URL('wiki.example.com')` throws — bare host without a scheme isn't
    // a valid absolute URL. Pin the current behavior.
    expect(() => canonicalizeBaseUrl('wiki.example.com')).toThrow(/invalid base URL/);
  });

  it('handles IPv6 hosts (brackets preserved, lowercased)', () => {
    expect(canonicalizeBaseUrl('https://[::1]:8443/')).toBe('https://[::1]:8443');
  });

  it('handles IDN (punycode) hosts', () => {
    // WHATWG URL parses IDN hosts to punycode. Pin that behavior so we keep
    // a stable on-disk filename for the same logical wiki.
    const out = canonicalizeBaseUrl('https://bücher.example/');
    expect(out).toMatch(/^https:\/\/xn--bcher-kva\.example$/);
  });

  it('preserves a non-trailing path', () => {
    // Wiki.js typically lives at the host root, but if a deployment ever
    // mounts it under a subpath we want predictable behavior.
    expect(canonicalizeBaseUrl('https://example.com/wiki/')).toBe(
      'https://example.com/wiki',
    );
  });
});

describe('hostFromBaseUrl', () => {
  it('lowercases the host', () => {
    expect(hostFromBaseUrl('https://Wiki.Example.COM')).toBe('wiki.example.com');
  });

  it('includes a non-default port', () => {
    expect(hostFromBaseUrl('https://wiki.example.com:8443')).toBe(
      'wiki.example.com:8443',
    );
  });

  it('returns IPv6 brackets', () => {
    expect(hostFromBaseUrl('https://[::1]:8443')).toBe('[::1]:8443');
  });
});

describe('configDir', () => {
  it('honors WJSCLI_CONFIG_DIR override', () => {
    expect(configDir()).toBe(tmpRoot);
  });

  it('falls back to XDG_CONFIG_HOME when override is unset', () => {
    delete process.env.WJSCLI_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = '/nope/xdg';
    expect(configDir()).toBe(path.join('/nope/xdg', 'wjscli'));
  });

  it('falls back to ~/.config when both env vars are unset', () => {
    delete process.env.WJSCLI_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    expect(configDir()).toBe(path.join(homedir(), '.config', 'wjscli'));
  });
});

describe('configPathForBaseUrl', () => {
  it('builds <dir>/<host>.json', () => {
    expect(configPathForBaseUrl('https://Wiki.Example.com:8443/')).toBe(
      path.join(tmpRoot, 'wiki.example.com:8443.json'),
    );
  });
});

describe('readConfig / writeConfig', () => {
  const baseUrl = 'https://wiki.example.com';

  it('returns null when the file does not exist', async () => {
    expect(await readConfig(baseUrl)).toBeNull();
  });

  it('writes then reads a round-trip', async () => {
    const cfg: ConfigFile = {
      baseUrl,
      jwt: 'header.payload.sig',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    };
    await writeConfig(cfg);
    const got = await readConfig(baseUrl);
    expect(got).toEqual(cfg);
  });

  it('round-trips an optional note', async () => {
    const cfg: ConfigFile = {
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
      note: 'aaron laptop',
    };
    await writeConfig(cfg);
    expect(await readConfig(baseUrl)).toEqual(cfg);
  });

  it('writes file mode 0600', async () => {
    await writeConfig({
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    const filePath = configPathForBaseUrl(baseUrl);
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('ensures containing dir is mode 0700', async () => {
    // mkdtemp creates the dir at 0700 already, so a passing assertion against
    // that wouldn't prove writeConfig is enforcing the mode. Loosen the dir
    // first; writeConfig must tighten it back to 0700.
    await fs.chmod(tmpRoot, 0o755);
    await writeConfig({
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    const stat = await fs.stat(tmpRoot);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('throws ConfigParseError on invalid JSON', async () => {
    const filePath = configPathForBaseUrl(baseUrl);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{not valid json', 'utf8');
    await expect(readConfig(baseUrl)).rejects.toBeInstanceOf(ConfigParseError);
  });

  it('throws ConfigParseError on shape mismatch', async () => {
    const filePath = configPathForBaseUrl(baseUrl);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ baseUrl, jwt: 'a.b.c' }), 'utf8');
    await expect(readConfig(baseUrl)).rejects.toMatchObject({
      code: 'config_parse',
    });
  });

  it('does not leave a .tmp file around on success', async () => {
    await writeConfig({
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    const entries = await fs.readdir(tmpRoot);
    expect(entries.some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('overwrites atomically when called twice', async () => {
    await writeConfig({
      baseUrl,
      jwt: 'first',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    await writeConfig({
      baseUrl,
      jwt: 'second',
      refreshedAt: '2026-05-18T12:00:01.000Z',
    });
    const got = await readConfig(baseUrl);
    expect(got?.jwt).toBe('second');
  });

  it('cleans up the tmp file when rename fails mid-write', async () => {
    // Phase 2 deferral / Phase 6c: previously, a failure in writeFile/sync
    // would leak a `.tmp-<pid>-<rand>` file in the config dir because only
    // the rename catch unlinked it. The fix wraps the whole tmp-file
    // lifecycle so any failure path cleans up.
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('simulated EIO'), { code: 'EIO' }));
    await expect(
      writeConfig({
        baseUrl,
        jwt: 'first',
        refreshedAt: '2026-05-18T12:00:00.000Z',
      }),
    ).rejects.toThrow(/simulated EIO/);
    renameSpy.mockRestore();
    // No leaked tmp file.
    const entries = await fs.readdir(tmpRoot);
    expect(entries.some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('cleans up the tmp file when writeFile fails (pre-rename)', async () => {
    // The harder regression: pre-Phase-6c, an EIO from handle.writeFile or
    // handle.sync left a zero-or-partial-byte tmp file behind because the
    // finally that closed the handle did NOT unlink, and the rename-only
    // catch never ran. Simulate by spying on fs.open's returned handle and
    // making writeFile throw — the catch we added now must clean up the
    // tmp file even though rename was never reached.
    const realOpen = fs.open;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen.apply(fs, args as Parameters<typeof realOpen>);
      const origClose = handle.close.bind(handle);
      handle.writeFile = (): Promise<void> =>
        Promise.reject(Object.assign(new Error('simulated EIO during write'), { code: 'EIO' }));
      // Keep close working so the finally that closes the (empty) handle
      // doesn't itself throw.
      handle.close = origClose;
      return handle;
    });
    await expect(
      writeConfig({
        baseUrl,
        jwt: 'first',
        refreshedAt: '2026-05-18T12:00:00.000Z',
      }),
    ).rejects.toThrow(/simulated EIO during write/);
    openSpy.mockRestore();
    const entries = await fs.readdir(tmpRoot);
    expect(entries.some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('concurrent writers + readers never observe a partial file', async () => {
    // The atomic rename means readers must see either the previous valid file
    // or the new one — never a truncated/half-written state that would surface
    // as a ConfigParseError.
    const writers = 16;
    const readers = 32;
    const writes = Array.from({ length: writers }, (_, i) =>
      (async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        await writeConfig({
          baseUrl,
          jwt: `jwt-${i.toString()}`,
          refreshedAt: '2026-05-18T12:00:00.000Z',
        });
      })(),
    );
    const reads = Array.from({ length: readers }, () =>
      (async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 8));
        // Either parses cleanly or returns null (file not yet created);
        // a ConfigParseError would indicate non-atomic writes.
        const got = await readConfig(baseUrl);
        if (got !== null) {
          expect(got.baseUrl).toBe(baseUrl);
          expect(got.jwt).toMatch(/^jwt-\d+$/);
        }
      })(),
    );
    await Promise.all([...writes, ...reads]);
  });
});
