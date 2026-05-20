import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';

let tmpRoot: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
const stdoutWrites: string[] = [];
const stderrWrites: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wjscli-idx-'));
  savedEnv.WJSCLI_CONFIG_DIR = process.env.WJSCLI_CONFIG_DIR;
  process.env.WJSCLI_CONFIG_DIR = tmpRoot;
  stdoutWrites.length = 0;
  stderrWrites.length = 0;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
});

afterEach(async () => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  if (savedEnv.WJSCLI_CONFIG_DIR === undefined) {
    delete process.env.WJSCLI_CONFIG_DIR;
  } else {
    process.env.WJSCLI_CONFIG_DIR = savedEnv.WJSCLI_CONFIG_DIR;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const argv = (...args: string[]): string[] => ['node', 'wjscli', ...args];

describe('main — argv routing', () => {
  it('returns 2 with no args (prints usage)', async () => {
    expect(await main(argv())).toBe(2);
  });

  it('--help writes usage to stdout (pipeable) and exits 0', async () => {
    const code = await main(argv('--help'));
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('wjscli — Wiki.js v2 CLI and MCP server');
    expect(stderrWrites.join('')).toBe('');
  });

  it('-h writes usage to stdout and exits 0', async () => {
    const code = await main(argv('-h'));
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('Usage:');
    expect(stderrWrites.join('')).toBe('');
  });

  it('no-args usage goes to stderr (error path), not stdout', async () => {
    const code = await main(argv());
    expect(code).toBe(2);
    expect(stderrWrites.join('')).toContain('Usage:');
    expect(stdoutWrites.join('')).toBe('');
  });

  it('--version writes to stdout and exits 0', async () => {
    const code = await main(argv('--version'));
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('-v writes to stdout and exits 0', async () => {
    const code = await main(argv('-v'));
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns 2 for an unknown --option', async () => {
    expect(await main(argv('--bogus'))).toBe(2);
  });

  it('routes <url> validate to runValidate (rejects bad URL → exit 2)', async () => {
    // No network call needed: validate rejects on URL parse before fetching.
    expect(await main(argv('not a url', 'validate', 'a.b.c'))).toBe(2);
  });

  it('<url> validate with no JWT routes through and exits 2', async () => {
    // Proves the validate subcommand is wired up even when no positional
    // args follow. runValidate handles the usage error.
    expect(await main(argv('https://wiki.example.com', 'validate'))).toBe(2);
  });

  it('routes <url> mcp to runServer (missing config → exit 1)', async () => {
    expect(await main(argv('https://wiki.example.com', 'mcp'))).toBe(1);
  });

  it('rejects subcommand-first ordering with a friendly hint', async () => {
    // `validate` and `mcp` are subcommands; URL must come first. Pre-empt
    // the URL parse so the user gets a useful message instead of
    // "invalid base URL: validate".
    expect(await main(argv('validate', 'https://wiki.example.com', 'a.b.c'))).toBe(2);
    expect(stderrWrites.join('')).toContain('base URL must come first');
  });

  it('mcp-first ordering also gets the friendly hint', async () => {
    expect(await main(argv('mcp', 'https://wiki.example.com'))).toBe(2);
    expect(stderrWrites.join('')).toContain('base URL must come first');
  });

  it('routes a bare URL with no subcommand to a usage error', async () => {
    expect(await main(argv('https://wiki.example.com'))).toBe(2);
    expect(stderrWrites.join('')).toContain('subcommand is required');
  });

  it('routes <url> tags list to the CLI (missing config → exit 1)', async () => {
    expect(await main(argv('https://wiki.example.com', 'tags', 'list'))).toBe(1);
    expect(stderrWrites.join('')).toContain('validate');
  });
});
