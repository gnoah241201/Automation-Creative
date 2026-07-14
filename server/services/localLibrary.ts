import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalLibraryEntry } from '../../shared/composer-contract.ts';
import { ComposerJobRecord } from '../types/renderJob.ts';
import { composerLibraryBytes } from '../metrics.ts';

const RETENTION_MS = 86_400_000;
const IDENTIFIER = /^[a-zA-Z0-9-]+$/;
const STATE_FILENAME = 'entries.json';
const OWNERSHIP_MARKER = '.local-library-owner';

interface StoredLibraryEntry extends LocalLibraryEntry {
  relativePath: string;
  relativeWorkDir: string;
  ownershipToken: string;
}

export interface RegisterLibraryOutput {
  batchId: string;
  jobId: string;
  originalId: string;
  hookId: string;
  filename: string;
  duration: number;
  outputPath: string;
  workDir: string;
  completedAt?: number;
}

export interface ResolvedLibraryOutput {
  entry: LocalLibraryEntry;
  path: string;
}

export interface DeleteManyLibraryResult {
  deleted: string[];
  inUse: string[];
  missing: string[];
}

interface LocalLibraryOptions {
  managedRoot: string;
  libraryRoot: string;
  now?: () => number;
  persistState?: (statePath: string, entries: unknown[]) => Promise<void>;
}

interface StatFsLike {
  bavail: number | bigint;
  bsize: number | bigint;
}

type StatFs = (targetPath: string) => Promise<StatFsLike>;

export class LocalLibraryValidationError extends Error {}
export class LocalLibraryNotFoundError extends Error {}
export class LocalLibraryInUseError extends Error {}
export class LocalLibraryStorageError extends Error {}

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

const publicEntry = ({
  relativePath: _relativePath,
  relativeWorkDir: _relativeWorkDir,
  ownershipToken: _ownershipToken,
  ...entry
}: StoredLibraryEntry): LocalLibraryEntry => structuredClone(entry);

const validateIdentifier = (value: string, label = 'library identifier'): void => {
  if (!IDENTIFIER.test(value)) throw new LocalLibraryValidationError(`Invalid ${label}`);
};

const validateFinitePositive = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new LocalLibraryValidationError(`${label} must be a finite positive number`);
  }
};

export const isLibraryEntryExpired = (
  entry: LocalLibraryEntry,
  now = Date.now(),
): boolean => now > entry.expiresAt;

export class DiskCapacityGuard {
  private readonly statfs: StatFs;

  constructor(statfs: StatFs = async (targetPath) => fs.statfs(targetPath, { bigint: true })) {
    this.statfs = statfs;
  }

  async requireCapacity(targetPath: string, estimatedBytes: number): Promise<void> {
    if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) {
      throw new Error('Estimated render bytes must be a non-negative safe integer');
    }
    const stats = await this.statfs(targetPath);
    const available = BigInt(stats.bavail) * BigInt(stats.bsize);
    const required = (BigInt(estimatedBytes) * 6n + 4n) / 5n;
    if (available < required) {
      throw new Error(
        `Render requires ${required.toString()} bytes but only ${available.toString()} bytes are available`,
      );
    }
  }
}

