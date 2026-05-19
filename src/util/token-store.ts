import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  configPathForBaseUrl,
  readConfig,
  writeConfig,
  type ConfigFile,
} from '../config.js';
import { MissingConfigError } from './errors.js';

const DEFAULT_DEBOUNCE_MS = 250;

export type TokenStoreOptions = {
  debounceMs?: number;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function maskJwt(jwt: string): string {
  if (jwt.length <= 6) return '***';
  return `***${jwt.slice(-6)}`;
}

export class TokenStore {
  private readonly baseUrl: string;
  private readonly filePath: string;
  private readonly fileBasename: string;
  private readonly debounceMs: number;
  // false → in-memory only: update() does not schedule disk writes, the
  // watcher is not started, and flush()/close() are no-ops. Used by the
  // bootstrap subcommand to run a probe through WikiClient without ever
  // touching the on-disk config.
  private readonly persistent: boolean;

  private currentJwt: string;
  private refreshedAt: string;
  private note: string | undefined;

  private lastWrittenHash: string;
  // Hash of the content on disk at the moment a write started; used to suppress
  // watcher reloads that observe the pre-rename state. Set in performWrite,
  // cleared when the write resolves.
  private inFlightOldHash: string | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private pendingFlush: Promise<void> | null = null;
  private resolvePending: (() => void) | null = null;
  private rejectPending: ((err: unknown) => void) | null = null;
  private inFlightWrite: Promise<void> | null = null;
  private closed = false;

  private watcher: FSWatcher | null = null;

  private constructor(
    cfg: ConfigFile,
    filePath: string,
    debounceMs: number,
    persistent: boolean,
  ) {
    this.baseUrl = cfg.baseUrl;
    this.filePath = filePath;
    this.fileBasename = path.basename(filePath);
    this.debounceMs = debounceMs;
    this.persistent = persistent;
    this.currentJwt = cfg.jwt;
    this.refreshedAt = cfg.refreshedAt;
    this.note = cfg.note;
    this.lastWrittenHash = hash(cfg.jwt);
  }

  static async loadForBaseUrl(
    baseUrl: string,
    opts: TokenStoreOptions = {},
  ): Promise<TokenStore> {
    const cfg = await readConfig(baseUrl);
    const filePath = configPathForBaseUrl(baseUrl);
    if (cfg === null) {
      throw new MissingConfigError(filePath, baseUrl);
    }
    const store = new TokenStore(
      cfg,
      filePath,
      opts.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      true,
    );
    store.startWatcher();
    return store;
  }

  // Build a TokenStore that lives entirely in memory. Used by bootstrap to
  // run a one-shot probe through WikiClient: the client's new-jwt capture
  // updates this store's in-memory token, which bootstrap then reads back
  // via getToken() and writes to disk via writeConfig().
  static inMemory(baseUrl: string, jwt: string): TokenStore {
    const now = new Date().toISOString();
    const cfg: ConfigFile = { baseUrl, jwt, refreshedAt: now };
    // filePath is unused in non-persistent mode, but we set it to the would-be
    // path for clarity in any diagnostics.
    return new TokenStore(cfg, configPathForBaseUrl(baseUrl), 0, false);
  }

  getRefreshedAt(): string {
    return this.refreshedAt;
  }

  getToken(): string {
    return this.currentJwt;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getFilePath(): string {
    return this.filePath;
  }

  update(freshJwt: string): void {
    if (this.closed) return;
    if (freshJwt.length === 0) return;
    if (freshJwt === this.currentJwt) return;
    this.currentJwt = freshJwt;
    this.refreshedAt = new Date().toISOString();
    if (this.persistent) {
      this.scheduleWrite();
    }
  }

  private scheduleWrite(): void {
    if (this.pendingFlush === null) {
      this.pendingFlush = new Promise<void>((resolve, reject) => {
        this.resolvePending = resolve;
        this.rejectPending = reject;
      });
      // Swallow rejections at the unhandled-rejection level — the timer path
      // has no awaiter unless someone calls flush(). Errors are also surfaced
      // on stderr below for visibility.
      this.pendingFlush.catch(() => undefined);
    }
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = setTimeout(() => {
      void this.runScheduledWrite();
    }, this.debounceMs);
  }

  private async runScheduledWrite(): Promise<void> {
    try {
      await this.performWrite();
    } catch (err) {
      // Last-resort log so a silent disk-write failure isn't completely
      // invisible. Never include JWT content — log error class + message only.
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      process.stderr.write(`wikijs-mcp: deferred config write failed: ${msg}\n`);
    }
  }

  private performWrite(): Promise<void> {
    this.pendingTimer = null;
    const resolve = this.resolvePending;
    const reject = this.rejectPending;
    this.pendingFlush = null;
    this.resolvePending = null;
    this.rejectPending = null;

    const cfg: ConfigFile = {
      baseUrl: this.baseUrl,
      jwt: this.currentJwt,
      refreshedAt: this.refreshedAt,
      ...(this.note !== undefined ? { note: this.note } : {}),
    };

    const oldHash = this.lastWrittenHash;
    const newHash = hash(cfg.jwt);
    this.inFlightOldHash = oldHash;
    this.lastWrittenHash = newHash;

    const op = this.runWrite(cfg, resolve, reject, oldHash);
    this.inFlightWrite = op;
    // After the op settles, clear inFlightWrite only if it still points at this
    // op (a later performWrite may have replaced it).
    op.finally(() => {
      this.inFlightOldHash = null;
      if (this.inFlightWrite === op) {
        this.inFlightWrite = null;
      }
    }).catch(() => undefined);
    return op;
  }

  private async runWrite(
    cfg: ConfigFile,
    resolve: (() => void) | null,
    reject: ((err: unknown) => void) | null,
    oldHash: string,
  ): Promise<void> {
    try {
      await writeConfig(cfg);
      resolve?.();
    } catch (err) {
      // Rollback: rename never landed, so the hash on disk is still oldHash.
      // Restore lastWrittenHash so a subsequent reload can detect external content.
      this.lastWrittenHash = oldHash;
      reject?.(err);
      throw err;
    }
  }

  async flush(): Promise<void> {
    // Drain any pending debounced write first. We go through runScheduledWrite
    // (not performWrite directly) so failures get the same stderr breadcrumb
    // as timer-triggered writes — shutdown is when we most need visibility.
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      await this.runScheduledWrite();
    }
    // Then wait for any in-flight write started by the timer path.
    const inFlight = this.inFlightWrite;
    if (inFlight !== null) {
      await inFlight;
    }
  }

  private startWatcher(): void {
    const dir = path.dirname(this.filePath);
    try {
      this.watcher = watch(dir, { persistent: false }, (kind, filename) => {
        if (kind !== 'change' && kind !== 'rename') return;
        // Some platforms report null for filename; treat that as "might be ours".
        if (filename !== null && filename !== this.fileBasename) return;
        void this.reloadFromDisk();
      });
      this.watcher.on('error', () => {
        // Tolerate spurious watcher errors; content-hash dedup is the real safety net.
      });
    } catch {
      this.watcher = null;
    }
  }

  private async reloadFromDisk(): Promise<void> {
    if (this.closed) return;
    let cfg: ConfigFile | null;
    try {
      cfg = await readConfig(this.baseUrl);
    } catch {
      return;
    }
    if (cfg === null) return;
    const diskHash = hash(cfg.jwt);
    // Suppress reloads that match either what we just wrote (lastWrittenHash)
    // or the pre-rename content during an in-flight write (inFlightOldHash).
    if (diskHash === this.lastWrittenHash) return;
    if (this.inFlightOldHash !== null && diskHash === this.inFlightOldHash) return;
    if (cfg.jwt === this.currentJwt) return;
    this.currentJwt = cfg.jwt;
    this.refreshedAt = cfg.refreshedAt;
    this.note = cfg.note;
    this.lastWrittenHash = diskHash;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush();
    } finally {
      if (this.watcher !== null) {
        try {
          this.watcher.close();
        } catch {
          // ignore
        }
        this.watcher = null;
      }
      if (this.pendingTimer !== null) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
    }
  }

  // For debug/logging only. Does NOT return the actual JWT.
  debugMaskedToken(): string {
    return maskJwt(this.currentJwt);
  }
}
