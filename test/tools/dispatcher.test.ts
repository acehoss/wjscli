import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  dispatchTool,
  listToolDescriptors,
  TOOL_DEFS,
} from '../../src/tools/index.js';
import { setupToolTest } from './_helpers.js';

const { ctx } = setupToolTest();

describe('tools dispatcher', () => {
  it('TOOL_DEFS contains all seven v1 tools', () => {
    const names = TOOL_DEFS.map((d) => d.name).sort();
    expect(names).toEqual([
      'wiki_page_create',
      'wiki_page_get',
      'wiki_page_history',
      'wiki_page_update',
      'wiki_pages_tree',
      'wiki_search',
      'wiki_tags_list',
    ]);
  });

  it('listToolDescriptors returns a JSON-Schema-shaped inputSchema for every tool', () => {
    const descriptors = listToolDescriptors();
    expect(descriptors).toHaveLength(7);
    for (const d of descriptors) {
      // MCP requires inputSchema be a JSON Schema object — `type: "object"` at root.
      const schema = d.inputSchema as { type?: string };
      expect(schema.type).toBe('object');
      expect(typeof d.description).toBe('string');
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown tool name with MethodNotFound', async () => {
    const { client } = ctx();
    const err = await dispatchTool('wiki_not_a_thing', {}, client).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('tolerates undefined arguments (treats as empty object)', async () => {
    // A no-input tool (wiki_tags_list) should accept undefined arguments.
    const { mock, client } = ctx();
    mock.replyToTagsList([]);
    const result = await dispatchTool('wiki_tags_list', undefined, client);
    expect(result.content[0]?.type).toBe('text');
  });

  it('multi-issue Zod failure surfaces every failing path in InvalidParams', async () => {
    // wiki_page_create requires path: non-empty string, title: non-empty,
    // content: string. Send empty strings for path AND title to force two
    // simultaneous Zod issues; the dispatcher must list both, with the
    // `; ` separator and both field names visible.
    const { client } = ctx();
    const err = await dispatchTool(
      'wiki_page_create',
      { path: '', title: '', content: '' },
      client,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).toMatchObject({ code: ErrorCode.InvalidParams });
    const msg = (err as McpError).message;
    expect(msg).toMatch(/path/);
    expect(msg).toMatch(/title/);
    expect(msg).toMatch(/;/);
  });

  it('no tool emits oneOf/anyOf/allOf at the top level of its JSON Schema', () => {
    // The Anthropic Messages API rejects top-level oneOf/anyOf/allOf in tool
    // input_schema with HTTP 400. The MCP spec and JSON Schema both allow it,
    // but we have to stay within Anthropic's stricter subset for Claude
    // Desktop and the API to accept the tool list. This test pins that
    // invariant — if a future ToolDef tries to add one via jsonSchemaPatch
    // or by a Zod union/intersection at the root, this will catch it.
    for (const d of listToolDescriptors()) {
      const schema = d.inputSchema as Record<string, unknown>;
      for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        expect(schema[key], `${d.name} must not have top-level ${key}`).toBeUndefined();
      }
    }
  });
});
