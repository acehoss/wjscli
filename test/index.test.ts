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
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wikijs-mcp-idx-'));
  savedEnv.WIKIJS_MCP_CONFIG_DIR = process.env.WIKIJS_MCP_CONFIG_DIR;
  process.env.WIKIJS_MCP_CONFIG_DIR = tmpRoot;
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
  if (savedEnv.WIKIJS_MCP_CONFIG_DIR === undefined) {
    delete process.env.WIKIJS_MCP_CONFIG_DIR;
  } else {
    process.env.WIKIJS_MCP_CONFIG_DIR = savedEnv.WIKIJS_MCP_CONFIG_DIR;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const argv = (...args: string[]): string[] => ['node', 'wikijs-mcp', ...args];

describe('main — argv routing', () => {
  it('returns 2 with no args (prints usage)', async () => {
    expect(await main(argv())).toBe(2);
  });

  it('--help writes usage to stdout (pipeable) and exits 0', async () => {
    const code = await main(argv('--help'));
    expect(code).toBe(0);
    expect(stdoutWrites.join('')).toContain('wikijs-mcp — MCP server for Wiki.js');
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

  it('routes bootstrap to runBootstrap (rejects bad URL → exit 2)', async () => {
    // No network call needed: bootstrap rejects on URL parse before fetching.
    expect(await main(argv('bootstrap', 'not a url', 'a.b.c'))).toBe(2);
  });

  it('bare bootstrap (no URL, no JWT) routes through and exits 2', async () => {
    // Proves the bootstrap subcommand is wired up even when no positional
    // args follow. runBootstrap handles the usage error.
    expect(await main(argv('bootstrap'))).toBe(2);
  });

  it('routes a bare URL to runServer (missing config → exit 1)', async () => {
    // We exercise the routing, not the server runtime. With no config seeded,
    // runServer hits MissingConfigError and exits 1.
    expect(await main(argv('https://wiki.example.com'))).toBe(1);
  });
});
