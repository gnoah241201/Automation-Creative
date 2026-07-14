import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComposerBatchDraft, ComposerVariantConfig } from '../../shared/composer-contract.ts';
import { resolveComposerChild } from './composerPaths.ts';

const RETENTION_MS = 86_400_000;

export class ComposerDraftNotFoundError extends Error {}
export class ComposerDraftValidationError extends Error {}

export class ComposerDraftStore {
  private writePromise: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async create(originalIds: string[], hookIds: string[]): Promise<ComposerBatchDraft> {
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
  ): Promise<ComposerBatchDraft> {
    let result: ComposerBatchDraft | undefined;
    const write = this.writePromise.catch(() => {}).then(async () => {
      const draft = await this.read(batchId);
      if (!draft) throw new ComposerDraftNotFoundError(`Composer batch ${batchId} was not found`);
      const now = Date.now();
      result = {
        ...draft,
        configurations: { ...draft.configurations, [config.id]: config },
        updatedAt: now,
        expiresAt: now + RETENTION_MS,
      };
      await this.writeAtomically(result);
    });
    this.writePromise = write;
    await write;
    return result!;
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
      return JSON.parse(
        await fs.readFile(path.join(this.getDraftDirectory(batchId), 'draft.json'), 'utf8'),
      ) as ComposerBatchDraft;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
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
