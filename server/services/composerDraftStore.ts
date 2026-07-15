import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComposerBatchDraft, ComposerVariantConfig } from '../../shared/composer-contract.ts';
import { resolveComposerChild } from './composerPaths.ts';

const RETENTION_MS = 86_400_000;

export class ComposerDraftNotFoundError extends Error {}
export class ComposerDraftValidationError extends Error {}
export class ComposerDraftConflictError extends Error {}

export class ComposerDraftStore {
  private writePromise: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async create(
    originalIds: string[],
    hookIds: string[],
    assetRevisions: Record<string, number>,
  ): Promise<ComposerBatchDraft> {
    if (
      originalIds.length < 1
      || originalIds.length > 10
      || hookIds.length < 1
      || hookIds.length > 10
    ) {
      throw new ComposerDraftValidationError('A batch requires 1-10 originals and 1-10 hooks');
    }
    if (new Set(originalIds).size !== originalIds.length || new Set(hookIds).size !== hookIds.length) {
      throw new ComposerDraftValidationError('A batch cannot contain duplicate asset IDs');
    }

    const now = Date.now();
    const draft: ComposerBatchDraft = {
      id: randomUUID(),
      revision: 1,
      assetRevisions: { ...assetRevisions },
      originalIds: [...originalIds],
      hookIds: [...hookIds],
      durationGroups: [],
      configurations: {},
      createdAt: now,
      updatedAt: now,
      expiresAt: now + RETENTION_MS,
    };
    await this.save(draft);
    return draft;
  }

  async putConfiguration(
    batchId: string,
    config: ComposerVariantConfig,
    expectedRevision: number,
  ): Promise<ComposerBatchDraft> {
    return this.mutate(batchId, expectedRevision, (draft) => ({
      ...draft,
        configurations: { ...draft.configurations, [config.id]: config },
    }));
  }

  async applyConfigurations(
    batchId: string,
    targets: ComposerVariantConfig[],
    expectedRevision: number,
  ): Promise<ComposerBatchDraft> {
    return this.mutate(batchId, expectedRevision, (draft) => ({
      ...draft,
      configurations: Object.fromEntries([
        ...Object.entries(draft.configurations),
        ...targets.map((target) => [target.id, target] as const),
      ]),
    }));
  }

  async get(batchId: string): Promise<ComposerBatchDraft | null> {
    return this.read(batchId);
  }

  async require(batchId: string): Promise<ComposerBatchDraft> {
    const draft = await this.get(batchId);
    if (!draft) throw new ComposerDraftNotFoundError(`Composer batch ${batchId} was not found`);
    return draft;
  }

  async save(draft: ComposerBatchDraft): Promise<void> {
    const snapshot = structuredClone(draft);
    const write = this.writePromise.catch(() => {}).then(() => this.writeAtomically(snapshot));
    this.writePromise = write;
    await write;
  }

  async initializeAssetRevisions(
    batchId: string,
    assetRevisions: Record<string, number>,
  ): Promise<ComposerBatchDraft> {
    let result!: ComposerBatchDraft;
    const write = this.writePromise.catch(() => {}).then(async () => {
      const draft = await this.read(batchId);
      if (!draft) throw new ComposerDraftNotFoundError(`Composer batch ${batchId} was not found`);
      const ids = [...draft.originalIds, ...draft.hookIds];
      if (ids.every((id) => Number.isSafeInteger(draft.assetRevisions[id]) && draft.assetRevisions[id] > 0)) {
        result = draft;
        return;
      }
      result = { ...draft, assetRevisions: { ...assetRevisions } };
      await this.writeAtomically(result);
    });
    this.writePromise = write;
    await write;
    return result;
  }

  private getDraftDirectory(batchId: string): string {
    try {
      return resolveComposerChild(path.join(this.root, 'drafts'), batchId);
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid managed asset identifier') {
        throw new ComposerDraftNotFoundError(`Composer batch ${batchId} was not found`);
      }
      throw error;
    }
  }

  private async read(batchId: string): Promise<ComposerBatchDraft | null> {
    try {
      const draft = JSON.parse(
        await fs.readFile(path.join(this.getDraftDirectory(batchId), 'draft.json'), 'utf8'),
      ) as ComposerBatchDraft;
      return {
        ...draft,
        revision: Number.isSafeInteger(draft.revision) && draft.revision > 0 ? draft.revision : 1,
        assetRevisions: draft.assetRevisions && typeof draft.assetRevisions === 'object'
          ? { ...draft.assetRevisions }
          : {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async mutate(
    batchId: string,
    expectedRevision: number,
    update: (draft: ComposerBatchDraft) => ComposerBatchDraft,
  ): Promise<ComposerBatchDraft> {
    let result!: ComposerBatchDraft;
    const write = this.writePromise.catch(() => {}).then(async () => {
      const draft = await this.read(batchId);
      if (!draft) throw new ComposerDraftNotFoundError(`Composer batch ${batchId} was not found`);
      if (draft.revision !== expectedRevision) {
        throw new ComposerDraftConflictError('Stale draft revision');
      }
      const now = Date.now();
      result = {
        ...update(draft),
        revision: draft.revision + 1,
        updatedAt: now,
        expiresAt: now + RETENTION_MS,
      };
      await this.writeAtomically(result);
    });
    this.writePromise = write;
    await write;
    return result;
  }

  private async writeAtomically(draft: ComposerBatchDraft): Promise<void> {
    const directory = this.getDraftDirectory(draft.id);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, 'draft.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(draft, null, 2), 'utf8');
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}
