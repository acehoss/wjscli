import { describe, expect, it } from 'vitest';
import {
  CliUsageError,
  readArgv,
  rejectUnknownFlags,
  takeBoolean,
  takeOptionalInt,
  takeOptionalString,
  takeRequiredString,
  takeStringArray,
} from '../../src/cli/argv.js';

describe('readArgv', () => {
  it('captures positional args', () => {
    const r = readArgv(['a', 'b', 'c']);
    expect(r.positionals).toEqual(['a', 'b', 'c']);
    expect(r.flags.size).toBe(0);
  });

  it('handles --flag=value', () => {
    const r = readArgv(['--name=alice', '--age=30']);
    expect(r.flags.get('name')).toEqual(['alice']);
    expect(r.flags.get('age')).toEqual(['30']);
  });

  it('handles --flag value (next arg form)', () => {
    const r = readArgv(['--name', 'alice', '--age', '30']);
    expect(r.flags.get('name')).toEqual(['alice']);
    expect(r.flags.get('age')).toEqual(['30']);
  });

  it('handles boolean --flag (no value, end of args)', () => {
    const r = readArgv(['--verbose']);
    expect(r.flags.get('verbose')).toEqual(['']);
  });

  it('handles boolean --flag followed by another flag', () => {
    // The next-arg lookahead only consumes non-flag tokens; `--other` is left
    // alone, so `--verbose` resolves to boolean (empty-string value).
    const r = readArgv(['--verbose', '--other', 'x']);
    expect(r.flags.get('verbose')).toEqual(['']);
    expect(r.flags.get('other')).toEqual(['x']);
  });

  it('consumes a non-flag next arg as the flag value', () => {
    // The flip side of the above: `--name foo` → flag=foo, not boolean.
    // To force a positional after a boolean flag, use `--flag=` or `--`.
    const r = readArgv(['--name', 'foo']);
    expect(r.flags.get('name')).toEqual(['foo']);
    expect(r.positionals).toEqual([]);
  });

  it('handles repeated flags as arrays', () => {
    const r = readArgv(['--tag', 'a', '--tag', 'b', '--tag', 'c']);
    expect(r.flags.get('tag')).toEqual(['a', 'b', 'c']);
  });

  it('accepts negative numbers as values', () => {
    const r = readArgv(['--id', '-1']);
    expect(r.flags.get('id')).toEqual(['-1']);
  });

  it('-- separator turns subsequent args into positionals', () => {
    const r = readArgv(['--name', 'alice', '--', '--not-a-flag', 'pos']);
    expect(r.flags.get('name')).toEqual(['alice']);
    expect(r.positionals).toEqual(['--not-a-flag', 'pos']);
  });
});

describe('takeOptionalString', () => {
  it('returns undefined when flag absent', () => {
    const flags = new Map<string, string[]>();
    expect(takeOptionalString(flags, 'name')).toBeUndefined();
  });

  it('returns value when flag present', () => {
    const flags = new Map<string, string[]>([['name', ['alice']]]);
    expect(takeOptionalString(flags, 'name')).toBe('alice');
    expect(flags.has('name')).toBe(false);
  });

  it('throws on multi-valued flag', () => {
    const flags = new Map<string, string[]>([['name', ['alice', 'bob']]]);
    expect(() => takeOptionalString(flags, 'name')).toThrow(CliUsageError);
  });
});

describe('takeRequiredString', () => {
  it('throws when flag absent', () => {
    const flags = new Map<string, string[]>();
    expect(() => takeRequiredString(flags, 'name')).toThrow(CliUsageError);
  });

  it('throws when flag has empty value', () => {
    const flags = new Map<string, string[]>([['name', ['']]]);
    expect(() => takeRequiredString(flags, 'name')).toThrow(CliUsageError);
  });
});

describe('takeOptionalInt', () => {
  it('parses an integer string', () => {
    const flags = new Map<string, string[]>([['id', ['42']]]);
    expect(takeOptionalInt(flags, 'id')).toBe(42);
  });

  it('throws on non-integer', () => {
    const flags = new Map<string, string[]>([['id', ['abc']]]);
    expect(() => takeOptionalInt(flags, 'id')).toThrow(CliUsageError);
  });

  it('throws on decimal', () => {
    const flags = new Map<string, string[]>([['id', ['1.5']]]);
    expect(() => takeOptionalInt(flags, 'id')).toThrow(CliUsageError);
  });
});

describe('takeStringArray', () => {
  it('returns undefined when absent', () => {
    const flags = new Map<string, string[]>();
    expect(takeStringArray(flags, 'tag')).toBeUndefined();
  });

  it('preserves order of repeated flags', () => {
    const flags = new Map<string, string[]>([['tag', ['a', 'b', 'c']]]);
    expect(takeStringArray(flags, 'tag')).toEqual(['a', 'b', 'c']);
  });

  it('splits comma-separated values within a single flag', () => {
    const flags = new Map<string, string[]>([['tag', ['a,b,c']]]);
    expect(takeStringArray(flags, 'tag')).toEqual(['a', 'b', 'c']);
  });

  it('combines repeated + comma-separated', () => {
    const flags = new Map<string, string[]>([['tag', ['a,b', 'c', 'd,e']]]);
    expect(takeStringArray(flags, 'tag')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops empty pieces', () => {
    const flags = new Map<string, string[]>([['tag', ['a,,b']]]);
    expect(takeStringArray(flags, 'tag')).toEqual(['a', 'b']);
  });
});

describe('takeBoolean', () => {
  it('returns undefined when neither --flag nor --no-flag', () => {
    const flags = new Map<string, string[]>();
    expect(takeBoolean(flags, 'published')).toBeUndefined();
  });

  it('returns true on --flag (empty value)', () => {
    const flags = new Map<string, string[]>([['published', ['']]]);
    expect(takeBoolean(flags, 'published')).toBe(true);
  });

  it('returns false on --no-flag', () => {
    const flags = new Map<string, string[]>([['no-published', ['']]]);
    expect(takeBoolean(flags, 'published')).toBe(false);
  });

  it('throws when --flag and --no-flag both present', () => {
    const flags = new Map<string, string[]>([
      ['published', ['']],
      ['no-published', ['']],
    ]);
    expect(() => takeBoolean(flags, 'published')).toThrow(CliUsageError);
  });

  it('accepts --flag=true/false/0/1/yes/no', () => {
    expect(takeBoolean(new Map([['x', ['true']]]), 'x')).toBe(true);
    expect(takeBoolean(new Map([['x', ['false']]]), 'x')).toBe(false);
    expect(takeBoolean(new Map([['x', ['1']]]), 'x')).toBe(true);
    expect(takeBoolean(new Map([['x', ['0']]]), 'x')).toBe(false);
    expect(takeBoolean(new Map([['x', ['yes']]]), 'x')).toBe(true);
    expect(takeBoolean(new Map([['x', ['no']]]), 'x')).toBe(false);
  });

  it('throws on invalid boolean text', () => {
    const flags = new Map<string, string[]>([['x', ['maybe']]]);
    expect(() => takeBoolean(flags, 'x')).toThrow(CliUsageError);
  });
});

describe('rejectUnknownFlags', () => {
  it('passes silently when no flags remain', () => {
    expect(() => rejectUnknownFlags(new Map())).not.toThrow();
  });

  it('throws with a list of unknowns', () => {
    const flags = new Map<string, string[]>([
      ['weird', ['']],
      ['mystery', ['1']],
    ]);
    expect(() => rejectUnknownFlags(flags)).toThrow(/--weird/);
  });
});
