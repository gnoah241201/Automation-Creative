import { AspectRatio } from './contract';
import { ResizeBatchSource } from './librarySources';
import { LengthMode, OutputConfig, deriveOutputs } from './outputDerivation';
import { buildOutputFilename } from './naming';

export interface PlannedJob {
  id: string;
  sourceId: string;
  outputId: string;
  ratio: AspectRatio;
  duration?: number;
  filename: string;
  /** Job id this one reads from. Absent on a composite. */
  dependsOn?: string;
  kind: 'composite' | 'trim' | 'speed';
}

const jobId = (sourceId: string, outputId: string) => `${sourceId}::${outputId}`;

const parentOf = (output: OutputConfig): string | undefined => output.trimFrom ?? output.speedFrom;

const kindOf = (output: OutputConfig): PlannedJob['kind'] => {
  if (output.trimFrom) return 'trim';
  if (output.speedFrom) return 'speed';
  return 'composite';
};

/**
 * Turns a tick-list into an ordered job list.
 *
 * Two things the selection cannot express on its own. A child needs its
 * parent, and the user only ticked the child — the parent is pulled in here,
 * not forced into the catalog. And a tier belongs to a source: in a batch of
 * mixed lengths, a 20s clip simply has no 30s output, so the tick quietly does
 * not apply to it.
 *
 * Parents are emitted before their children so a queue can walk the list in
 * order and never start a job whose input does not exist yet.
 */
export const planBatch = (
  sources: ResizeBatchSource[],
  selectedIds: ReadonlySet<string>,
  mode: LengthMode,
): PlannedJob[] => {
  const jobs: PlannedJob[] = [];

  for (const source of sources) {
    const catalog = deriveOutputs(source.inputRatio ?? '9:16', source.duration, mode);
    const byId = new Map(catalog.map((output) => [output.id, output]));

    const wanted = catalog.filter((output) => selectedIds.has(output.id));
    if (wanted.length === 0) continue;

    // A ticked child drags its parent in. Walking up the chain rather than
    // assuming one level keeps this correct if a mode ever nests deeper.
    const required = new Set<string>();
    const pullIn = (id: string) => {
      if (required.has(id)) return;
      const output = byId.get(id);
      if (!output) return;
      const parent = parentOf(output);
      if (parent) pullIn(parent);
      required.add(id);
    };
    for (const output of wanted) pullIn(output.id);

    // `required` is in dependency order, because `pullIn` adds a parent before
    // the child that asked for it. Do NOT iterate `catalog` here instead: its
    // order is for display, and in cut mode without a full-length output the
    // composite is the longest tier and therefore comes last.
    for (const id of required) {
      const output = byId.get(id)!;
      const parent = parentOf(output);
      jobs.push({
        id: jobId(source.localId, output.id),
        sourceId: source.localId,
        outputId: output.id,
        ratio: output.ratio,
        duration: output.duration,
        filename: buildOutputFilename(
          { gameName: source.gameName, version: source.version, suffix: source.suffix },
          output.ratio,
          output.duration,
        ),
        ...(parent ? { dependsOn: jobId(source.localId, parent) } : {}),
        kind: kindOf(output),
      });
    }
  }

  return jobs;
};
