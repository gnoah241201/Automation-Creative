import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { NativeJobRecord, RenderJobRecord } from '../types/renderJob.ts';
import { probeMedia } from './mediaProbe.ts';
import { needsNormalizing, normalizedPathFor } from './sourceNormalize.ts';
import { normalizeToH264, probeVideoCodec } from './sourceNormalizeRunner.ts';
import {
  BundleEntry,
  BundleJobInput,
  BundleSourceMedia,
  planRenderBundles,
} from './renderBundlePlan.ts';

/**
 * Packs completed resize outputs into per-config ZIP bundles.
 *
 * Unlike the library bundles this holds no references: render outputs are
 * governed by the job retention policy, so a bundle is just a short-lived plan
 * that the streaming route replays.
 */

const BUNDLE_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_JOBS_PER_REQUEST = 200;

export class RenderBundleValidationError extends Error {}

export interface PreparedRenderBundle {
  token: string;
  zipFilename: string;
  entryCount: number;
  expiresAt: number;
  downloadUrl: string;
}

export interface ClaimedRenderBundle {
  token: string;
  filename: string;
  entries: BundleEntry[];
  jobIds: string[];
}

export type RenderBundleClaim =
  | { status: 'ready'; bundle: ClaimedRenderBundle }
  | { status: 'expired' }
  | { status: 'missing' };

export interface BundleJobLookup {
  getJob: (jobId: string) => NativeJobRecord | undefined;
}

export interface RenderDownloadBundleOptions {
  probe?: (filePath: string) => Promise<BundleSourceMedia>;
  probeCodec?: (filePath: string) => Promise<string>;
  normalize?: (inputPath: string, outputPath: string) => Promise<void>;
  exists?: (filePath: string) => Promise<boolean>;
  now?: () => number;
}

interface BundleRecord extends ClaimedRenderBundle {
  owner?: string;
  expiresAt: number;
}

const isResizeRecord = (job: NativeJobRecord): job is RenderJobRecord =>
  job.kind === 'resize' || job.kind === 'trim';

export class RenderDownloadBundleService {
  private readonly lookup: BundleJobLookup;
  private readonly probe: (filePath: string) => Promise<BundleSourceMedia>;
  private readonly probeCodec: (filePath: string) => Promise<string>;
  private readonly normalize: (inputPath: string, outputPath: string) => Promise<void>;
  private readonly exists: (filePath: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly records = new Map<string, BundleRecord>();
  /** Conversions in progress, so two bundles of one source encode it once. */
  private readonly conversions = new Map<string, Promise<void>>();

  constructor(lookup: BundleJobLookup, options: RenderDownloadBundleOptions = {}) {
    this.lookup = lookup;
    this.probe = options.probe ?? (async (filePath) => probeMedia(filePath));
    this.probeCodec = options.probeCodec ?? probeVideoCodec;
    this.normalize = options.normalize ?? normalizeToH264;
    this.exists = options.exists ?? (async (filePath) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    });
    this.now = options.now ?? Date.now;
  }

  async prepare(jobIds: unknown, owner: string | undefined): Promise<PreparedRenderBundle[]> {
    if (
      !Array.isArray(jobIds)
      || jobIds.length < 1
      || jobIds.length > MAX_JOBS_PER_REQUEST
      || jobIds.some((id) => typeof id !== 'string')
      || new Set(jobIds).size !== jobIds.length
    ) {
      throw new RenderBundleValidationError(`Select 1-${MAX_JOBS_PER_REQUEST} unique completed outputs`);
    }

    const planInputs: BundleJobInput[] = [];
    for (const jobId of jobIds as string[]) {
      planInputs.push(await this.toPlanInput(jobId, owner));
    }

    const expiresAt = this.now() + BUNDLE_LIFETIME_MS;
    return planRenderBundles(planInputs).map((group) => {
      const token = randomUUID();
      this.records.set(token, {
        token,
        filename: group.zipFilename,
        entries: group.entries,
        jobIds: [...new Set(group.entries.map((entry) => entry.jobId))],
        owner,
        expiresAt,
      });
      return {
        token,
        zipFilename: group.zipFilename,
        entryCount: group.entries.length,
        expiresAt,
        downloadUrl: `/api/jobs/download-bundles/${token}`,
      };
    });
  }

