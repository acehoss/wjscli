import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TokenStore } from '../util/token-store.js';
import { GraphQLError } from '../util/errors.js';
import { WikiClient } from '../wiki/client.js';
import {
  PAGE_SINGLE_QUERY,
  PAGE_UPDATE_FIELDS,
  buildPageUpdateMutation,
  type PageSingleResponse,
  type PageUpdateResponse,
} from '../wiki/queries.js';
import {
  contentHash,
  deserializePage,
  frontmatterToUpdateInput,
} from './format.js';
import {
  loadRepo,
  readIndex,
  writeIndex,
  type SyncIndex,
  type SyncIndexEntry,
} from './repo.js';

export type RunPushOptions = {
  dir: string;
  force: boolean;
  dryRun: boolean;
};

export async function runPush(opts: RunPushOptions): Promise<number> {
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

  // Figure out which entries to push (those whose on-disk hash differs
  // from the index hash). Untracked / deleted files are intentionally not
  // pushed — sync push is an UPDATE operation; creates and deletes need
  // explicit page create / a future API not exposed by wjscli yet.
  type Pending = {
    entry: SyncIndexEntry;
    fileText: string;
    fileHash: string;
  };
  const pending: Pending[] = [];
  for (const entry of index.entries) {
    const absFile = path.join(repo.root, entry.file);
    let text: string;
    try {
      text = await fs.readFile(absFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(
          `  ! ${entry.path}: file missing on disk — skipping (push cannot delete)\n`,
        );
        continue;
      }
      throw err;
    }
    const h = contentHash(text);
    if (h !== entry.hash) {
      pending.push({ entry, fileText: text, fileHash: h });
    }
  }

  if (pending.length === 0) {
    process.stdout.write('nothing to push (no locally modified pages)\n');
    return 0;
  }

  process.stderr.write(
    `Pushing ${pending.length.toString()} modified page(s)…\n`,
  );

  if (opts.dryRun) {
    for (const p of pending) {
      process.stdout.write(`would push: ${p.entry.path}\n`);
    }
    return 0;
  }

  const store = await TokenStore.loadForBaseUrl(repo.config.baseUrl);
  const client = new WikiClient({ tokenStore: store });
  const updateMutation = buildPageUpdateMutation(PAGE_UPDATE_FIELDS);

  const updatedEntries = new Map<number, SyncIndexEntry>();
  let failures = 0;

  try {
    for (const p of pending) {
      try {
        const { frontmatter, body } = deserializePage(p.fileText);
        if (frontmatter.id !== p.entry.id) {
          process.stderr.write(
            `  ! ${p.entry.path}: frontmatter id (${frontmatter.id.toString()}) does not match index id (${p.entry.id.toString()}); skipping\n`,
          );
          failures += 1;
          continue;
        }
        // Conflict check: fetch current remote page; abort if remote's
        // updatedAt differs from what we recorded at last sync. --force
        // bypasses (caller has confirmed they want to overwrite).
        const current = await client.gql<PageSingleResponse>(PAGE_SINGLE_QUERY, {
          id: frontmatter.id,
        });
        const currentPage = current.pages.single;
        if (currentPage === null) {
          process.stderr.write(
            `  ! ${p.entry.path}: page is gone from the server; skipping\n`,
          );
          failures += 1;
          continue;
        }
        if (
          !opts.force &&
          currentPage.updatedAt !== p.entry.remoteUpdatedAt
        ) {
          process.stderr.write(
            `  ! ${p.entry.path}: remote changed since last sync — run \`sync pull\` first or use --force\n`,
          );
          failures += 1;
          continue;
        }

        // Issue the update. The `wiki_page_update` tool's full payload is
        // assembled directly here (skipping the MCP dispatcher) because we
        // already have the page state in hand and don't want a second
        // fetch-merge-update round-trip.
        const updateInput = frontmatterToUpdateInput(frontmatter, body);
        const variables = {
          id: updateInput.id,
          content: updateInput.content,
          description: updateInput.description,
          editor: updateInput.editor,
          isPrivate: updateInput.isPrivate,
          isPublished: updateInput.isPublished,
          locale: updateInput.locale,
          path: updateInput.path,
          tags: updateInput.tags,
          title: updateInput.title,
        };
        const result = await client.gql<PageUpdateResponse>(
          updateMutation,
          variables,
        );
        const rr = result.pages.update.responseResult;
        if (!rr.succeeded) {
          process.stderr.write(
            `  ! ${p.entry.path}: update rejected: ${rr.message || rr.slug || 'unknown error'} (code ${rr.errorCode.toString()})\n`,
          );
          failures += 1;
          continue;
        }
        // Refresh the index entry with the new remote updatedAt + the new
        // local hash. We don't have updatedAt in the update mutation's
        // return shape; re-query single() to be safe.
        const refreshed = await client.gql<PageSingleResponse>(
          PAGE_SINGLE_QUERY,
          { id: frontmatter.id },
        );
        const newRemote = refreshed.pages.single;
        if (newRemote === null) {
          // Shouldn't happen — we just updated it — but be defensive.
          process.stderr.write(
            `  ! ${p.entry.path}: post-update lookup returned null; index entry kept unchanged\n`,
          );
          continue;
        }
        updatedEntries.set(p.entry.id, {
          ...p.entry,
          path: newRemote.path, // path may have changed (rename)
          hash: p.fileHash,
          remoteUpdatedAt: newRemote.updatedAt,
          syncedAt: new Date().toISOString(),
        });
        process.stdout.write(`pushed: ${p.entry.path}\n`);
      } catch (err) {
        process.stderr.write(
          `  ! ${p.entry.path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        failures += 1;
      }
    }

    // Splice updates into the index. Entries we didn't touch are kept
    // verbatim.
    const newIndex: SyncIndex = {
      version: 1,
      entries: index.entries.map((e) => updatedEntries.get(e.id) ?? e),
    };
    await writeIndex(repo, newIndex);
  } finally {
    await store.close();
  }

  if (failures > 0) {
    process.stderr.write(
      `${failures.toString()} push(es) failed — see messages above\n`,
    );
    return 1;
  }
  return 0;
}

// Re-export GraphQLError so handlers calling resolvePathToId or the like
// can react to the well-known shape if they want to.
export { GraphQLError };
