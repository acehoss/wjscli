import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalizeBaseUrl } from '../config.js';
import { MissingConfigError } from '../util/errors.js';
import { TokenStore } from '../util/token-store.js';
import { WikiClient } from '../wiki/client.js';
import {
  PAGE_SINGLE_QUERY,
  PAGES_TREE_QUERY,
  type Page,
  type PageSingleResponse,
  type PagesTreeResponse,
} from '../wiki/queries.js';
import { contentHash, pathToFile, serializePage } from './format.js';
import { initRepo, writeIndex, type SyncIndexEntry } from './repo.js';

// Parallelism cap for the per-page fetch storm during a clone. Tuned by
// intuition rather than measurement — high enough to amortise round-trip
// latency, low enough to be neighbourly to a small Wiki.js instance.
const CONCURRENT_PAGE_FETCH = 8;

export type CloneOptions = {
  baseUrl: string;
  targetDir: string;
  locale?: string;
};

export async function runClone(opts: CloneOptions): Promise<number> {
  let baseUrl: string;
  try {
    baseUrl = canonicalizeBaseUrl(opts.baseUrl);
  } catch (err) {
    process.stderr.write(
      `wjscli: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const locale = opts.locale ?? 'en';
  const absTarget = path.resolve(opts.targetDir);

  // Refuse to clone into an existing non-empty directory — too easy to
  // splat over real files. Empty dir is fine (user pre-created).
  try {
    const entries = await fs.readdir(absTarget);
    if (entries.length > 0) {
      process.stderr.write(
        `wjscli: target dir ${absTarget} is not empty; refusing to clone into it\n`,
      );
      return 2;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `wjscli: cannot read ${absTarget}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    // ENOENT: we'll create it via initRepo.
  }

  let store: TokenStore;
  try {
    store = await TokenStore.loadForBaseUrl(baseUrl);
  } catch (err) {
    if (err instanceof MissingConfigError) {
      process.stderr.write(
        `wjscli: ${err.message}\n  No config found. Run: wjscli ${baseUrl} validate <jwt>\n`,
      );
      return 1;
    }
    process.stderr.write(
      `wjscli: failed to load config: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const client = new WikiClient({ tokenStore: store });

  try {
    process.stderr.write(`Cloning ${baseUrl} into ${absTarget}…\n`);
    const repo = await initRepo(absTarget, {
      baseUrl,
      locale,
      clonedAt: new Date().toISOString(),
    });

    // Step 1: walk the page tree to enumerate every page. We use a single
    // depth=20 call because the existing `wiki_pages_tree` recursion already
    // handles fan-out; sharing the same code path is cheap.
    process.stderr.write('Enumerating pages…\n');
    const tree = await fetchFullTree(client, locale);
    const pages = tree.filter((n) => !n.isFolder && n.pageId !== null);
    process.stderr.write(`Found ${pages.length.toString()} pages.\n`);

    // Step 2: fetch the body for every page (the tree query only carries
    // metadata). Bounded concurrency keeps us neighbourly without serial
    // latency. Per-page errors are logged but don't abort the whole clone —
    // a single rotted page shouldn't lose the other 288.
    const entries: SyncIndexEntry[] = [];
    let done = 0;
    let failed = 0;
    await runWithConcurrency(pages, CONCURRENT_PAGE_FETCH, async (node) => {
      // The tree row's `id` is a pageTree row id, NOT the page id — Wiki.js
      // stores them in separate tables. `pages.single` indexes by page id,
      // which the tree node exposes as `pageId`. We've already filtered
      // out nodes with `pageId === null`, so the assertion below is safe.
      const pageId = node.pageId;
      if (pageId === null) return;
      try {
        const data = await client.gql<PageSingleResponse>(PAGE_SINGLE_QUERY, {
          id: pageId,
        });
        const page = data.pages.single;
        if (page === null) {
          process.stderr.write(
            `  ! skipping ${node.path}: pages.single returned null\n`,
          );
          failed += 1;
          return;
        }
        const fileRel = pathToFile(page.path);
        const fileAbs = path.join(absTarget, fileRel);
        await fs.mkdir(path.dirname(fileAbs), { recursive: true });
        const text = serializePage(page);
        await fs.writeFile(fileAbs, text, 'utf8');
        entries.push({
          id: page.id,
          path: page.path,
          file: fileRel,
          hash: contentHash(text),
          remoteUpdatedAt: page.updatedAt,
          syncedAt: new Date().toISOString(),
        });
        done += 1;
        if (done % 10 === 0 || done === pages.length) {
          process.stderr.write(
            `  ${done.toString()}/${pages.length.toString()} fetched\n`,
          );
        }
      } catch (err) {
        failed += 1;
        process.stderr.write(
          `  ! skipping ${node.path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    });

    await writeIndex(repo, { version: 1, entries });
    process.stderr.write(
      `✓ Cloned ${entries.length.toString()} pages to ${absTarget}` +
        (failed > 0 ? ` (${failed.toString()} skipped — see warnings above)` : '') +
        '\n',
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `wjscli: clone failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    await store.close();
  }
}

// Pull the whole tree in one shot. depth=50 is safer than relying on the
// `wiki_pages_tree` tool's default — sync should cover every page, even
// pathological depths.
async function fetchFullTree(
  client: WikiClient,
  locale: string,
): Promise<
  Array<{
    id: number;
    path: string;
    depth: number;
    isFolder: boolean;
    pageId: number | null;
  }>
> {
  const seen = new Map<
    number,
    { id: number; path: string; depth: number; isFolder: boolean; pageId: number | null }
  >();
  const queue: number[] = [0];
  // Iterative BFS so we don't blow the stack on a deeply nested wiki.
  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    const results = await Promise.all(
      batch.map((parent) =>
        client.gql<PagesTreeResponse>(PAGES_TREE_QUERY, {
          parent,
          mode: 'ALL',
          locale,
        }),
      ),
    );
    for (const r of results) {
      for (const item of r.pages.tree ?? []) {
        if (!seen.has(item.id)) {
          seen.set(item.id, {
            id: item.id,
            path: item.path,
            depth: item.depth,
            isFolder: item.isFolder,
            pageId: item.pageId,
          });
          queue.push(item.id);
        }
      }
    }
  }
  return [...seen.values()];
}

// A tiny p-limit. We don't pull in the dep — this is half a screen of code
// and the surface area we need is exactly one function.
async function runWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        await task(items[idx]);
      }
    },
  );
  await Promise.all(workers);
}

// Look up a Page by id. Re-exported for pull's parallel fetch loop, which
// has the same shape as clone's.
export async function fetchPageById(
  client: WikiClient,
  id: number,
): Promise<Page | null> {
  const data = await client.gql<PageSingleResponse>(PAGE_SINGLE_QUERY, { id });
  return data.pages.single;
}
