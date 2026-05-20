import { promises as fs } from 'node:fs';
import path from 'node:path';

// Directory name for sync state inside a clone root. Mirrors `.git/`.
export const SYNC_DIR = '.wjscli';
const CONFIG_FILE = 'config.json';
const INDEX_FILE = 'index.json';

// Stored at .wjscli/config.json. Recorded at clone time; used by status /
// pull / push to know which wiki this clone is bound to.
export type SyncConfig = {
  version: 1;
  baseUrl: string;
  locale: string;
  clonedAt: string;
};

// One entry per tracked page. The index is the equivalent of `git's
// `.git/index` — it records the state the working tree was in the last
// time we synced, so we can detect both local edits and remote drift.
export type SyncIndexEntry = {
  id: number;
  path: string;          // Wiki.js path (e.g. "team/onboarding")
  file: string;          // path relative to clone root (e.g. "team/onboarding.md")
  // SHA-256 of the file's full text (frontmatter + body) as written or
  // last pushed. Local modifications are detected by recomputing this and
  // comparing.
  hash: string;
  // Server's `updatedAt` at the moment we last pulled or pushed. Push
  // refuses to overwrite a page whose current updatedAt differs from this
  // value, unless `--force`.
  remoteUpdatedAt: string;
  syncedAt: string;
};

export type SyncIndex = {
  version: 1;
  entries: SyncIndexEntry[];
};

export type SyncRepo = {
  root: string;             // absolute path to the clone root
  configPath: string;       // absolute path to .wjscli/config.json
  indexPath: string;        // absolute path to .wjscli/index.json
  config: SyncConfig;
};

// Walk up from `start` looking for a `.wjscli/` directory. Returns the
// containing root path, or null if none found. Mirrors how git locates
// the enclosing repo from any subdirectory.
export async function findRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, SYNC_DIR);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return dir;
    } catch {
      // not present here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Load a sync repo from a directory. Errors if `.wjscli/` is missing,
// the config file is malformed, or the schema version is incompatible.
export async function loadRepo(start: string): Promise<SyncRepo> {
  const root = await findRoot(start);
  if (root === null) {
    throw new Error(
      `not a wjscli sync clone: no ${SYNC_DIR}/ found at or above ${path.resolve(start)}`,
    );
  }
  const configPath = path.join(root, SYNC_DIR, CONFIG_FILE);
  const indexPath = path.join(root, SYNC_DIR, INDEX_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const config = validateConfig(parsed);
  return { root, configPath, indexPath, config };
}

// Initialise a brand-new clone at `root` (which must not already contain
// a `.wjscli/`). Writes config + an empty index, returns the SyncRepo.
export async function initRepo(
  root: string,
  config: Omit<SyncConfig, 'version'>,
): Promise<SyncRepo> {
  const absRoot = path.resolve(root);
  const syncDir = path.join(absRoot, SYNC_DIR);
  try {
    const stat = await fs.stat(syncDir);
    if (stat.isDirectory()) {
      throw new Error(
        `${syncDir} already exists — refusing to overwrite an existing sync clone`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
  await fs.mkdir(syncDir, { recursive: true, mode: 0o755 });
  const fullConfig: SyncConfig = { version: 1, ...config };
  const configPath = path.join(syncDir, CONFIG_FILE);
  const indexPath = path.join(syncDir, INDEX_FILE);
  await writeJsonAtomic(configPath, fullConfig);
  await writeJsonAtomic(indexPath, { version: 1, entries: [] } satisfies SyncIndex);
  return { root: absRoot, configPath, indexPath, config: fullConfig };
}

// Read .wjscli/index.json. Returns an empty index if the file is missing
// (defensive — a fresh init writes one, but a manual clone could skip it).
export async function readIndex(repo: SyncRepo): Promise<SyncIndex> {
  let raw: string;
  try {
    raw = await fs.readFile(repo.indexPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, entries: [] };
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return validateIndex(parsed);
}

// Write the index file atomically (tmp + rename). Sorts entries by path
// for stable diffs against version control if anyone tracks `.wjscli/`.
export async function writeIndex(repo: SyncRepo, index: SyncIndex): Promise<void> {
  const sorted: SyncIndex = {
    version: 1,
    entries: [...index.entries].sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeJsonAtomic(repo.indexPath, sorted);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

function validateConfig(raw: unknown): SyncConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config.json did not parse to an object');
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    throw new Error(`config.json version mismatch: got ${String(r.version)}, expected 1`);
  }
  if (typeof r.baseUrl !== 'string' || r.baseUrl.length === 0) {
    throw new Error('config.json: `baseUrl` must be a non-empty string');
  }
  if (typeof r.locale !== 'string' || r.locale.length === 0) {
    throw new Error('config.json: `locale` must be a non-empty string');
  }
  if (typeof r.clonedAt !== 'string') {
    throw new Error('config.json: `clonedAt` must be a string');
  }
  return {
    version: 1,
    baseUrl: r.baseUrl,
    locale: r.locale,
    clonedAt: r.clonedAt,
  };
}

function validateIndex(raw: unknown): SyncIndex {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('index.json did not parse to an object');
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    throw new Error(`index.json version mismatch: got ${String(r.version)}, expected 1`);
  }
  if (!Array.isArray(r.entries)) {
    throw new Error('index.json: `entries` must be an array');
  }
  const entries: SyncIndexEntry[] = r.entries.map((e: unknown, i: number) => {
    if (typeof e !== 'object' || e === null) {
      throw new Error(`index.json entries[${i.toString()}] not an object`);
    }
    const x = e as Record<string, unknown>;
    if (
      typeof x.id !== 'number' ||
      typeof x.path !== 'string' ||
      typeof x.file !== 'string' ||
      typeof x.hash !== 'string' ||
      typeof x.remoteUpdatedAt !== 'string' ||
      typeof x.syncedAt !== 'string'
    ) {
      throw new Error(
        `index.json entries[${i.toString()}] missing or wrong-typed field`,
      );
    }
    return {
      id: x.id,
      path: x.path,
      file: x.file,
      hash: x.hash,
      remoteUpdatedAt: x.remoteUpdatedAt,
      syncedAt: x.syncedAt,
    };
  });
  return { version: 1, entries };
}
