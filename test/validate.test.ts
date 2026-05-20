import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runValidate } from '../src/validate.js';
import { configPathForBaseUrl, readConfig } from '../src/config.js';
import {
  startMockGraphQLServer,
  type MockGraphQLServer,
} from './mock/graphql-server.js';

// Realistic-looking JWT: `eyJ` prefix (real header), three dot-separated
// base64url segments. Used so future JWT_REDACT tests don't miss bugs and
// so the value matches what a user would actually paste.
const validJwt =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0IiwiaWF0IjoxNzAwMDAwMDAwfQ.abcdef0123456789abcdef0123456789';

let tmpRoot: string;
let mock: MockGraphQLServer;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const stderrChunks: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wjscli-validate-'));
  savedEnv.WJSCLI_CONFIG_DIR = process.env.WJSCLI_CONFIG_DIR;
  process.env.WJSCLI_CONFIG_DIR = tmpRoot;
  mock = await startMockGraphQLServer();
  // Capture stderr instead of just silencing — several tests assert on its
  // contents (auth-line shape, friendly hints, JWT non-leakage).
  stderrChunks.length = 0;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
});

afterEach(async () => {
  stderrSpy.mockRestore();
  await mock.close();
  if (savedEnv.WJSCLI_CONFIG_DIR === undefined) {
    delete process.env.WJSCLI_CONFIG_DIR;
  } else {
    process.env.WJSCLI_CONFIG_DIR = savedEnv.WJSCLI_CONFIG_DIR;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const stderrText = (): string => stderrChunks.join('');

describe('runValidate — help flag', () => {
  it('-h prints help to stdout and exits 0', async () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    });
    try {
      expect(await runValidate(mock.url, ['-h'])).toBe(0);
      expect(stdoutChunks.join('')).toMatch(/wjscli <base-url> validate/);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('--help works at any position', async () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    });
    try {
      expect(await runValidate(mock.url, [validJwt, '--help'])).toBe(0);
      expect(stdoutChunks.join('')).toMatch(/--token-refresh/);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('runValidate — usage errors', () => {
  it('returns 2 with no args', async () => {
    expect(await runValidate(mock.url, [])).toBe(2);
  });

  it('returns 2 with two positional args (JWT only expected)', async () => {
    expect(await runValidate(mock.url, [validJwt, 'extra'])).toBe(2);
  });

  it('returns 2 on an invalid URL', async () => {
    expect(await runValidate('not a url', [validJwt])).toBe(2);
  });

  it('returns 2 on a non-http(s) scheme', async () => {
    expect(await runValidate('ftp://wiki.example.com', [validJwt])).toBe(2);
  });

  describe('JWT shape rejection', () => {
    it('rejects a single-segment string', async () => {
      expect(await runValidate(mock.url, ['not-a-jwt'])).toBe(2);
    });

    it('rejects an empty string', async () => {
      expect(await runValidate(mock.url, [''])).toBe(2);
    });

    it('rejects a two-segment value', async () => {
      expect(await runValidate(mock.url, ['aaaa.bbbb'])).toBe(2);
    });

    it('rejects a value with a trailing empty segment', async () => {
      expect(await runValidate(mock.url, ['aaaa.bbbb.cccc.'])).toBe(2);
    });

    it('rejects a value with a non-base64url character (+)', async () => {
      expect(await runValidate(mock.url, ['aaaa.bbb+b.cccc'])).toBe(2);
    });
  });
});

describe('runValidate — happy path', () => {
  it('writes config with the supplied JWT (no refresh) and exits 0', async () => {
    // Default mock behavior: no new-jwt. This is the dominant real-world
    // case — Wiki.js only refreshes when the token is in the renewal window.
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(0);

    const cfgPath = configPathForBaseUrl(mock.url);
    const cfg = await readConfig(mock.url);
    expect(cfg?.baseUrl).toBe(mock.url);
    expect(cfg?.jwt).toBe(validJwt);
    expect(cfg?.refreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const stat = await fs.stat(cfgPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writes refreshed JWT when server returns new-jwt', async () => {
    mock.setNext({
      newJwt:
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWZyZXNoZWQifQ.refreshedsignaturerefreshedsignature',
    });
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(0);
    const cfg = await readConfig(mock.url);
    expect(cfg?.jwt).toMatch(/^eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiJyZWZyZXNoZWQifQ\./);
  });

  it('sends the provided JWT in the Authorization header', async () => {
    await runValidate(mock.url, [validJwt]);
    expect(mock.lastRequest()?.authorization).toBe(`Bearer ${validJwt}`);
  });

  it('canonicalizes the base URL before persisting', async () => {
    const withSlash = `${mock.url}/`;
    const code = await runValidate(withSlash, [validJwt]);
    expect(code).toBe(0);
    const cfg = await readConfig(mock.url);
    expect(cfg?.baseUrl).toBe(mock.url);
  });

  it('writes the auth-line confirmation to stderr with name/email/id', async () => {
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(0);
    expect(stderrText()).toContain('Authenticated as Aaron Heise <aaron@example.com> (id=7)');
  });

  it('does not write the supplied JWT to stderr (never log JWT)', async () => {
    await runValidate(mock.url, [validJwt]);
    expect(stderrText()).not.toContain(validJwt);
  });
});

describe('runValidate — daemon (-t) wiring', () => {
  it('invokes runDaemon after a successful probe when -t is passed', async () => {
    let daemonCalls = 0;
    let observedBaseUrl: string | null = null;
    const code = await runValidate(mock.url, [validJwt, '-t'], {
      runDaemon: async (baseUrl) => {
        daemonCalls += 1;
        observedBaseUrl = baseUrl;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(daemonCalls).toBe(1);
    expect(observedBaseUrl).toBe(mock.url);
  });

  it('does NOT invoke runDaemon without -t', async () => {
    let daemonCalls = 0;
    const code = await runValidate(mock.url, [validJwt], {
      runDaemon: async () => {
        daemonCalls += 1;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(daemonCalls).toBe(0);
  });

  it('accepts --token-refresh as a long alias', async () => {
    let daemonCalls = 0;
    await runValidate(mock.url, [validJwt, '--token-refresh'], {
      runDaemon: async () => {
        daemonCalls += 1;
        return 0;
      },
    });
    expect(daemonCalls).toBe(1);
  });

  it('accepts -t before the positional jwt', async () => {
    let daemonCalls = 0;
    await runValidate(mock.url, ['-t', validJwt], {
      runDaemon: async () => {
        daemonCalls += 1;
        return 0;
      },
    });
    expect(daemonCalls).toBe(1);
  });

  it('propagates daemon exit code', async () => {
    const code = await runValidate(mock.url, [validJwt, '-t'], {
      runDaemon: async () => 7,
    });
    expect(code).toBe(7);
  });
});

describe('runValidate — failure paths', () => {
  it('exits 1 on HTTP 401 and does NOT write config', async () => {
    mock.setNext({ status: 401, body: 'Unauthorized' });
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(1);
    expect(await readConfig(mock.url)).toBeNull();
  });

  it('exits 1 on HTTP 5xx and does NOT write config', async () => {
    mock.setNext({ status: 500, body: 'boom' });
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(1);
    expect(await readConfig(mock.url)).toBeNull();
  });

  it('classifies the real Wiki.js auth-rejection shape (200 + AuthRequired message)', async () => {
    // This is the load-bearing case. Real Wiki.js sets req.user to guest on
    // a rejected JWT (passport-jwt failure → guest fallback), responds with
    // HTTP 200, and the users.profile resolver throws AuthRequired:
    // "You must be authenticated to access this resource." We must classify
    // this as an AuthExpiredError, not a generic GraphQLError.
    mock.setNext({
      errors: [{ message: 'You must be authenticated to access this resource.' }],
    });
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(1);
    expect(await readConfig(mock.url)).toBeNull();
    // The "JWT rejected by server" friendly hint is the AuthExpiredError-path
    // copy — proves the regex matched and AuthExpiredError was thrown.
    expect(stderrText()).toContain('JWT rejected by server');
    expect(stderrText()).toContain('`jwt` cookie');
  });

  it('classifies "Invalid token" / "jwt expired" messages as auth failure', async () => {
    mock.setNext({
      errors: [{ message: 'Invalid token: jwt expired' }],
    });
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(1);
    expect(stderrText()).toContain('JWT rejected by server');
  });

  it('does NOT classify a permission "not authorized" message as auth failure', async () => {
    // PageUpdateForbidden et al. carry messages like "You are not authorized
    // to update this page." We must NOT classify those as JWT expiry — that
    // would falsely tell the user to re-validate when their JWT is fine.
    mock.setNext({
      errors: [{ message: 'You are not authorized to update this page.' }],
    });
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(1);
    expect(stderrText()).toContain('GraphQL error');
    expect(stderrText()).not.toContain('JWT rejected by server');
  });

  it('exits 1 on a non-auth GraphQL error', async () => {
    mock.setNext({
      errors: [{ message: 'Something else went wrong' }],
    });
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(1);
    expect(await readConfig(mock.url)).toBeNull();
  });

  describe('unexpected response shapes', () => {
    it('exits 1 when profile.id is the wrong type', async () => {
      mock.setNext({
        data: { users: { profile: { id: 'not-a-number', email: '', name: '' } } },
      });
      const code = await runValidate(mock.url, [validJwt]);
      expect(code).toBe(1);
      expect(await readConfig(mock.url)).toBeNull();
    });

    it('exits 1 when data is null', async () => {
      mock.setNext({ data: null });
      const code = await runValidate(mock.url, [validJwt]);
      expect(code).toBe(1);
      expect(await readConfig(mock.url)).toBeNull();
    });

    it('exits 1 when users is null', async () => {
      mock.setNext({ data: { users: null } });
      const code = await runValidate(mock.url, [validJwt]);
      expect(code).toBe(1);
      expect(await readConfig(mock.url)).toBeNull();
    });

    it('exits 1 when profile is null', async () => {
      mock.setNext({ data: { users: { profile: null } } });
      const code = await runValidate(mock.url, [validJwt]);
      expect(code).toBe(1);
      expect(await readConfig(mock.url)).toBeNull();
    });
  });

  it('exits 1 when the server is unreachable (network error after retry)', async () => {
    await mock.close();
    const code = await runValidate(mock.url, [validJwt]);
    expect(code).toBe(1);
    expect(await readConfig(mock.url)).toBeNull();
  });
});
