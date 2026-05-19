import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig } from '../src/config.js';
import {
  buildServer,
  installShutdownHandlers,
  runServer,
  type ShutdownProcess,
} from '../src/server.js';
import { TokenStore } from '../src/util/token-store.js';
import { WikiClient } from '../src/wiki/client.js';

const baseUrl = 'https://wiki.example.com';

let tmpRoot: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const stderrChunks: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(tmpdir(), 'wikijs-mcp-srv-'));
  savedEnv.WIKIJS_MCP_CONFIG_DIR = process.env.WIKIJS_MCP_CONFIG_DIR;
  process.env.WIKIJS_MCP_CONFIG_DIR = tmpRoot;
  stderrChunks.length = 0;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  });
});

afterEach(async () => {
  stderrSpy.mockRestore();
  if (savedEnv.WIKIJS_MCP_CONFIG_DIR === undefined) {
    delete process.env.WIKIJS_MCP_CONFIG_DIR;
  } else {
    process.env.WIKIJS_MCP_CONFIG_DIR = savedEnv.WIKIJS_MCP_CONFIG_DIR;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const stderrText = (): string => stderrChunks.join('');

describe('runServer — usage and config errors', () => {
  it('returns 2 with no args', async () => {
    expect(await runServer([])).toBe(2);
  });

  it('returns 2 with too many args', async () => {
    expect(await runServer([baseUrl, 'extra'])).toBe(2);
  });

  it('returns 2 on an invalid URL', async () => {
    expect(await runServer(['not a url'])).toBe(2);
  });

  it('returns 1 when no config file exists for the base URL', async () => {
    const code = await runServer([baseUrl], { smokeOnly: true });
    expect(code).toBe(1);
  });

  it('missing-config stderr names "wikijs-mcp bootstrap" so the user knows what to do', async () => {
    await runServer([baseUrl], { smokeOnly: true });
    expect(stderrText()).toContain('wikijs-mcp bootstrap');
    expect(stderrText()).toContain(baseUrl);
  });

  it('returns 0 when config exists and smokeOnly is true', async () => {
    await writeConfig({
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    const code = await runServer([baseUrl], { smokeOnly: true });
    expect(code).toBe(0);
  });
});

describe('buildServer — MCP protocol surface', () => {
  it('initializes and lists the seven v1 tools', async () => {
    await writeConfig({
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    const store = await TokenStore.loadForBaseUrl(baseUrl);
    try {
      const client = new WikiClient({ tokenStore: store });
      const { server } = buildServer({ client });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: 'test-client', version: '0.0.0' },
        { capabilities: {} },
      );
      await Promise.all([
        server.connect(serverTransport),
        mcpClient.connect(clientTransport),
      ]);

      const result = await mcpClient.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'wiki_page_create',
        'wiki_page_get',
        'wiki_page_history',
        'wiki_page_update',
        'wiki_pages_tree',
        'wiki_search',
        'wiki_tags_list',
      ]);

      await mcpClient.close();
      await server.close();
    } finally {
      await store.close();
    }
  });

  it('rejects tools/call with MethodNotFound (single round-trip)', async () => {
    await writeConfig({
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    const store = await TokenStore.loadForBaseUrl(baseUrl);
    try {
      const client = new WikiClient({ tokenStore: store });
      const { server } = buildServer({ client });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: 'test-client', version: '0.0.0' },
        { capabilities: {} },
      );
      await Promise.all([
        server.connect(serverTransport),
        mcpClient.connect(clientTransport),
      ]);

      const err: unknown = await mcpClient
        .callTool({ name: 'nonexistent_tool', arguments: {} })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({ code: ErrorCode.MethodNotFound });

      await mcpClient.close();
      await server.close();
    } finally {
      await store.close();
    }
  });

  it('advertises the tools capability', async () => {
    await writeConfig({
      baseUrl,
      jwt: 'a.b.c',
      refreshedAt: '2026-05-18T12:00:00.000Z',
    });
    const store = await TokenStore.loadForBaseUrl(baseUrl);
    try {
      const client = new WikiClient({ tokenStore: store });
      const { server } = buildServer({ client });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcpClient = new Client(
        { name: 'test-client', version: '0.0.0' },
        { capabilities: {} },
      );
      await Promise.all([
        server.connect(serverTransport),
        mcpClient.connect(clientTransport),
      ]);

      const caps = mcpClient.getServerCapabilities();
      expect(caps?.tools).toBeDefined();

      await mcpClient.close();
      await server.close();
    } finally {
      await store.close();
    }
  });
});

describe('installShutdownHandlers', () => {
  type FakeProcessState = {
    listeners: Map<string, Array<() => void>>;
    exitCalls: number[];
    stderrChunks: string[];
  };

  function makeFakeProcess(): { proc: ShutdownProcess; state: FakeProcessState } {
    const state: FakeProcessState = {
      listeners: new Map(),
      exitCalls: [],
      stderrChunks: [],
    };
    const proc: ShutdownProcess = {
      on: (event, listener): unknown => {
        const arr = state.listeners.get(event) ?? [];
        arr.push(listener);
        state.listeners.set(event, arr);
        return proc;
      },
      exit: ((code: number) => {
        state.exitCalls.push(code);
        // Don't throw — tests want to inspect post-exit state. Real process.exit
        // never returns; the void cast keeps the return type honest.
        return undefined as never;
      }) as ShutdownProcess['exit'],
      stderr: {
        write: (chunk) => {
          state.stderrChunks.push(chunk);
          return true;
        },
      },
    };
    return { proc, state };
  }

  function makeFakeStore(opts: { closeDelay?: number; closeError?: Error } = {}): {
    close: () => Promise<void>;
    closeCalls: number;
  } {
    const ref = { closeCalls: 0 };
    return {
      get closeCalls() {
        return ref.closeCalls;
      },
      close: async (): Promise<void> => {
        ref.closeCalls += 1;
        if (opts.closeDelay !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, opts.closeDelay));
        }
        if (opts.closeError !== undefined) throw opts.closeError;
      },
    };
  }

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('SIGINT triggers graceful shutdown then exit(130)', async () => {
    const { proc, state } = makeFakeProcess();
    const store = makeFakeStore();
    const handle = installShutdownHandlers({ store, proc });
    handle.trigger('SIGINT');
    await wait(10);
    expect(store.closeCalls).toBe(1);
    expect(state.exitCalls).toEqual([130]);
    expect(state.stderrChunks.join('')).toContain('SIGINT received, shutting down');
  });

  it('SIGTERM triggers graceful shutdown then exit(143)', async () => {
    const { proc, state } = makeFakeProcess();
    const store = makeFakeStore();
    const handle = installShutdownHandlers({ store, proc });
    handle.trigger('SIGTERM');
    await wait(10);
    expect(store.closeCalls).toBe(1);
    expect(state.exitCalls).toEqual([143]);
  });

  it('beforeExit triggers store.close but does NOT call exit', async () => {
    const { proc, state } = makeFakeProcess();
    const store = makeFakeStore();
    const handle = installShutdownHandlers({ store, proc });
    handle.trigger('beforeExit');
    await wait(10);
    expect(store.closeCalls).toBe(1);
    expect(state.exitCalls).toEqual([]);
  });

  it('first signal is idempotent (second of same kind does NOT re-close)', async () => {
    const { proc } = makeFakeProcess();
    const store = makeFakeStore({ closeDelay: 30 });
    const handle = installShutdownHandlers({ store, proc });
    handle.trigger('SIGINT');
    handle.trigger('SIGINT'); // second SIGINT mid-shutdown
    await wait(60);
    expect(store.closeCalls).toBe(1); // close() only invoked once
  });

  it('second SIGINT during graceful shutdown force-exits immediately', async () => {
    const { proc, state } = makeFakeProcess();
    const store = makeFakeStore({ closeDelay: 50 });
    const handle = installShutdownHandlers({ store, proc });
    handle.trigger('SIGINT');
    // close() is in-flight (50ms). Second SIGINT must call exit immediately,
    // not wait for close.
    handle.trigger('SIGINT');
    expect(state.exitCalls).toEqual([130]); // synchronous force-exit
    expect(state.stderrChunks.join('')).toContain('received again, forcing exit');
    // Drain the still-running close() promise so it doesn't leak past the test.
    await wait(80);
  });

  it('logs and still exits when store.close() rejects', async () => {
    const { proc, state } = makeFakeProcess();
    const store = makeFakeStore({ closeError: new Error('disk on fire') });
    const handle = installShutdownHandlers({ store, proc });
    handle.trigger('SIGTERM');
    await wait(10);
    expect(state.exitCalls).toEqual([143]);
    expect(state.stderrChunks.join('')).toContain('shutdown error');
    expect(state.stderrChunks.join('')).toContain('disk on fire');
  });

  it('registers handlers for SIGINT, SIGTERM, and beforeExit', () => {
    const { proc, state } = makeFakeProcess();
    const store = makeFakeStore();
    installShutdownHandlers({ store, proc });
    expect(state.listeners.has('SIGINT')).toBe(true);
    expect(state.listeners.has('SIGTERM')).toBe(true);
    expect(state.listeners.has('beforeExit')).toBe(true);
  });
});
