// All response types in this file are hand-written against
// repos/wiki/server/graph/schemas/page.graphql and the corresponding
// resolvers under repos/wiki/server/graph/resolvers/. When upstream changes,
// update here. Do not codegen — seven queries doesn't justify the machinery.

// -----------------------------------------------------------------------------
// users.profile (bootstrap probe)
// -----------------------------------------------------------------------------
//
// `users.profile` is the only user-query field on Wiki.js v2 with no @auth
// directive at the schema level, but its resolver explicitly rejects guests
// (user.id < 1 || user.id === 2 throws AuthRequired). So any authenticated
// user can call it regardless of permissions — making it the cheapest probe
// that confirms identity AND fails cleanly on an expired JWT.
//
// Source: repos/wiki/server/graph/resolvers/user.js (the `profile` resolver).
export const PROBE_QUERY = `query {
  users {
    profile {
      id
      email
      name
    }
  }
}`;

export type ProbeProfile = {
  id: number;
  email: string;
  name: string;
};

export type ProbeResponse = {
  users: {
    profile: ProbeProfile;
  };
};

// -----------------------------------------------------------------------------
// Shared ResponseStatus shape (mutations)
// -----------------------------------------------------------------------------
// repos/wiki/server/helpers/graph.js + common.graphql
export type ResponseStatus = {
  succeeded: boolean;
  errorCode: number;
  slug: string;
  message: string;
};

// -----------------------------------------------------------------------------
// pages.tree
// -----------------------------------------------------------------------------
// Mode is required by the schema. SPEC says default ALL/en/0.
export const PAGES_TREE_QUERY = `query ($parent: Int, $mode: PageTreeMode!, $locale: String!) {
  pages {
    tree(parent: $parent, mode: $mode, locale: $locale) {
      id
      path
      depth
      title
      isPrivate
      isFolder
      privateNS
      parent
      pageId
      locale
    }
  }
}`;

export type PageTreeMode = 'ALL' | 'PAGES' | 'FOLDERS';

export type PageTreeItem = {
  id: number;
  path: string;
  depth: number;
  title: string;
  isPrivate: boolean;
  isFolder: boolean;
  privateNS: string | null;
  // Resolver coerces null → 0 (`r.parent || 0`); tighten to non-null.
  parent: number;
  pageId: number | null;
  locale: string;
};

export type PagesTreeResponse = {
  pages: {
    tree: PageTreeItem[] | null;
  };
};

// -----------------------------------------------------------------------------
// pages.single / pages.singleByPath
// -----------------------------------------------------------------------------
// Page selection here is conservative: includes fields the SPEC documents
// AND fields that are @auth-gated on `write:pages, manage:system`. Wiki.js
// will return GraphQL errors for any gated field the user can't read; that
// surfaces to the caller as a `GraphQLError` so they know to ask for less.
// If we wanted to be stricter we'd offer a `minimal` mode that drops the
// gated set, but for v1 the unified shape is simpler.
const PAGE_FIELDS = `
  id
  path
  hash
  title
  description
  isPrivate
  isPublished
  privateNS
  publishStartDate
  publishEndDate
  tags {
    id
    tag
    title
    createdAt
    updatedAt
  }
  content
  render
  contentType
  createdAt
  updatedAt
  editor
  locale
  scriptCss
  scriptJs
  authorId
  authorName
  authorEmail
  creatorId
  creatorName
  creatorEmail
`;

export const PAGE_SINGLE_QUERY = `query ($id: Int!) {
  pages {
    single(id: $id) {${PAGE_FIELDS}}
  }
}`;

export const PAGE_SINGLE_BY_PATH_QUERY = `query ($path: String!, $locale: String!) {
  pages {
    singleByPath(path: $path, locale: $locale) {${PAGE_FIELDS}}
  }
}`;

