import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LocalLibraryService, ResolvedLibraryOutput } from './localLibrary.ts';
import { composerLibraryBundles } from '../metrics.ts';

const BUNDLE_LIFETIME_MS = 5 * 60 * 1_000;

export interface PreparedLibraryBundle {
  token: string;
  referenceId: string;
  expiresAt: number;
  downloadUrl: string;
}

interface LibraryBundleEntry {
  id: string;
  filename: string;
  archiveName: string;
  path: string;
}

interface LibraryBundleRecord {
  token: string;
  referenceId: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
  state: 'prepared' | 'streaming' | 'releasing';
  outcomeRecorded: boolean;
  entries: LibraryBundleEntry[];
}

interface ClaimedLibraryBundle extends LibraryBundleRecord {
  filename: string;
}

export type LibraryBundleClaim =
  | { status: 'ready'; bundle: ClaimedLibraryBundle }
  | { status: 'consumed' }
  | { status: 'expired' }
  | { status: 'missing' };

type BundleTombstone = {
  owner: string;
  status: 'consumed' | 'expired';
  expiresAt: number;
};

type BundleLibrary = Pick<LocalLibraryService, 'resolveUsablePath' | 'hold' | 'release'>;

interface LibraryDownloadBundleOptions {
  now?: () => number;
}

export class LibraryBundleValidationError extends Error {}
export class LibraryBundleUnavailableError extends Error {
  constructor(_id: string) {
    super('One or more selected library outputs are unavailable');
  }
}

const sanitizedBasename = (filename: string): string => {
  const basename = path.basename(filename)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[ .]+$/g, '');
  return basename || 'output';
};

const allocateArchiveNames = (resolved: ResolvedLibraryOutput[]): LibraryBundleEntry[] => {
  const allocated = new Set<string>();
  return resolved.map(({ entry, path: resolvedPath }) => {
    const sanitized = sanitizedBasename(entry.filename);
    const extension = path.extname(sanitized);
    const stem = path.basename(sanitized, extension);
    let archiveName = sanitized;
    let suffix = 2;
    while (allocated.has(archiveName.toLocaleLowerCase('en-US'))) {
      archiveName = `${stem}__${suffix}${extension}`;
      suffix += 1;
    }
    allocated.add(archiveName.toLocaleLowerCase('en-US'));
    return { id: entry.id, filename: entry.filename, archiveName, path: resolvedPath };
  });
};

export class LibraryDownloadBundleService {
  private readonly library: BundleLibrary;
  private readonly now: () => number;
  private readonly records = new Map<string, LibraryBundleRecord>();
  private readonly tombstones = new Map<string, BundleTombstone>();
  private readonly rollbackHolds = new Map<string, string[]>();
  private readonly completions = new Map<string, Promise<void>>();

  constructor(library: BundleLibrary, options: LibraryDownloadBundleOptions = {}) {
    this.library = library;
    this.now = options.now ?? Date.now;
  }

  async prepare(ids: string[], owner: string): Promise<PreparedLibraryBundle> {
    if (
      !Array.isArray(ids)
      || ids.length < 1
      || ids.length > 100
      || ids.some((id) => typeof id !== 'string')
      || new Set(ids).size !== ids.length
    ) {
      throw new LibraryBundleValidationError('Select 1-100 unique library outputs');
    }
    const token = randomUUID();
    const referenceId = `bundle-${token}`;
    const held: string[] = [];
    try {
      const resolved: ResolvedLibraryOutput[] = [];
      for (const id of ids) {
        const item = await this.library.resolveUsablePath(id);
        if (!item) throw new LibraryBundleUnavailableError(id);
        await this.library.hold(id, referenceId);
        held.push(id);
        resolved.push(item);
      }
      const createdAt = this.now();
      const record: LibraryBundleRecord = {
        token,
        referenceId,
        owner,
        createdAt,
        expiresAt: createdAt + BUNDLE_LIFETIME_MS,
        state: 'prepared',
        outcomeRecorded: false,
        entries: allocateArchiveNames(resolved),
      };
      this.records.set(token, record);
      composerLibraryBundles.inc({ status: 'prepared' });
      return {
        token,
        referenceId,
        expiresAt: record.expiresAt,
        downloadUrl: `/api/library/download-bundles/${token}`,
      };
    } catch (error) {
      const rollback = await Promise.allSettled(held.map((id) => this.library.release(id, referenceId)));
      const unreleased = held.filter((_id, index) => rollback[index].status === 'rejected');
      if (unreleased.length > 0) this.rollbackHolds.set(referenceId, unreleased);
      composerLibraryBundles.inc({ status: 'error' });
      throw error;
    }
  }

