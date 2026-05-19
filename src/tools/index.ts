import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { ZodError } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AuthExpiredError,
  WikiMcpError,
} from '../util/errors.js';
import type { WikiClient } from '../wiki/client.js';
import { pageCreateTool } from './page-create.js';
import { pageGetTool } from './page-get.js';
import { pageHistoryTool } from './page-history.js';
import { pagesTreeTool } from './pages-tree.js';
import { pageUpdateTool } from './page-update.js';
import { searchTool } from './search.js';
import { tagsListTool } from './tags-list.js';
import type { AnyToolDef, JsonSchemaDoc, ToolTextResult } from './types.js';

// Exported for tests: per-tool handlers can be invoked directly without
// going through the MCP plumbing. Cast through AnyToolDef is the
// existential-erasure step — see types.ts.
export const TOOL_DEFS: ReadonlyArray<AnyToolDef> = [
  pagesTreeTool,
  pageGetTool,
  pageCreateTool,
  pageUpdateTool,
  searchTool,
  tagsListTool,
  pageHistoryTool,
] as ReadonlyArray<AnyToolDef>;

// JSON Schema produced by zod-to-json-schema is structurally a JSON Schema
// document. The MCP SDK's `Tool.inputSchema` is typed loosely; cast through
// `unknown` once here, in the place that knows it's safe.
type AnyJsonSchema = Tool['inputSchema'];

function toolDescriptor(def: AnyToolDef): Tool {
  // zod-to-json-schema's parameter type narrowly demands a concrete Zod
  // schema; AnyToolDef.inputSchema is ZodTypeAny. Both are structurally the
  // same Zod schema interface at runtime — narrow the cast at this one site
  // rather than threading concrete schema types through TOOL_DEFS.
  const rawSchema = zodToJsonSchema(def.inputSchema as Parameters<typeof zodToJsonSchema>[0], {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });
  const baseSchema: JsonSchemaDoc = rawSchema;
  const patched =
    def.jsonSchemaPatch !== undefined ? def.jsonSchemaPatch(baseSchema) : baseSchema;
  const inputSchema = patched as unknown as AnyJsonSchema;
  return {
    name: def.name,
    description: def.description,
    inputSchema,
  };
}

export function listToolDescriptors(): Tool[] {
  return TOOL_DEFS.map(toolDescriptor);
}

// Run a single tool by name with the given raw arguments object. Used by
// the MCP CallTool dispatcher and by tests. Throws McpError for
// argument-validation failures and auth-expiry; other WikiMcpError
// subclasses propagate so the SDK serializes them with isError=true.
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  client: WikiClient,
): Promise<ToolTextResult> {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (def === undefined) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  let input: z.infer<typeof def.inputSchema>;
  try {
    // .parse returns the schema's inferred output type, which is `any` when
    // the schema is ZodTypeAny (existentially erased in TOOL_DEFS — see
    // types.ts). The handler's own input type re-narrows it.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    input = def.inputSchema.parse(rawArgs ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.issues
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`)
        .join('; ');
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for ${name}: ${detail}`,
      );
    }
    throw err;
  }
  try {
    return await def.handler(input, client);
  } catch (err) {
    // Three-tier error strategy (see SPEC § "MCP tools (v1)"):
    //
    //  1. AuthExpiredError → McpError(InvalidRequest). The agent can't make
    //     progress without user action (re-bootstrap), so a JSON-RPC error
    //     with the rebootstrap-guidance message is the right surface.
    //
    //  2. Other WikiMcpError subclasses (HttpError, NetworkError, GraphQLError,
    //     config errors) → return { isError: true, content: [{type:'text',
    //     text: JSON.stringify({code, message})}] }. These are tool-execution
    //     failures the agent might recover from or report; structured content
    //     gives it the error code + message, parity-formatted with happy-path
    //     output (pretty JSON in a text block). Message has already been
    //     through the WikiClient JWT redactor.
    //
    //  3. Anything truly unexpected → re-throw; the SDK wraps as
    //     -32603 InternalError.
    if (err instanceof AuthExpiredError) {
      throw new McpError(ErrorCode.InvalidRequest, err.message);
    }
    if (err instanceof WikiMcpError) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { code: err.code, message: err.message },
              null,
              2,
            ),
          },
        ],
      };
    }
    throw err;
  }
}

// Wire the seven tools onto an MCP Server. Phase 3 had buildServer register
// empty handlers; we replace those here.
export function registerTools(server: Server, client: WikiClient): void {
  const descriptors = listToolDescriptors();

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({ tools: descriptors }),
  );

  server.setRequestHandler(CallToolRequestSchema, (req) =>
    dispatchTool(req.params.name, req.params.arguments, client),
  );
}