export type PageTag = {
  id: number;
  tag: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Page = {
  id: number;
  path: string;
  hash: string;
  title: string;
  description: string;
  isPrivate: boolean;
  isPublished: boolean;
  privateNS: string | null;
  publishStartDate: string;
  publishEndDate: string;
  tags: PageTag[];
  content: string;
  render: string | null;
  // Note: `toc` is intentionally NOT selected. Wiki.js's GraphQL schema
  // declares it as `String` but its Postgres-backed model returns the
  // already-parsed array, which fails server-side response serialization
  // ("String cannot represent value: [...]"). This is an upstream Wiki.js
  // bug — every Page read against a Postgres-backed instance errors out
  // when toc is in the selection set. We never used toc, so we drop it.
  contentType: string;
  createdAt: string;
  updatedAt: string;
  editor: string;
  locale: string;
  scriptCss: string | null;
  scriptJs: string | null;
  authorId: number;
  authorName: string;
  authorEmail: string;
  creatorId: number;
  creatorName: string;
  creatorEmail: string;
};

export type PageSingleResponse = {
  pages: {
    single: Page | null;
  };
};

export type PageSingleByPathResponse = {
  pages: {
    singleByPath: Page | null;
  };
};

// -----------------------------------------------------------------------------
// pages.create mutation
// -----------------------------------------------------------------------------
// All listed args are `!` in the schema (page.graphql:87-101). We must send
// every one, even if blank — the tool's defaults (description="", editor=
// "markdown", locale="en", tags=[], isPublished=true, isPrivate=false) fill
// in what the user didn't specify.
export const PAGE_CREATE_MUTATION = `mutation (
  $content: String!,
  $description: String!,
  $editor: String!,
  $isPublished: Boolean!,
  $isPrivate: Boolean!,
  $locale: String!,
  $path: String!,
  $tags: [String]!,
  $title: String!
) {
  pages {
    create(
      content: $content,
      description: $description,
      editor: $editor,
      isPublished: $isPublished,
      isPrivate: $isPrivate,
      locale: $locale,
      path: $path,
      tags: $tags,
      title: $title
    ) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
      page {
        id
        path
        title
        isPrivate
        isPublished
        createdAt
        updatedAt
      }
    }
  }
}`;

// Note: `locale` and `editor` are intentionally omitted from the create/update
// page sub-selection. Wiki.js's mutation resolvers return the raw model row
// from `getPageFromDb`, which selects `editorKey` and `localeCode` — NOT
// `editor`/`locale` (see repos/wiki/server/models/pages.js getPageFromDb and
// repos/wiki/server/graph/resolvers/page.js: the field-level aliases that
// translate localeCode→locale and editorKey→editor only exist on the query
// resolvers for `single`/`singleByPath`/`tree`, not on the mutation path).
// Selecting them after a mutation produces a non-null-violation GraphQL error
// that nulls the entire `page` payload. Callers needing those fields can
// `wiki_page_get` the page by id afterward.
export type CreatedPageSummary = {
  id: number;
  path: string;
  title: string;
  isPrivate: boolean;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PageCreateResponse = {
  pages: {
    create: {
      responseResult: ResponseStatus;
      page: CreatedPageSummary | null;
    };
  };
};

// -----------------------------------------------------------------------------
// pages.update mutation (partial)
// -----------------------------------------------------------------------------
// Schema (page.graphql:103-118) makes only `id` required. We construct the
// mutation document and variable set at runtime to send only the fields the
// caller supplied — Wiki.js will leave omitted fields untouched.
//
// We expose a helper rather than a static query string here.
export const PAGE_UPDATE_FIELDS = [
  'content',
  'description',
  'editor',
  'isPrivate',
  'isPublished',
  'locale',
  'path',
  'tags',
  'title',
] as const;

export type PageUpdateField = (typeof PAGE_UPDATE_FIELDS)[number];

const PAGE_UPDATE_FIELD_TYPES: Readonly<Record<PageUpdateField, string>> = {
  content: 'String',
  description: 'String',
  editor: 'String',
  isPrivate: 'Boolean',
  isPublished: 'Boolean',
  locale: 'String',
  path: 'String',
  tags: '[String]',
  title: 'String',
};

export function buildPageUpdateMutation(fields: ReadonlyArray<PageUpdateField>): string {
  if (fields.length === 0) {
    throw new Error(
      'buildPageUpdateMutation: at least one field required besides `id` ' +
        '(a no-op update would still send a GraphQL request).',
    );
  }
  for (const f of fields) {
    if (!PAGE_UPDATE_FIELDS.includes(f)) {
      throw new Error(`buildPageUpdateMutation: unknown field: ${f as string}`);
    }
  }
  const varDecls = ['$id: Int!', ...fields.map((f) => `$${f}: ${PAGE_UPDATE_FIELD_TYPES[f]}`)];
  const args = ['id: $id', ...fields.map((f) => `${f}: $${f}`)];
  // Page sub-selection MUST match PAGE_CREATE_MUTATION's (same MF1 reason —
  // `locale`/`editor` are unresolved on the mutation return path).
  return `mutation (${varDecls.join(', ')}) {
  pages {
    update(${args.join(', ')}) {
      responseResult {
        succeeded
        errorCode
        slug
        message
      }
      page {
        id
        path
        title
        isPrivate
        isPublished
        createdAt
        updatedAt
      }
    }
  }
}`;
}

export type PageUpdateResponse = {
  pages: {
    update: {
      responseResult: ResponseStatus;
      page: CreatedPageSummary | null;
    };
  };
};

// -----------------------------------------------------------------------------
// pages.search
// -----------------------------------------------------------------------------
export const PAGE_SEARCH_QUERY = `query ($query: String!, $locale: String) {
  pages {
    search(query: $query, locale: $locale) {
      results {
        id
        title
        description
        path
        locale
      }
      suggestions
      totalHits
    }
  }
}`;

export type PageSearchResult = {
  id: string;
  title: string;
  description: string;
  path: string;
  locale: string;
};

export type PageSearchResponse = {
  pages: {
    search: {
      results: PageSearchResult[];
      suggestions: string[];
      totalHits: number;
    };
  };
};

// -----------------------------------------------------------------------------
// pages.tags
// -----------------------------------------------------------------------------
export const PAGE_TAGS_QUERY = `query {
  pages {
    tags {
      id
      tag
      title
      createdAt
      updatedAt
    }
  }
}`;

export type PageTagsResponse = {
  pages: {
    // Schema (page.graphql:54) declares `tags: [PageTag]!` — non-null array.
    tags: PageTag[];
  };
};

// -----------------------------------------------------------------------------
// pages.history
// -----------------------------------------------------------------------------
export const PAGE_HISTORY_QUERY = `query ($id: Int!, $offsetPage: Int, $offsetSize: Int) {
  pages {
    history(id: $id, offsetPage: $offsetPage, offsetSize: $offsetSize) {
      trail {
        versionId
        versionDate
        authorId
        authorName
        actionType
        valueBefore
        valueAfter
      }
      total
    }
  }
}`;

export type PageHistoryEntry = {
  versionId: number;
  versionDate: string;
  authorId: number;
  authorName: string;
  actionType: string;
  valueBefore: string | null;
  valueAfter: string | null;
};

export type PageHistoryResponse = {
  pages: {
    history: {
      trail: PageHistoryEntry[] | null;
      total: number;
    };
  };
};
