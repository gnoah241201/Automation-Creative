import { CreateJobResponse, RenderSpec } from '../../shared/render-contract.ts';
import { OutputConfig, planSelectedOutputs } from './outputDerivation.ts';
import { ResizeBatchSource } from './librarySources.ts';
import { sourceInputRatio } from './batchOutputs.ts';
import { filterPendingOutputs, ResizeBatchWorkResult } from './resizeBatchState.ts';
import { buildRenderSpec } from './renderSpec.ts';

type SharedConfig = Omit<Parameters<typeof buildRenderSpec>[0],
  'outputRatio' | 'duration' | 'gameName' | 'version' | 'suffix'>;

export interface SubmittedResizeJob extends CreateJobResponse {
  sourceId: string;
  outputId: string;
  spec: RenderSpec;
}

export interface SubmitResizeBatchInput {
  sources: ResizeBatchSource[];
  outputs: OutputConfig[];
  outputCatalog?: OutputConfig[];
  /**
   * Full output list for one source. When supplied, `outputs` is read as a set
   * of selected ids and each source contributes only the ones it can actually
   * produce, wired with its own `trimFrom`. Sources in a batch differ in length,
   * so both the available cuts and the long-form master differ per source.
   * Omit it to apply one shared list to every source.
   */
  catalogForSource?: (source: ResizeBatchSource) => OutputConfig[];
  config: SharedConfig;
  createJob: (input: {
    source: ResizeBatchSource;
    output: OutputConfig;
    spec: RenderSpec;
  }) => Promise<CreateJobResponse>;
  waitForPrimary?: (job: SubmittedResizeJob) => Promise<string>;
  createTrimJob?: (input: {
    source: ResizeBatchSource;
    output: OutputConfig;
    spec: RenderSpec;
    sourceJobId: string;
  }) => Promise<CreateJobResponse>;
}

export interface ResizeBatchFailure {
  outputId: string;
  phase: 'primary' | 'wait' | 'trim';
  message: string;
}

export interface ResizeBatchSourceOutcome {
  sourceId: string;
  accepted: boolean;
  errors: ResizeBatchFailure[];
}

export interface SubmitResizeBatchResult {
  submitted: SubmittedResizeJob[];
  outcomes: ResizeBatchSourceOutcome[];
  workItems: ResizeBatchWorkResult[];
}

const buildSpec = (
  config: SharedConfig,
  source: ResizeBatchSource,
  output: OutputConfig,
): RenderSpec => buildRenderSpec({
  ...config,
  // Sources in a batch can differ in orientation, so the shared config cannot
  // decide this one.
  inputRatio: sourceInputRatio(source),
  outputRatio: output.ratio,
  duration: output.duration ?? source.duration,
  gameName: source.gameName,
  version: source.version,
  suffix: source.suffix,
});

const failureMessage = (error: unknown): string => error instanceof Error ? error.message : 'Resize submission failed';