  claim(token: string, owner: string): LibraryBundleClaim {
    const record = this.records.get(token);
    if (!record) {
      const tombstone = this.tombstones.get(token);
      if (!tombstone || tombstone.owner !== owner) return { status: 'missing' };
      return { status: tombstone.status };
    }
    if (record.owner !== owner) return { status: 'missing' };
    if (record.state !== 'prepared') return { status: 'consumed' };
    if (this.now() > record.expiresAt) {
      void this.expire(record, this.now()).catch(() => {});
      return { status: 'expired' };
    }
    record.state = 'streaming';
    return {
      status: 'ready',
      bundle: { ...record, entries: record.entries.map((entry) => ({ ...entry })), filename: 'library-outputs.zip' },
    };
  }

  async complete(token: string, outcome: 'completed' | 'aborted' | 'error' = 'completed'): Promise<void> {
    const inFlight = this.completions.get(token);
    if (inFlight) return inFlight;
    const record = this.records.get(token);
    if (!record) return;
    record.state = 'releasing';
    const completion = this.finishCompletion(record, outcome);
    this.completions.set(token, completion);
    try {
      await completion;
    } finally {
      if (this.completions.get(token) === completion) this.completions.delete(token);
    }
  }

  async abort(token: string): Promise<void> {
    await this.complete(token, 'aborted');
  }

  async fail(token: string): Promise<void> {
    await this.complete(token, 'error');
  }

  async cleanupExpired(now = this.now()): Promise<void> {
    for (const [referenceId, ids] of this.rollbackHolds) {
      await Promise.all(ids.map((id) => this.library.release(id, referenceId)));
      this.rollbackHolds.delete(referenceId);
    }
    for (const record of [...this.records.values()]) {
      if (record.state === 'releasing') await this.complete(record.token);
    }
    const expired = [...this.records.values()]
      .filter((record) => record.state === 'prepared' && now > record.expiresAt);
    for (const record of expired) {
      await this.expire(record, now);
    }
    for (const [token, tombstone] of this.tombstones) {
      if (now > tombstone.expiresAt) this.tombstones.delete(token);
    }
  }

  private async release(record: LibraryBundleRecord): Promise<void> {
    await Promise.all(record.entries.map((entry) => this.library.release(entry.id, record.referenceId)));
  }

  private async expire(record: LibraryBundleRecord, now: number): Promise<void> {
    try {
      await this.release(record);
    } catch (error) {
      this.recordOutcome(record, 'error');
      throw error;
    }
    if (this.records.get(record.token) !== record) return;
    this.recordOutcome(record, 'expired');
    this.records.delete(record.token);
    this.tombstones.set(record.token, {
      owner: record.owner,
      status: 'expired',
      expiresAt: now + BUNDLE_LIFETIME_MS,
    });
  }

  private async finishCompletion(
    record: LibraryBundleRecord,
    outcome: 'completed' | 'aborted' | 'error',
  ): Promise<void> {
    try {
      await this.release(record);
    } catch (error) {
      this.recordOutcome(record, 'error');
      throw error;
    }
    if (this.records.get(record.token) !== record) return;
    this.recordOutcome(record, outcome);
    this.records.delete(record.token);
    this.tombstones.set(record.token, {
      owner: record.owner,
      status: 'consumed',
      expiresAt: record.expiresAt,
    });
  }

  private recordOutcome(
    record: LibraryBundleRecord,
    status: 'completed' | 'expired' | 'aborted' | 'error',
  ): void {
    if (record.outcomeRecorded) return;
    record.outcomeRecorded = true;
    composerLibraryBundles.inc({ status });
  }
}
