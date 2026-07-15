import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ComposerAsset, ComposerAssetKind, ComposerCrop, SourceTimeRange } from '../../shared/composer-contract.ts';
import { getEffectiveSourceRange } from '../../shared/composerSourceRange.ts';
import { getFfmpegPath } from './encoderConfig.ts';
import { InvalidMediaProbeError, MediaProbe, MediaProbeUnavailableError, probeMedia } from './mediaProbe.ts';
import { resolveComposerChild } from './composerPaths.ts';

type ProbeMedia = (filePath: string) => MediaProbe | Promise<MediaProbe>;
type CreateThumbnail = (sourcePath: string, outputPath: string) => Promise<void>;

export class ComposerInvalidMediaError extends Error {}
export class ComposerProbeUnavailableError extends Error {}
export class ComposerAssetConflictError extends Error {}
export class ComposerAssetValidationError extends Error {}
export class ComposerAssetNotFoundError extends Error {}

const sourceExtension = (filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
};

export class ComposerAssetStore {
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly probe: ProbeMedia = probeMedia,
    private readonly thumbnailer: CreateThumbnail = ComposerAssetStore.createThumbnail,
  ) {}

  async createAsset(
    kind: ComposerAssetKind,
    filename: string,
    uploadedPath: string,
  ): Promise<ComposerAsset> {
    const id = randomUUID();
    const assetDir = resolveComposerChild(path.join(this.root, 'assets'), id);
    await fs.mkdir(assetDir, { recursive: true });
    const sourcePath = path.join(assetDir, `source${sourceExtension(filename)}`);

    try {
      await fs.rename(uploadedPath, sourcePath);
      let metadata: MediaProbe;
      try {
        metadata = await this.probe(sourcePath);
      } catch (error) {
        if (error instanceof InvalidMediaProbeError) throw new ComposerInvalidMediaError('Media is not readable');
        if (error instanceof MediaProbeUnavailableError) throw new ComposerProbeUnavailableError('Media probe is unavailable');
        throw error;
      }
      const ready = Math.abs(metadata.width / metadata.height - 9 / 16) <= 0.002;
      const thumbnailPath = path.join(assetDir, 'thumbnail.jpg');
      await this.thumbnailer(sourcePath, thumbnailPath);
      const now = Date.now();
      const asset: ComposerAsset = {
        id,
        revision: 1,
        kind,
        originalFilename: filename,
        ...metadata,
        status: ready ? 'ready' : 'needs-crop',
        thumbnailUrl: `/api/composer/assets/${id}/thumbnail`,
        createdAt: now,
        lastAccessedAt: now,
      };
      await this.writeAsset(assetDir, asset);
      return asset;
    } catch (error) {
      await fs.rm(assetDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async setSourceTrim(id: string, range: SourceTimeRange, expectedRevision: number): Promise<ComposerAsset> {
    return this.mutateAsset(id, expectedRevision, (asset) => {
      const candidate = { ...asset, sourceTrimStart: range.start, sourceTrimEnd: range.end };
      let effective: SourceTimeRange;
      try {
        effective = getEffectiveSourceRange(candidate);
      } catch {
        throw new ComposerAssetValidationError('Source trim is outside the media frame range');
      }
      return { ...asset, sourceTrimStart: effective.start, sourceTrimEnd: effective.end };
    });
  }

  async setCrop(id: string, crop: ComposerCrop, expectedRevision: number): Promise<ComposerAsset> {
    return this.mutateAsset(id, expectedRevision, (asset) => {
      const values = [crop.x, crop.y, crop.width, crop.height];
      if (
        values.some((value) => !Number.isFinite(value))
        || crop.x < 0
        || crop.y < 0
        || crop.width <= 0
        || crop.height <= 0
        || crop.x + crop.width > 1
        || crop.y + crop.height > 1
      ) {
        throw new ComposerAssetValidationError('Crop must be normalized inside the source frame');
      }

      const pixelRatio = (crop.width * asset.width) / (crop.height * asset.height);
      if (Math.abs(pixelRatio - 9 / 16) > 0.002) {
        throw new ComposerAssetValidationError('Crop must have a 9:16 aspect ratio');
      }

      return { ...asset, crop, status: 'ready' };
    });
  }

  async getAsset(id: string): Promise<ComposerAsset | null> {
    try {
      return this.normalizeAsset(JSON.parse(
        await fs.readFile(path.join(this.getAssetDirectory(id), 'metadata.json'), 'utf8'),
      ) as ComposerAsset);
    } catch {
      return null;
    }
  }

  async requireAsset(id: string): Promise<ComposerAsset> {
    const asset = await this.getAsset(id);
    if (!asset) {
      throw new ComposerAssetNotFoundError(`Composer asset ${id} was not found`);
    }
    return asset;
  }

  async requireReadyAsset(id: string, kind: ComposerAssetKind): Promise<ComposerAsset> {
    const asset = await this.requireAsset(id);
    if (asset.kind !== kind || asset.status !== 'ready') {
      throw new Error(`Composer asset ${id} is not a ready ${kind}`);
    }
    return asset;
  }

  getSourcePath(id: string, originalFilename: string): string {
    return path.join(this.getAssetDirectory(id), `source${sourceExtension(originalFilename)}`);
  }

  getThumbnailPath(id: string): string {
    return path.join(this.getAssetDirectory(id), 'thumbnail.jpg');
  }

  private getAssetDirectory(id: string): string {
    return resolveComposerChild(path.join(this.root, 'assets'), id);
  }

  private normalizeAsset(asset: ComposerAsset): ComposerAsset {
    return {
      ...asset,
      revision: Number.isSafeInteger(asset.revision) && asset.revision > 0 ? asset.revision : 1,
    };
  }

  private async mutateAsset(
    id: string,
    expectedRevision: number,
    update: (asset: ComposerAsset) => ComposerAsset,
  ): Promise<ComposerAsset> {
    let result!: ComposerAsset;
    await this.enqueueAssetWrite(id, async () => {
      const asset = await this.requireAsset(id);
      if (asset.revision !== expectedRevision) {
        throw new ComposerAssetConflictError('Stale asset revision');
      }
      result = {
        ...update(asset),
        revision: asset.revision + 1,
        lastAccessedAt: Date.now(),
      };
      await this.writeAssetAtomically(this.getAssetDirectory(id), result);
    });
    return result;
  }

  private async enqueueAssetWrite(id: string, update: () => Promise<void>): Promise<void> {
    const assetDir = this.getAssetDirectory(id);
    const previous = this.writeChains.get(assetDir) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(update);
    this.writeChains.set(assetDir, write);
    try {
      await write;
    } finally {
      if (this.writeChains.get(assetDir) === write) {
        this.writeChains.delete(assetDir);
      }
    }
  }

  private async writeAsset(assetDir: string, asset: ComposerAsset): Promise<void> {
    const previous = this.writeChains.get(assetDir) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(() => this.writeAssetAtomically(assetDir, asset));
    this.writeChains.set(assetDir, write);
    try {
      await write;
    } finally {
      if (this.writeChains.get(assetDir) === write) {
        this.writeChains.delete(assetDir);
      }
    }
  }

  private async writeAssetAtomically(assetDir: string, asset: ComposerAsset): Promise<void> {
    const target = path.join(assetDir, 'metadata.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(asset, null, 2), 'utf8');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  private static async createThumbnail(sourcePath: string, outputPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(getFfmpegPath(), [
        '-y',
        '-ss',
        '0',
        '-i',
        sourcePath,
        '-frames:v',
        '1',
        '-vf',
        'scale=240:-2',
        outputPath,
      ]);
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Thumbnail FFmpeg exited with code ${code}`));
      });
    });
  }
}