export async function submitResizeBatch(input: SubmitResizeBatchInput): Promise<SubmitResizeBatchResult> {
  const submitted: SubmittedResizeJob[] = [];
  const workItems: ResizeBatchWorkResult[] = [];
  const sourcePrimaries: Array<{
    source: ResizeBatchSource;
    outputs: OutputConfig[];
    catalog: OutputConfig[];
    primaryByOutput: Map<string, SubmittedResizeJob>;
    outcome: ResizeBatchSourceOutcome;
  }> = [];
  const selectedOutputIds = new Set(input.outputs.map((output) => output.id));
  for (const source of input.sources) {
    const catalog = input.catalogForSource
      ? input.catalogForSource(source)
      : (input.outputCatalog ?? input.outputs);
    const selectedForSource = input.catalogForSource
      ? planSelectedOutputs(catalog, selectedOutputIds)
      : input.outputs;
    const outputs = filterPendingOutputs(source, selectedForSource);
    const primaryByOutput = new Map<string, SubmittedResizeJob>();
    const outcome: ResizeBatchSourceOutcome = {
      sourceId: source.libraryId ?? source.localId,
      accepted: false,
      errors: [],
    };
    for (const output of outputs) {
      workItems.push({ sourceId: outcome.sourceId, outputId: output.id, status: 'retryable' });
    }
    for (const output of outputs.filter((item) => !item.trimFrom)) {
      const spec = buildSpec(input.config, source, output);
      try {
        const result = await input.createJob({ source, output, spec });
        const job = {
          sourceId: source.libraryId ?? source.localId,
          outputId: output.id,
          spec,
          ...result,
        };
        submitted.push(job);
        primaryByOutput.set(output.id, job);
        outcome.accepted = true;
        const workItem = workItems.find((item) => item.sourceId === outcome.sourceId && item.outputId === output.id)!;
        workItem.status = 'accepted';
      } catch (error) {
        outcome.errors.push({ outputId: output.id, phase: 'primary', message: failureMessage(error) });
      }
    }
    sourcePrimaries.push({ source, outputs, catalog, primaryByOutput, outcome });
  }

  const readyPrimaryIds = new Map<string, { sourceJobId?: string; error?: string }>();
  for (const { source, outputs, catalog, primaryByOutput, outcome } of sourcePrimaries) {
    const selectedIds = new Set(outputs.map((output) => output.id));
    const pendingIds = new Set(source.pendingOutputIds ?? selectedIds);
    // Retry can leave a dependency pending without it being selected now; plan
    // it against the same union so its trimFrom matches this source's master.
    const deferredCatalog = input.catalogForSource
      ? planSelectedOutputs(catalog, new Set([...selectedIds, ...pendingIds]))
      : catalog;
    const deferredDependencies = deferredCatalog.filter((output) => (
      output.trimFrom
      && pendingIds.has(output.id)
      && !selectedIds.has(output.id)
    ));
    for (const primaryOutputId of new Set(deferredDependencies.map((output) => output.trimFrom!))) {
      const primary = primaryByOutput.get(primaryOutputId);
      if (!primary || !input.waitForPrimary) continue;
      let ready = readyPrimaryIds.get(primary.jobId);
      if (!ready) {
        try {
          ready = { sourceJobId: await input.waitForPrimary(primary) };
        } catch (error) {
          ready = { error: failureMessage(error) };
        }
        readyPrimaryIds.set(primary.jobId, ready);
      }
      const primaryWorkItem = workItems.find((item) => item.sourceId === outcome.sourceId && item.outputId === primaryOutputId);
      if (!primaryWorkItem) continue;
      if (ready.sourceJobId) {
        primaryWorkItem.completedPrimaryJobId = ready.sourceJobId;
      } else {
        primaryWorkItem.status = 'retryable';
        outcome.errors.push({ outputId: primaryOutputId, phase: 'wait', message: ready.error ?? 'Primary output is unavailable' });
      }
    }
  }
  for (const { source, outputs, primaryByOutput, outcome } of sourcePrimaries) {
    for (const output of outputs.filter((item) => item.trimFrom)) {
      if (!input.waitForPrimary || !input.createTrimJob) {
        outcome.errors.push({ outputId: output.id, phase: 'trim', message: 'Trim submission callbacks are required' });
        continue;
      }
      const completedPrimaryJobId = source.completedPrimaryJobIds?.[output.trimFrom!];
      const primary = primaryByOutput.get(output.trimFrom!);
      if (completedPrimaryJobId) {
        const spec = buildSpec(input.config, source, output);
        try {
          const result = await input.createTrimJob({ source, output, spec, sourceJobId: completedPrimaryJobId });
          submitted.push({ sourceId: outcome.sourceId, outputId: output.id, spec, ...result });
          workItems.find((item) => item.sourceId === outcome.sourceId && item.outputId === output.id)!.status = 'accepted';
          outcome.accepted = true;
        } catch (error) {
          outcome.errors.push({ outputId: output.id, phase: 'trim', message: failureMessage(error) });
        }
        continue;
      }
      if (!primary) {
        outcome.errors.push({ outputId: output.id, phase: 'trim', message: `Primary output ${output.trimFrom} was not accepted` });
        continue;
      }
      let ready = readyPrimaryIds.get(primary.jobId);
      if (!ready) {
        try {
          ready = { sourceJobId: await input.waitForPrimary(primary) };
        } catch (error) {
          ready = { error: failureMessage(error) };
        }
        readyPrimaryIds.set(primary.jobId, ready);
      }
      if (!ready.sourceJobId) {
        const primaryWorkItem = workItems.find((item) => item.sourceId === outcome.sourceId && item.outputId === output.trimFrom);
        if (primaryWorkItem) primaryWorkItem.status = 'retryable';
        outcome.errors.push({ outputId: output.id, phase: 'wait', message: ready.error ?? 'Primary output is unavailable' });
        continue;
      }
      const primaryWorkItem = workItems.find((item) => item.sourceId === outcome.sourceId && item.outputId === output.trimFrom);
      if (primaryWorkItem) primaryWorkItem.completedPrimaryJobId = ready.sourceJobId;
      const spec = buildSpec(input.config, source, output);
      try {
        const result = await input.createTrimJob({ source, output, spec, sourceJobId: ready.sourceJobId });
        submitted.push({
          sourceId: source.libraryId ?? source.localId,
          outputId: output.id,
          spec,
          ...result,
        });
        workItems.find((item) => item.sourceId === outcome.sourceId && item.outputId === output.id)!.status = 'accepted';
        outcome.accepted = true;
      } catch (error) {
        outcome.errors.push({ outputId: output.id, phase: 'trim', message: failureMessage(error) });
      }
    }
  }
  return { submitted, outcomes: sourcePrimaries.map(({ outcome }) => outcome), workItems };
}
