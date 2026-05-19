import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ConfigParseError } from './util/errors.js';

export type ConfigFile = {
  baseUrl: string;
  jwt: string;
  refreshedAt: string;
  note?: string;
};

export function canonicalizeBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TypeError(`invalid base URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(
      `base URL must be http:// or https:// (got ${parsed.protocol}//): ${input}`,
    );
  }
  parsed.hash = '';
  parsed.search = '';
  let out = parsed.toString();
  if (out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}

export function hostFromBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return parsed.host.toLowerCase();
}

export function configDir(): string {
  const override = process.env.WIKIJS_MCP_CONFIG_DIR;
  if (override && override.length > 0) {
    return override;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), '.config');
  return path.join(base, 'wikijs-mcp');
}

export function configPathForBaseUrl(baseUrl: string): string {
  const canonical = canonicalizeBaseUrl(baseUrl);
  return path.join(configDir(), `${hostFromBaseUrl(canonical)}.json`);
}

function isConfigFile(value: unknown): value is ConfigFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.baseUrl !== 'string' || v.baseUrl.length === 0) return false;
  if (typeof v.jwt !== 'string' || v.jwt.length === 0) return false;
  if (typeof v.refreshedAt !== 'string' || v.refreshedAt.length === 0) return false;
  if ('note' in v && v.note !== undefined && typeof v.note !== 'string') return false;
  return true;
}

export async function readConfig(baseUrl: string): Promise<ConfigFile | null> {
  const filePath = configPathForBaseUrl(baseUrl);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ConfigParseError(
      filePath,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!isConfigFile(parsed)) {
    throw new ConfigParseError(
      filePath,
      'shape mismatch: expected { baseUrl, jwt, refreshedAt, note? }',
    );
  }
  return parsed;
}

export async function writeConfig(cfg: ConfigFile): Promise<void> {
  const filePath = configPathForBaseUrl(cfg.baseUrl);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // best-effort on non-POSIX
  }

  // Random suffix so two concurrent writers from the same pid in the same
  // millisecond don't collide on the tmp filename.
  const tmpPath = `${filePath}.tmp-${process.pid.toString()}-${randomBytes(6).toString('hex')}`;
  const body = `${JSON.stringify(cfg, null, 2)}\n`;

  // Wrap the whole tmp-file lifecycle so ANY error (open/write/sync/chmod/
  // rename) unlinks the tmp file before re-throwing. Previously a writeFile
  // or sync EIO would leak a `.tmp-<pid>-<rand>` file in the config dir.
  try {
    const handle = await fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.chmod(tmpPath, 0o600);
    } catch {
      // best-effort on non-POSIX; the open() mode is the real safeguard
    }
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Ignore ENOENT — the tmp file may not exist yet (e.g. open() itself
    // failed) or may already have been renamed away (defensive).
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}
