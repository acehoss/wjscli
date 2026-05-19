import type { z } from 'zod';
import type { WikiClient } from '../wiki/client.js';

// MCP CallToolResult content shape we emit. Happy paths return a single
// `text` block carrying JSON-stringified output (see SPEC § "Output format").
// Tool-execution failures returned by the dispatcher carry `isError: true`
// plus a single text block with `{ code, message }` JSON; protocol failures
// (Zod parse, AuthExpired) instead throw McpError and never produce a
// ToolTextResult — see src/tools/index.ts dispatchTool.
export type ToolTextResult = {
  content: ReadonlyArray<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export type ToolHandler<TInput> = (
  input: TInput,
  client: WikiClient,
) => Promise<ToolTextResult>;

// Untyped JSON Schema document. The dispatcher casts to the SDK's Tool
// inputSchema type at the boundary.
export type JsonSchemaDoc = Record<string, unknown>;

// One tool definition. inputSchema is a Zod schema; we use z.infer to
// derive the handler's input type at compile time. Optional jsonSchemaPatch
// lets a tool tweak the generated JSON Schema before exposure — used by
// `wiki_page_get` to advertise the {id} XOR {path} constraint as `oneOf`
// (Zod refines can't express that in JSON Schema).
export type ToolDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: TSchema;
  handler: ToolHandler<z.infer<TSchema>>;
  jsonSchemaPatch?: (schema: JsonSchemaDoc) => JsonSchemaDoc;
};

// Existential erasure for the registry — each tool has its own concrete
// schema type, which is invariant in TSchema. Erasing through ZodTypeAny
// lets us store a heterogeneous array. Dispatcher rebinds via inputSchema.parse,
// which returns the schema's actual output type at runtime.
export type AnyToolDef = ToolDef<z.ZodTypeAny>;

// Standard "stringify to JSON text" helper. Pretty-printed for human
// readability; agents have no trouble with whitespace.
export function jsonResult(value: unknown): ToolTextResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
  };
}
