import fs from 'node:fs/promises';
import path from 'node:path';
import { RenderJobRecord } from '../types/renderJob';

const STATE_FILE = 'queue-state.json';

/**
 * Persistence layer for queue state.
 * 
 * Uses atomic writes (temp file + rename) to prevent corruption.
 * Uses a promise queue to serialize writes - no writes are dropped.
 * State is persisted to a JSON file in the temp root directory.
 */
export class JobStore {
  private statePath: string;
  private writePromise: Promise<void> = Promise.resolve();
  private pendingData: RenderJobRecord[] | null = null;

  constructor(tempRoot: string) {
    this.statePath = path.join(tempRoot, STATE_FILE);
  }

  /**
   * Load persisted jobs from disk.
   * Returns empty array if no state file exists.
   */
  async load(): Promise<RenderJobRecord[]> {
    try {
      const exists = await this.fileExists(this.statePath);
      if (!exists) {
        console.log('[jobStore] No persisted state found, starting fresh');
        return [];
      }

      const content = await fs.readFile(this.statePath, 'utf-8');
      const data = JSON.parse(content) as RenderJobRecord[];
      
      console.log(`[jobStore] Loaded ${data.length} persisted jobs`);
      return data;
    } catch (error) {
      console.error('[jobStore] Failed to load persisted state:', error);
      // If state is corrupted, start fresh but log the issue
      return [];
    }
  }

  /**
   * Save all jobs atomically using temp file + rename.
   * Uses a promise chain to serialize writes - never drops writes.
   * Each call queues after the previous write completes.
   */
  async save(jobs: RenderJobRecord[]): Promise<void> {
    // Capture the data to save at the time of this call
    const dataToSave = [...jobs];
    
    // Chain onto existing promise to serialize writes
    this.writePromise = this.writePromise.then(async () => {
      try {
        const tempPath = this.statePath + '.tmp';
        const content = JSON.stringify(dataToSave, null, 2);
        
        // Write to temp file first
        await fs.writeFile(tempPath, content, 'utf-8');
        
        // Atomic rename (on POSIX this is atomic, on Windows it's close enough)
        await fs.rename(tempPath, this.statePath);
      } catch (error) {
        console.error('[jobStore] Failed to save state:', error);
        throw error;
      }
    });
    
    // Wait for this specific write to complete
    await this.writePromise;
  }

  /**
   * Wait for all pending writes to complete
   * Useful for testing or graceful shutdown
   */
  async flush(): Promise<void> {
    await this.writePromise;
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if work directory exists for a job (for recovery validation)
   */
  async workDirExists(workDir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(workDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }
}
