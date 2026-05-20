import { promises as fs } from 'node:fs';

// Minimal argv reader. Recognizes:
//   --flag=value           → flag "flag" has value "value"
//   --flag value           → if `value` does not begin with "--", consumed as the flag's value
//   --flag                 → boolean: empty-string value
//   --no-flag              → boolean: handler reads "no-flag" to mean false
//   --                     → all remaining args are positionals
//   anything else          → positional
//
// Repeated flags collect into an array on the same name.
//
// Negative numbers like `--id -1` are accepted because the value-consuming
// check only blocks values that start with "--", not "-".
export type ParsedArgv = {
  positionals: string[];
  flags: Map<string, string[]>;
};

export function readArgv(args: ReadonlyArray<string>): ParsedArgv {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '--') {
      for (let j = i + 1; j < args.length; j++) {
        positionals.push(args[j] ?? '');
      }
      break;
    }
    if (a.startsWith('--')) {
      let name: string;
      let value: string;
      const eq = a.indexOf('=');
      if (eq !== -1) {
        name = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        name = a.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        } else {
          value = '';
        }
      }
      const cur = flags.get(name) ?? [];
      cur.push(value);
      flags.set(name, cur);
      i++;
      continue;
    }
    positionals.push(a);
    i++;
  }
  return { positionals, flags };
}

// CLI input failures are reported to the user via stderr and exit 2; this
// error carries the user-facing message so the dispatcher can route it.
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

// Resolve a string value, optionally indirected:
//   "@-"          → read from stdin
//   "@path"       → read from file path
//   anything else → returned as-is
export async function resolveStringValue(raw: string): Promise<string> {
  if (raw === '@-') {
    return await readStdin();
  }
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      throw new CliUsageError(
        `failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return raw;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Helper: read a single optional string-valued flag. Throws if the flag was
// provided more than once.
export function takeOptionalString(
  flags: Map<string, string[]>,
  name: string,
): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  if (values.length > 1) {
    throw new CliUsageError(`--${name} given multiple times; expected at most one`);
  }
  flags.delete(name);
  return values[0];
}

// Helper: read a single required string-valued flag.
export function takeRequiredString(
  flags: Map<string, string[]>,
  name: string,
): string {
  const v = takeOptionalString(flags, name);
  if (v === undefined || v.length === 0) {
    throw new CliUsageError(`--${name} is required`);
  }
  return v;
}

// Helper: read an optional integer-valued flag.
export function takeOptionalInt(
  flags: Map<string, string[]>,
  name: string,
): number | undefined {
  const raw = takeOptionalString(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new CliUsageError(`--${name} expects an integer (got ${raw})`);
  }
  return n;
}

// Helper: read a repeated string-valued flag → array (default []).
export function takeStringArray(
  flags: Map<string, string[]>,
  name: string,
): string[] | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  flags.delete(name);
  // Allow comma-split convenience in addition to repeated flags:
  // --tag a,b,c is equivalent to --tag a --tag b --tag c.
  const out: string[] = [];
  for (const v of values) {
    for (const piece of v.split(',')) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

// Helper: read a boolean toggle exposed as --<name> / --no-<name>. Returns
// undefined if neither is present, true/false otherwise. Throws if both
// forms appear.
export function takeBoolean(
  flags: Map<string, string[]>,
  name: string,
): boolean | undefined {
  const posValues = flags.get(name);
  const negValues = flags.get(`no-${name}`);
  if (posValues !== undefined && negValues !== undefined) {
    throw new CliUsageError(`--${name} and --no-${name} are mutually exclusive`);
  }
  if (posValues !== undefined) {
    flags.delete(name);
    // Allow --flag=true / --flag=false too, for symmetry with other flags.
    const v = posValues[posValues.length - 1] ?? '';
    if (v === '' || v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    throw new CliUsageError(`--${name} expects a boolean (got ${v})`);
  }
  if (negValues !== undefined) {
    flags.delete(`no-${name}`);
    return false;
  }
  return undefined;
}

// After all known flags have been consumed, fail if any remain.
export function rejectUnknownFlags(flags: Map<string, string[]>): void {
  if (flags.size === 0) return;
  const names = Array.from(flags.keys())
    .map((k) => `--${k}`)
    .join(', ');
  throw new CliUsageError(`unknown flag(s): ${names}`);
}