  private async toPlanInput(jobId: string, owner: string | undefined): Promise<BundleJobInput> {
    const job = this.lookup.getJob(jobId);
    if (!job || !isResizeRecord(job)) {
      throw new RenderBundleValidationError(`Output ${jobId} is not available`);
    }
    // A job with no owner predates session ownership; anyone may bundle it.
    if (job.ownerKey && owner && job.ownerKey !== owner) {
      throw new RenderBundleValidationError(`Output ${jobId} is not available`);
    }
    if (job.status !== 'completed') {
      throw new RenderBundleValidationError(`Output ${jobId} is ${job.status}, not ready for download`);
    }

    // Verified now rather than at stream time: archiver turns a missing file
    // into a mid-stream error, which would abort an otherwise good ZIP.
    if (!await this.exists(job.files.outputPath)) {
      throw new RenderBundleValidationError(
        `Output ${jobId} has expired and is no longer available for download`,
      );
    }

    // A trim job's foreground is another job's output, not an original.
    // A missing original is dropped — the outputs are still worth shipping.
    const hasOriginal = job.kind === 'resize' && await this.exists(job.files.foregroundPath);
    return {
      jobId: job.id,
      naming: job.spec.naming,
      outputFilename: job.outputFilename || job.spec.outputFilename,
      outputPath: job.files.outputPath,
      sourceId: hasOriginal ? (job.sourceUploadId ?? job.files.foregroundPath) : undefined,
      sourcePath: hasOriginal ? await this.deliverableSource(job.files.foregroundPath) : undefined,
      sourceMedia: hasOriginal ? await this.probeQuietly(job.files.foregroundPath) : undefined,
    };
  }

  /**
   * The path to bundle as the original. Renders are always h264, but the source
   * carries whatever codec it arrived in, so a source in anything else is
   * converted first — otherwise one file in the ZIP refuses to open while the
   * rest play. The conversion is cached beside the source and reused.
   */
  private async deliverableSource(sourcePath: string): Promise<string> {
    let codec: string;
    try {
      codec = await this.probeCodec(sourcePath);
    } catch {
      // Cannot tell what it is; shipping the source unchanged beats dropping it.
      return sourcePath;
    }
    if (!needsNormalizing(codec)) return sourcePath;

    const converted = normalizedPathFor(sourcePath);
    if (converted === sourcePath) return sourcePath;
    if (await this.exists(converted)) return converted;

    const inFlight = this.conversions.get(converted);
    if (inFlight) {
      try {
        await inFlight;
        return converted;
      } catch {
        return sourcePath;
      }
    }

    const run = this.normalize(sourcePath, converted);
    this.conversions.set(converted, run);
    try {
      await run;
      return converted;
    } catch (error) {
      console.error(`[jobs] Could not convert ${sourcePath} to h264:`, error);
      return sourcePath;
    } finally {
      this.conversions.delete(converted);
    }
  }

  /** A source that cannot be probed is bundled under its own name, not dropped. */
  private async probeQuietly(filePath: string): Promise<BundleSourceMedia | undefined> {
    try {
      const probed = await this.probe(filePath);
      return { width: probed.width, height: probed.height, duration: probed.duration };
    } catch {
      return undefined;
    }
  }

  claim(token: string, owner: string | undefined): RenderBundleClaim {
    const record = this.records.get(token);
    if (!record) return { status: 'missing' };
    if (record.owner && owner && record.owner !== owner) return { status: 'missing' };
    if (this.now() > record.expiresAt) {
      this.records.delete(token);
      return { status: 'expired' };
    }
    return { status: 'ready', bundle: record };
  }

  release(token: string): void {
    this.records.delete(token);
  }

  /** Drops plans nobody claimed, so a long-lived process does not accumulate them. */
  pruneExpired(): void {
    const now = this.now();
    for (const [token, record] of this.records) {
      if (now > record.expiresAt) this.records.delete(token);
    }
  }
}
