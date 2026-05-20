import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TokenStore } from '../util/token-store.js';
import { WikiClient } from '../wiki/client.js';
import {
  PAGE_SINGLE_QUERY,
  PAGES_TREE_QUERY,
  type Page,
  type PageSingleResponse,
  type PagesTreeResponse,
} from '../wiki/queries.js';
import {
  contentHash,
  pathToFile,
  serializePage,
} from './format.js';
import {
  loadRepo,
  readIndex,
  writeIndex,
  type SyncIndex,
  type SyncIndexEntry,
} from './repo.js';

const CONCURRENT_PAGE_FETCH = 8;

export type RunPullOptions = {
  dir: string;
  force: boolean; // overwrite locally-modified files
};

export async function runPull(opts: RunPullOptions): Promise<number> {
  let repo;
  try {
    repo = await loadRepo(opts.dir);
  } catch (err) {
    process.stderr.write(
      `wjscli: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  const index = await readIndex(repo);
  // Lookup by id is much more useful than by path because Wiki.js renames
  // change `path` but not `id` — we can detect renames cleanly.
  const indexById = new Map<number, SyncIndexEntry>(
    index.entries.map((e) => [e.id, e]),
  );

  const store = await TokenStore.loadForBaseUrl(repo.config.baseUrl);
  const client = new WikiClient({ tokenStore: store });

  let updated = 0;
  let added = 0;
  let skipped = 0;
  let renamed = 0;

  try {
    process.stderr.write('Walking remote tree…\n');
    const treeNodes = await fetchFullTree(client, repo.config.locale);
    const remotePages = treeNodes.filter(
      (n) => !n.isFolder && n.pageId !== null,
    );
    process.stderr.write(
      `Found ${remotePages.length.toString()} pages on the server.\n`,
    );

    const newEntries: SyncIndexEntry[] = [];

    await runWithConcurrency(remotePages, CONCURRENT_PAGE_FETCH, async (node) => {
      // See clone.ts: `pages.single` keys by `pageId`, not by the
      // pageTree row's own `id`. Pre-filter already drops null pageIds.
      const pageId = node.pageId;
      if (pageId === null) return;
      let page;
      try {
        const data = await client.gql<PageSingleResponse>(PAGE_SINGLE_QUERY, {
          id: pageId,
        });
        page = data.pages.single;
      } catch (err) {
        process.stderr.write(
          `  ! ${node.path}: ${err instanceof Error ? err.message : String(err)}; skipping\n`,
        );
        return;
      }
      if (page === null) {
        process.stderr.write(
          `  ! ${node.path}: pages.single returned null on pull; skipping\n`,
        );
        return;
      }
      const existing = indexById.get(page.id);
      const newFileRel = pathToFile(page.path);
      const newFileAbs = path.join(repo.root, newFileRel);

      if (existing === undefined) {
        // New page on the server — write it.
        const text = serializePage(page);
        await fs.mkdir(path.dirname(newFileAbs), { recursive: true });
        await fs.writeFile(newFileAbs, text, 'utf8');
        newEntries.push({
          id: page.id,
          path: page.path,
          file: newFileRel,
          hash: contentHash(text),
          remoteUpdatedAt: page.updatedAt,
          syncedAt: new Date().toISOString(),
        });
        added += 1;
        process.stdout.write(`added:   ${page.path}\n`);
        return;
      }

      const oldFileAbs = path.join(repo.root, existing.file);
      const oldFileExists = await fileExists(oldFileAbs);

      // If the local file has been modified since pull, refuse to clobber
      // unless --force.
      if (oldFileExists) {
        const currentText = await fs.readFile(oldFileAbs, 'utf8');
        if (contentHash(currentText) !== existing.hash && !opts.force) {
          process.stderr.write(
            `  ! ${existing.path}: skipping — locally modified (use --force to overwrite)\n`,
          );
          skipped += 1;
          // Keep the existing index entry intact.
          newEntries.push(existing);
          return;
        }
      }

      // Handle rename: server's current path differs from where we stored
      // it locally. Move the file (clean up the old one).
      const isRename = existing.file !== newFileRel;
      if (isRename && oldFileExists) {
        try {
          await fs.unlink(oldFileAbs);
        } catch {
          // best-effort
        }
      }

      const text = serializePage(page);
      await fs.mkdir(path.dirname(newFileAbs), { recursive: true });
      await fs.writeFile(newFileAbs, text, 'utf8');
      newEntries.push({
        id: page.id,
        path: page.path,
        file: newFileRel,
        hash: contentHash(text),
        remoteUpdatedAt: page.updatedAt,
        syncedAt: new Date().toISOString(),
      });
      if (isRename) {
        renamed += 1;
        process.stdout.write(
          `renamed: ${existing.path} → ${page.path}\n`,
        );
      } else if (existing.remoteUpdatedAt !== page.updatedAt) {
        updated += 1;
        process.stdout.write(`updated: ${page.path}\n`);
      }
    });

    // Surface deleted-on-server entries so the user knows. We KEEP them in
    // the index for now — sync push wouldn't do anything with them anyway,
    // and surprise-deleting local files would be more dangerous than helpful.
    const remoteIds = new Set<number>(remotePages.map((p) => p.id));
    for (const entry of index.entries) {
      if (!remoteIds.has(entry.id)) {
        process.stdout.write(
          `gone on server: ${entry.path} (local file kept; index entry kept)\n`,
        );
        newEntries.push(entry);
      }
    }

    const newIndex: SyncIndex = { version: 1, entries: newEntries };
    await writeIndex(repo, newIndex);
    process.stderr.write(
      `✓ pull complete: ${added.toString()} added, ${updated.toString()} updated, ${renamed.toString()} renamed, ${skipped.toString()} skipped\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `wjscli: pull failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  } finally {
    await store.close();
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Shared with clone.ts but kept inline here because the two modules
// shouldn't grow a circular dependency. If a third caller appears,
// promote to src/sync/util.ts.
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

// Re-exported so pull's caller can pattern-match if it wants.
export type { Page };
