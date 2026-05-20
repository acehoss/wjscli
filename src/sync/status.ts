import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TokenStore } from '../util/token-store.js';
import { WikiClient } from '../wiki/client.js';
import {
  PAGE_SINGLE_QUERY,
  type PageSingleResponse,
} from '../wiki/queries.js';
import { SYNC_DIR } from './repo.js';
import { contentHash } from './format.js';
import { loadRepo, readIndex } from './repo.js';

export type RunStatusOptions = {
  dir: string;
  withRemote: boolean;
};

// Classified entries the status reporter can describe to the user.
export type StatusReport = {
  baseUrl: string;
  modified: string[];        // tracked + content changed locally
  deleted: string[];         // tracked + file missing on disk
  untracked: string[];       // file present + not in index
  remoteChanged: string[];   // tracked + remote updatedAt drifted (only with --remote)
};

export async function computeStatus(opts: RunStatusOptions): Promise<StatusReport> {
  const repo = await loadRepo(opts.dir);
  const index = await readIndex(repo);

  const modified: string[] = [];
  const deleted: string[] = [];
  const remoteChanged: string[] = [];

  // Build the set of tracked files for the untracked scan.
  const trackedFiles = new Set<string>(index.entries.map((e) => e.file));

  // Walk index entries: detect modified/deleted.
  for (const entry of index.entries) {
    const absFile = path.join(repo.root, entry.file);
    let text: string;
    try {
      text = await fs.readFile(absFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        deleted.push(entry.path);
        continue;
      }
      throw err;
    }
    if (contentHash(text) !== entry.hash) {
      modified.push(entry.path);
    }
  }

  // Untracked: any .md file in the working tree not in the index.
  const allFiles = await listMarkdownFiles(repo.root);
  const untracked = allFiles
    .filter((rel) => !trackedFiles.has(rel))
    .sort();

  if (opts.withRemote) {
    // For every tracked page, fetch its current updatedAt and compare.
    // One query per page — expensive on big wikis but the user asked for it.
    const store = await TokenStore.loadForBaseUrl(repo.config.baseUrl);
    const client = new WikiClient({ tokenStore: store });
    try {
      await Promise.all(
        index.entries.map(async (entry) => {
          try {
            const data = await client.gql<PageSingleResponse>(PAGE_SINGLE_QUERY, {
              id: entry.id,
            });
            const remote = data.pages.single;
            if (remote === null) {
              // Page was deleted server-side — surface as remote-changed too.
              remoteChanged.push(entry.path);
              return;
            }
            if (remote.updatedAt !== entry.remoteUpdatedAt) {
              remoteChanged.push(entry.path);
            }
          } catch (err) {
            process.stderr.write(
              `  ! could not check remote for ${entry.path}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }),
      );
    } finally {
      await store.close();
    }
  }

  return {
    baseUrl: repo.config.baseUrl,
    modified: modified.sort(),
    deleted: deleted.sort(),
    untracked,
    remoteChanged: remoteChanged.sort(),
  };
}

// Render a StatusReport in a porcelain-friendly but human-readable form.
// Mirrors `git status` shape: section per change type, "nothing to commit"
// when clean.
export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`Sync clone of ${report.baseUrl}`);
  lines.push('');
  const anyChange =
    report.modified.length +
      report.deleted.length +
      report.untracked.length +
      report.remoteChanged.length >
    0;
  if (!anyChange) {
    lines.push('working tree clean (no local changes detected)');
    return lines.join('\n');
  }
  if (report.modified.length > 0) {
    lines.push('Modified locally (will push on `sync push`):');
    for (const p of report.modified) lines.push(`  modified:  ${p}`);
    lines.push('');
  }
  if (report.deleted.length > 0) {
    lines.push('Deleted locally (push cannot delete; remove from index manually):');
    for (const p of report.deleted) lines.push(`  deleted:   ${p}`);
    lines.push('');
  }
  if (report.untracked.length > 0) {
    lines.push('Untracked files (not pushed; use page create for new pages):');
    for (const p of report.untracked) lines.push(`  untracked: ${p}`);
    lines.push('');
  }
  if (report.remoteChanged.length > 0) {
    lines.push('Remote changed since last sync (re-pull to update):');
    for (const p of report.remoteChanged) lines.push(`  remote:    ${p}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// Walk the clone for .md files relative to the root, skipping `.wjscli/`.
async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, '', out);
  return out;
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const here = rel === '' ? root : path.join(root, rel);
  const entries = await fs.readdir(here, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === SYNC_DIR && rel === '') continue;
    const relChild = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      await walk(root, relChild, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(relChild);
    }
  }
}

export async function runStatus(opts: RunStatusOptions): Promise<number> {
  try {
    const report = await computeStatus(opts);
    process.stdout.write(`${formatStatus(report)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `wjscli: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
