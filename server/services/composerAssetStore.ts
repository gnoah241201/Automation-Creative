import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ComposerAsset, ComposerAssetKind, ComposerCrop } from '../../shared/composer-contract.ts';
import { getFfmpegPath } from './encoderConfig.ts';
import { MediaProbe, probeMedia } from './mediaProbe.ts';
import { resolveComposerChild } from './composerPaths.ts';

type ProbeMedia = (filePath: string) => MediaProbe | Promise<MediaProbe>;
type CreateThumbnail = (sourcePath: string, outputPath: string) => Promise<void>;

const sourceExtension = (filename: string): string => {
  const extension = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
};

export class ComposerAssetStore {
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
      const metadata = await this.probe(sourcePath);
      const ready = Math.abs(metadata.width / metadata.height - 9 / 16) <= 0.002;
      const thumbnailPath = path.join(assetDir, 'thumbnail.jpg');
      await this.thumbnailer(sourcePath, thumbnailPath);
      const now = Date.now();
      const asset: ComposerAsset = {
        id,
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

  async setCrop(id: string, crop: ComposerCrop): Promise<ComposerAsset> {
    const asset = await this.requireAsset(id);
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
      throw new Error('Crop must be normalized inside the source frame');
    }

    const pixelRatio = (crop.width * asset.width) / (crop.height * asset.height);
    if (Math.abs(pixelRatio - 9 / 16) > 0.002) {
      throw new Error('Crop must have a 9:16 aspect ratio');
    }

    const next: ComposerAsset = {
      ...asset,
      crop,
      status: 'ready',
      lastAccessedAt: Date.now(),
    };
    await this.writeAsset(this.getAssetDirectory(id), next);
    return next;
  }

  async getAsset(id: string): Promise<ComposerAsset | null> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.getAssetDirectory(id), 'metadata.json'), 'utf8'),
      ) as ComposerAsset;
    } catch {
      return null;
    }
  }

  async requireAsset(id: string): Promise<ComposerAsset> {
    const asset = await this.getAsset(id);
    if (!asset) {
      throw new Error(`Composer asset ${id} was not found`);
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

  private async writeAsset(assetDir: string, asset: ComposerAsset): Promise<void> {
    const target = path.join(assetDir, 'metadata.json');
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(asset, null, 2), 'utf8');
    await fs.rename(temporary, target);
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