export class LocalLibraryService {
  private readonly managedRoot: string;
  private readonly libraryRoot: string;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly persistState: (statePath: string, entries: unknown[]) => Promise<void>;
  private entries: Map<string, StoredLibraryEntry> | null = null;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: LocalLibraryOptions) {
    this.managedRoot = path.resolve(options.managedRoot);
    this.libraryRoot = path.resolve(options.libraryRoot);
    if (!isInside(this.managedRoot, this.libraryRoot)) {
      throw new Error('Library state must be inside managed storage');
    }
    this.statePath = path.join(this.libraryRoot, STATE_FILENAME);
    this.now = options.now ?? Date.now;
    this.persistState = options.persistState ?? LocalLibraryService.persistAtomically;
  }

  async registerOutput(input: RegisterLibraryOutput): Promise<LocalLibraryEntry> {
    return this.mutate(async () => {
      this.validateRegistration(input);
      const [outputPath, workDir] = await Promise.all([
        this.requireManagedFile(input.outputPath),
        this.requireManagedDirectory(input.workDir),
      ]);
      if (!isInside(workDir, outputPath)) {
        throw new LocalLibraryValidationError('Library output must belong to its dedicated work directory');
      }
      const outputDirectory = await this.requireManagedDirectory(path.join(input.workDir, 'output'));
      await this.requireManagedDirectory(path.join(input.workDir, 'input'));
      if (!isInside(outputDirectory, outputPath)) {
        throw new LocalLibraryValidationError('Library output must be inside the dedicated output directory');
      }
      const children = await fs.readdir(workDir, { withFileTypes: true });
      if (children.some((child) => (
        child.name !== OWNERSHIP_MARKER
        && (!child.isDirectory() || (child.name !== 'input' && child.name !== 'output'))
      ))) {
        throw new LocalLibraryValidationError('Library output requires a dedicated work directory');
      }
      const stat = await fs.stat(outputPath);
      if (!stat.isFile()) throw new LocalLibraryValidationError('Library output must be a managed file');

      const existing = [...this.entries!.values()].find((entry) => entry.jobId === input.jobId);
      if (existing) return publicEntry(existing);
      if ([...this.entries!.values()].some((entry) => entry.relativeWorkDir === path.relative(
        this.managedRoot,
        path.resolve(input.workDir),
      ))) {
        throw new LocalLibraryValidationError('Each composer output requires a dedicated work directory');
      }

      const completedAt = input.completedAt ?? this.now();
      if (!Number.isFinite(completedAt) || completedAt < 0) {
        throw new LocalLibraryValidationError('Completion time must be a finite timestamp');
      }
      const managedReal = await fs.realpath(this.managedRoot);
      const ownershipToken = randomUUID();
      try {
        await fs.writeFile(path.join(workDir, OWNERSHIP_MARKER), ownershipToken, 'utf8');
      } catch {
        throw new LocalLibraryStorageError('Composer work directory ownership could not be recorded');
      }
      const entry: StoredLibraryEntry = {
        id: randomUUID(),
        batchId: input.batchId,
        jobId: input.jobId,
        originalId: input.originalId,
        hookId: input.hookId,
        filename: input.filename,
        duration: input.duration,
        width: 1080,
        height: 1920,
        byteSize: stat.size,
        completedAt,
        expiresAt: completedAt + RETENTION_MS,
        holds: [],
        // Persist the managed lexical location, not Windows' potentially short-name
        // realpath spelling. Every later access resolves and revalidates symlinks.
        relativePath: path.relative(managedReal, outputPath),
        relativeWorkDir: path.relative(managedReal, workDir),
        ownershipToken,
      };
      this.entries!.set(entry.id, entry);
      return publicEntry(entry);
    });
  }

  async registerFromCompletedJob(job: ComposerJobRecord): Promise<LocalLibraryEntry> {
    if (job.kind !== 'compose' || job.status !== 'completed') {
      throw new Error('Only completed final composer jobs can enter the local library');
    }
    return this.registerOutput({
      batchId: job.spec.batchId,
      jobId: job.id,
      originalId: job.spec.originalId,
      hookId: job.spec.hookId,
      filename: job.spec.outputFilename,
      duration: job.spec.trimEnd - job.spec.trimStart,
      outputPath: job.files.outputPath,
      workDir: job.files.workDir,
      completedAt: job.finishedAt,
    });
  }

  async listAll(): Promise<LocalLibraryEntry[]> {
    return this.read(() => [...this.entries!.values()]
      .sort((left, right) => right.completedAt - left.completedAt || left.id.localeCompare(right.id))
      .map(publicEntry));
  }

  /** Internal cleanup protection; never returned by HTTP routes. */
  async getRetainedWorkDirs(): Promise<string[]> {
    return this.read(async () => {
      const retained: string[] = [];
      for (const entry of this.entries!.values()) {
        const directory = await this.resolveStoredDirectory(entry);
        if (directory) retained.push(directory);
      }
      return retained;
    });
  }

  async listUsable(now = this.now()): Promise<LocalLibraryEntry[]> {
    return this.mutate(async () => {
      const usable: LocalLibraryEntry[] = [];
      for (const entry of this.entries!.values()) {
        if (isLibraryEntryExpired(entry, now)) continue;
        const resolved = await this.resolveStoredFile(entry);
        if (!resolved) {
          await this.deleteInsideMutation(entry.id);
          continue;
        }
        usable.push(publicEntry(entry));
      }
      return usable.sort((left, right) => right.completedAt - left.completedAt || left.id.localeCompare(right.id));
    });
  }

  async resolveUsablePath(id: string, now = this.now()): Promise<ResolvedLibraryOutput | null> {
    validateIdentifier(id);
    return this.mutate(async () => {
      const entry = this.entries!.get(id);
      if (!entry || isLibraryEntryExpired(entry, now)) return null;
      const resolved = await this.resolveStoredFile(entry);
      if (!resolved) {
        await this.deleteInsideMutation(id);
        return null;
      }
      return { entry: publicEntry(entry), path: resolved };
    });
  }

  async hold(id: string, referenceId: string): Promise<LocalLibraryEntry> {
    validateIdentifier(id);
    validateIdentifier(referenceId, 'hold reference');
    return this.mutate(async () => {
      const entry = this.entries!.get(id);
      if (!entry || isLibraryEntryExpired(entry, this.now())) {
        throw new LocalLibraryNotFoundError('Library output is unavailable');
      }
      const resolved = await this.resolveStoredFile(entry);
      if (!resolved) {
        throw new LocalLibraryNotFoundError('Library output is unavailable');
      }
      entry.holds = [...new Set([...entry.holds, referenceId])].sort();
      return publicEntry(entry);
    });
  }

  async release(id: string, referenceId: string): Promise<boolean> {
    validateIdentifier(id);
    validateIdentifier(referenceId, 'hold reference');
    return this.mutate(async () => {
      const entry = this.entries!.get(id);
      if (!entry) return false;
      entry.holds = entry.holds.filter((hold) => hold !== referenceId);
      return true;
    });
  }

  async delete(id: string): Promise<boolean> {
    validateIdentifier(id);
    return this.mutate(async () => {
      const result = await this.deleteInsideMutation(id);
      if (result === 'missing') throw new LocalLibraryNotFoundError('Library output was not found');
      if (result === 'in-use') throw new LocalLibraryInUseError('Output is held by an active job');
      return true;
    });
  }

  async deleteMany(ids: string[]): Promise<DeleteManyLibraryResult> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !IDENTIFIER.test(id))) {
      throw new LocalLibraryValidationError('Invalid library identifiers');
    }
    return this.mutate(async () => {
      const result: DeleteManyLibraryResult = { deleted: [], inUse: [], missing: [] };
      for (const id of [...new Set(ids)]) {
        const entry = this.entries!.get(id);
        if (!entry) {
          result.missing.push(id);
        } else {
          const deletion = await this.deleteInsideMutation(id);
          if (deletion === 'in-use') result.inUse.push(id);
          else if (deletion === 'deleted') result.deleted.push(id);
          else result.missing.push(id);
        }
      }
      return result;
    });
  }

  async cleanupExpired(now = this.now()): Promise<string[]> {
    return this.mutate(async () => {
      const removed: string[] = [];
      for (const entry of [...this.entries!.values()]) {
        if (!isLibraryEntryExpired(entry, now) || entry.holds.length > 0) continue;
        if (await this.deleteInsideMutation(entry.id) === 'deleted') removed.push(entry.id);
      }
      return removed;
    });
  }

  async reconcileHolds(activeReferenceIds: Iterable<string>): Promise<string[]> {
    const active = new Set(activeReferenceIds);
    for (const id of active) validateIdentifier(id, 'hold reference');
    return this.mutate(() => {
      const released = new Set<string>();
      for (const entry of this.entries!.values()) {
        const retained: string[] = [];
        for (const hold of entry.holds) {
          if (active.has(hold)) retained.push(hold);
          else released.add(hold);
        }
        entry.holds = retained;
      }
      return [...released].sort();
    }, (released) => released.length > 0);
  }

  private validateRegistration(input: RegisterLibraryOutput): void {
    for (const [label, value] of [
      ['batch identifier', input.batchId],
      ['job identifier', input.jobId],
      ['original identifier', input.originalId],
      ['hook identifier', input.hookId],
    ] as const) validateIdentifier(value, label);
    validateFinitePositive(input.duration, 'Output duration');
    if (
      !input.filename
      || input.filename !== path.basename(input.filename)
      || /[\u0000-\u001f\u007f]/.test(input.filename)
    ) throw new LocalLibraryValidationError('Output filename must be a safe basename');
  }

  private async deleteInsideMutation(id: string): Promise<'deleted' | 'in-use' | 'missing'> {
    const entry = this.entries!.get(id);
    if (!entry) return 'missing';
    if (entry.holds.length > 0) return 'in-use';
    const resolved = await this.resolveStoredDirectory(entry);
    if (resolved) {
      try {
        await fs.rm(resolved, { recursive: true });
      } catch {
        throw new LocalLibraryStorageError('Local library output could not be deleted');
      }
    }
    this.entries!.delete(id);
    return 'deleted';
  }

  private async requireManagedFile(candidate: string): Promise<string> {
    let managedReal: string;
    let candidateReal: string;
    try {
      [managedReal, candidateReal] = await Promise.all([
        fs.realpath(this.managedRoot),
        fs.realpath(path.resolve(candidate)),
      ]);
    } catch {
      throw new LocalLibraryValidationError('Library output must exist in managed storage');
    }
    if (!isInside(managedReal, candidateReal)) {
      throw new LocalLibraryValidationError('Library output must exist in managed storage');
    }
    return candidateReal;
  }

  private async requireManagedDirectory(candidate: string): Promise<string> {
    const resolved = await this.requireManagedFile(candidate);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new LocalLibraryValidationError('Composer work directory is invalid');
    return resolved;
  }

  private async resolveStoredFile(entry: StoredLibraryEntry): Promise<string | null> {
    try {
      const managedReal = await fs.realpath(this.managedRoot);
      const lexical = path.resolve(managedReal, entry.relativePath);
      if (!isInside(managedReal, lexical)) return null;
      const resolved = await this.requireManagedFile(lexical);
      const stat = await fs.stat(resolved);
      return stat.isFile() ? resolved : null;
    } catch {
      return null;
    }
  }

  private async resolveStoredDirectory(entry: StoredLibraryEntry): Promise<string | null> {
    try {
      const managedReal = await fs.realpath(this.managedRoot);
      const expected = path.resolve(managedReal, entry.relativeWorkDir);
      if (!isInside(managedReal, expected)) return null;
      const actual = await fs.realpath(expected);
      if (path.relative(expected, actual) !== '') return null;
      const marker = await fs.readFile(path.join(actual, OWNERSHIP_MARKER), 'utf8');
      if (marker !== entry.ownershipToken) return null;
      const resolved = await this.requireManagedDirectory(actual);
      return resolved;
    } catch {
      return null;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.entries) return;
    await fs.mkdir(this.libraryRoot, { recursive: true });
    const [managedReal, libraryReal] = await Promise.all([
      fs.realpath(this.managedRoot),
      fs.realpath(this.libraryRoot),
    ]);
    if (!isInside(managedReal, libraryReal)) {
      throw new Error('Library state must be inside managed storage');
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('Local library state is invalid');
      const entries = parsed.filter(this.isStoredEntry);
      this.entries = new Map(entries.map((entry) => [entry.id, structuredClone(entry)]));
      this.syncBytesMetric();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalLibraryStorageError('Local library state could not be loaded');
      }
      this.entries = new Map();
      this.syncBytesMetric();
    }
  }

  private readonly isStoredEntry = (value: unknown): value is StoredLibraryEntry => {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Partial<StoredLibraryEntry>;
    return typeof entry.id === 'string'
      && IDENTIFIER.test(entry.id)
      && typeof entry.batchId === 'string' && IDENTIFIER.test(entry.batchId)
      && typeof entry.jobId === 'string' && IDENTIFIER.test(entry.jobId)
      && typeof entry.originalId === 'string' && IDENTIFIER.test(entry.originalId)
      && typeof entry.hookId === 'string' && IDENTIFIER.test(entry.hookId)
      && typeof entry.filename === 'string' && entry.filename === path.basename(entry.filename)
      && typeof entry.duration === 'number' && Number.isFinite(entry.duration) && entry.duration > 0
      && entry.width === 1080 && entry.height === 1920
      && typeof entry.byteSize === 'number' && Number.isSafeInteger(entry.byteSize) && entry.byteSize >= 0
      && typeof entry.completedAt === 'number' && Number.isFinite(entry.completedAt)
      && typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
      && typeof entry.relativePath === 'string'
      && !path.isAbsolute(entry.relativePath)
      && typeof entry.relativeWorkDir === 'string'
      && !path.isAbsolute(entry.relativeWorkDir)
      && typeof entry.ownershipToken === 'string'
      && IDENTIFIER.test(entry.ownershipToken)
      && Array.isArray(entry.holds)
      && entry.holds.every((hold) => typeof hold === 'string' && IDENTIFIER.test(hold));
  };

  private async persist(): Promise<void> {
    try {
      await this.persistState(this.statePath, [...this.entries!.values()].map((entry) => structuredClone(entry)));
    } catch (error) {
      if (error instanceof LocalLibraryStorageError) throw error;
      throw new LocalLibraryStorageError('Local library state could not be saved');
    }
  }

  private static async persistAtomically(statePath: string, entries: unknown[]): Promise<void> {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8');
      await fs.rename(temporary, statePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async read<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.operationChain.catch(() => {});
    await this.ensureLoaded();
    return operation();
  }

  private async mutate<T>(
    operation: () => T | Promise<T>,
    shouldPersist: (result: T) => boolean = () => true,
  ): Promise<T> {
    let result!: T;
    const current = this.operationChain.catch(() => {}).then(async () => {
      await this.ensureLoaded();
      const snapshot = new Map([...this.entries!.entries()].map(([id, entry]) => [id, structuredClone(entry)]));
      try {
        result = await operation();
        if (shouldPersist(result)) await this.persist();
        this.syncBytesMetric();
      } catch (error) {
        this.entries = snapshot;
        throw error;
      }
    });
    this.operationChain = current;
    await current;
    return result;
  }

  private syncBytesMetric(): void {
    composerLibraryBytes.set(
      [...(this.entries?.values() ?? [])].reduce((sum, entry) => sum + entry.byteSize, 0),
    );
  }
}
