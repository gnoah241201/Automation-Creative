import { ResizeBatchSource } from './librarySources';
import { originalFilename } from './originalCopy';
import { PlannedJob } from './renderPlan';

export interface NamedOriginal {
  source: ResizeBatchSource;
  filename: string;
}

export interface OriginalNames {
  /** Sources whose original has a name of its own. */
  named: NamedOriginal[];
  /** Sources that get no original, each with the reason, ready to show. */
  withheld: string[];
}

/**
 * Names every source's original ahead of the run, so the same overwrite check
 * that guards the resized outputs can guard the originals too.
 *
 * `findCollisions` only sees planned jobs, and the original is not one: it is
 * copied after the queue, by a call that silently replaces whatever is there.
 * Left out of the check, a second run into the same folder would overwrite the
 * first run's originals without the prompt the resized files get.
 *
 * An original is withheld rather than written when its name is also the name of
 * a planned output. In cut mode a 15.3s portrait source has no separate
 * full-length output; its composite IS the `_15s` one, and the original's name
 * (`_15s`, the duration rounded) is identical. Copying the original afterwards
 * would replace the render with the unprocessed source under the render's name.
 */
export const nameOriginals = (
  sources: ResizeBatchSource[],
  planned: PlannedJob[],
): OriginalNames => {
  const taken = new Set(planned.map((job) => job.filename.toLowerCase()));
  const named: NamedOriginal[] = [];
  const withheld: string[] = [];

  for (const source of sources) {
    let filename: string;
    try {
      filename = originalFilename(source);
    } catch (error) {
      withheld.push(`${source.filename}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (taken.has(filename.toLowerCase())) {
      withheld.push(`${source.filename}: tên bản gốc (${filename}) trùng với một output đã render`);
      continue;
    }
    named.push({ source, filename });
  }
  return { named, withheld };
};

/** Which originals would land on a file already in the folder. */
export const collidingOriginals = (named: NamedOriginal[], existing: string[]): NamedOriginal[] => {
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  return named.filter((item) => taken.has(item.filename.toLowerCase()));
};
