import { describe, expect, it } from 'vitest';
import type { Page } from '../../src/wiki/queries.js';
import {
  contentHash,
  deserializePage,
  fileToPath,
  pathToFile,
  serializePage,
} from '../../src/sync/format.js';

function page(over: Partial<Page> = {}): Page {
  return {
    id: 42,
    path: 'team/onboarding',
    hash: 'h',
    title: 'Onboarding',
    description: 'How to start',
    isPrivate: false,
    isPublished: true,
    privateNS: null,
    publishStartDate: '',
    publishEndDate: '',
    tags: [
      {
        id: 1,
        tag: 'guide',
        title: 'Guide',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ],
    content: '# Welcome\n\nSome body content.',
    render: null,
    contentType: 'markdown',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-05-19T00:00:00Z',
    editor: 'markdown',
    locale: 'en',
    scriptCss: null,
    scriptJs: null,
    authorId: 7,
    authorName: 'Aaron',
    authorEmail: 'aaron@example.com',
    creatorId: 7,
    creatorName: 'Aaron',
    creatorEmail: 'aaron@example.com',
    ...over,
  };
}

describe('serializePage', () => {
  it('begins with --- and includes core frontmatter keys', () => {
    const text = serializePage(page());
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('id: 42');
    expect(text).toContain('path: team/onboarding');
    expect(text).toContain('title: Onboarding');
    expect(text).toContain('locale: en');
    expect(text).toContain('isPublished: true');
  });

  it('flattens tags to a plain string list', () => {
    const text = serializePage(page());
    expect(text).toMatch(/tags:\s*\n\s*-\s*guide/);
  });

  it('includes the body after the closing --- delimiter', () => {
    const text = serializePage(page());
    expect(text).toMatch(/---\n# Welcome/);
    expect(text).toContain('Some body content.');
  });
});

describe('deserializePage', () => {
  it('round-trips a serialized page', () => {
    const text = serializePage(page());
    const { frontmatter, body } = deserializePage(text);
    expect(frontmatter.id).toBe(42);
    expect(frontmatter.path).toBe('team/onboarding');
    expect(frontmatter.title).toBe('Onboarding');
    expect(frontmatter.tags).toEqual(['guide']);
    expect(body).toBe('# Welcome\n\nSome body content.');
  });

  it('preserves a body that itself contains "---" lines', () => {
    // Our parser only consumes the FIRST `---` block; subsequent triple-
    // dashes in the body must pass through unchanged.
    const body = '# Title\n\nSection\n\n---\n\nAnother section\n';
    const text = serializePage(page({ content: body }));
    const { body: out } = deserializePage(text);
    expect(out).toBe(body);
  });

  it('rejects a file with no leading --- delimiter', () => {
    expect(() => deserializePage('title: Foo\n')).toThrow(/missing leading/);
  });

  it('rejects an unterminated frontmatter block', () => {
    expect(() =>
      deserializePage('---\nid: 1\ntitle: t\n\nbody here'),
    ).toThrow(/unterminated/);
  });

  it('rejects when a required field has the wrong type', () => {
    const text = '---\nid: not-a-number\npath: foo\n---\nbody';
    expect(() => deserializePage(text)).toThrow(/`id`/);
  });

  it('rejects when tags is not an array', () => {
    const text =
      '---\nid: 1\npath: foo\ntitle: t\nlocale: en\neditor: markdown\n' +
      'isPublished: true\nisPrivate: false\ntags: not-a-list\n---\nbody';
    expect(() => deserializePage(text)).toThrow(/tags/);
  });
});

describe('contentHash', () => {
  it('is deterministic for the same input', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('produces different output for different input', () => {
    expect(contentHash('hello')).not.toBe(contentHash('hello!'));
  });

  it('is a 64-char hex string (sha-256)', () => {
    expect(contentHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pathToFile / fileToPath', () => {
  it('appends .md to a single-segment path', () => {
    expect(pathToFile('home')).toBe('home.md');
    expect(fileToPath('home.md')).toBe('home');
  });

  it('preserves the directory structure', () => {
    expect(pathToFile('team/onboarding')).toBe('team/onboarding.md');
    expect(fileToPath('team/onboarding.md')).toBe('team/onboarding');
  });

  it('rejects empty segments and traversal', () => {
    expect(() => pathToFile('')).toThrow();
    expect(() => pathToFile('foo//bar')).toThrow(/suspicious/);
    expect(() => pathToFile('../escape')).toThrow(/suspicious/);
    expect(() => pathToFile('foo/..')).toThrow(/suspicious/);
  });

  it('rejects NUL bytes', () => {
    expect(() => pathToFile('foo\0bar')).toThrow(/suspicious/);
  });
});
