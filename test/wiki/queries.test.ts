import { describe, expect, it } from 'vitest';
import {
  buildPageUpdateMutation,
  PAGE_CREATE_MUTATION,
  PAGE_UPDATE_FIELDS,
  type PageUpdateField,
} from '../../src/wiki/queries.js';

describe('buildPageUpdateMutation', () => {
  it('builds a mutation declaring only the requested variables', () => {
    const mutation = buildPageUpdateMutation(['title', 'tags']);
    expect(mutation).toMatch(/\$id: Int!/);
    expect(mutation).toMatch(/\$title: String/);
    expect(mutation).toMatch(/\$tags: \[String\]/);
    expect(mutation).not.toMatch(/\$content:/);
    expect(mutation).not.toMatch(/\$path:/);
  });

  it('accepts every field in PAGE_UPDATE_FIELDS', () => {
    expect(() => buildPageUpdateMutation(PAGE_UPDATE_FIELDS)).not.toThrow();
  });

  it('throws on an empty field list', () => {
    expect(() => buildPageUpdateMutation([])).toThrow(/at least one field/);
  });

  it('throws on an unknown field even when type-cast', () => {
    // Bypass the type to simulate a misuse from a future refactor that
    // drops the const tuple's type narrowing.
    const bogus = ['definitely_not_a_field'] as unknown as ReadonlyArray<PageUpdateField>;
    expect(() => buildPageUpdateMutation(bogus)).toThrow(/unknown field/);
  });

  it('returned page sub-selection does NOT include locale or editor (MF1)', () => {
    // Wiki.js's mutation resolvers can't resolve `locale` / `editor` —
    // their getPageFromDb returns `localeCode`/`editorKey` instead, and the
    // field-level aliases don't run on the mutation path. Selecting them
    // would null the whole page payload via non-null violations.
    const mutation = buildPageUpdateMutation(['title']);
    // Allowed: locale/editor declared as INPUT variables (we still send
    // updates to those columns). Forbidden: locale/editor in the returned
    // `page { ... }` sub-selection.
    const pageBlock = mutation.match(/page \{([\s\S]+?)\}/)?.[1] ?? '';
    expect(pageBlock).not.toMatch(/\blocale\b/);
    expect(pageBlock).not.toMatch(/\beditor\b/);
  });
});

describe('PAGE_CREATE_MUTATION', () => {
  it('page sub-selection does NOT include locale or editor (MF1)', () => {
    // Static mirror of the buildPageUpdateMutation pin — PAGE_CREATE_MUTATION
    // is a const string that wouldn't get re-rendered, so a future edit
    // re-introducing locale/editor here would slip through the update-side
    // test. Same MF1 reasoning applies.
    const pageBlock = PAGE_CREATE_MUTATION.match(/page \{([\s\S]+?)\}/)?.[1] ?? '';
    expect(pageBlock).not.toMatch(/\blocale\b/);
    expect(pageBlock).not.toMatch(/\beditor\b/);
  });
});
