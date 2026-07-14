import { CreateJobResponse, RenderSpec } from '../../shared/render-contract.ts';
import { OutputConfig } from './outputDerivation.ts';
import { ResizeBatchSource } from './librarySources.ts';
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
}

const buildSpec = (
  config: SharedConfig,
  source: ResizeBatchSource,
  output: OutputConfig,
): RenderSpec => buildRenderSpec({
  ...config,
  outputRatio: output.ratio,
  duration: output.duration ?? source.duration,
  gameName: source.gameName,
  version: source.version,
  suffix: source.suffix,
});

const failureMessage = (error: unknown): string => error instanceof Error ? error.message : 'Resize submission failed';

export async function submitResizeBatch(input: SubmitResizeBatchInput): Promise<SubmitResizeBatchResult> {
  const submitted: SubmittedResizeJob[] = [];
  const sourcePrimaries: Array<{
    source: ResizeBatchSource;
    primaryByOutput: Map<string, SubmittedResizeJob>;
    outcome: ResizeBatchSourceOutcome;
  }> = [];
  for (const source of input.sources) {
    const primaryByOutput = new Map<string, SubmittedResizeJob>();
    const outcome: ResizeBatchSourceOutcome = {
      sourceId: source.libraryId ?? source.localId,
      accepted: false,
      errors: [],
    };
    for (const output of input.outputs.filter((item) => !item.trimFrom)) {
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
      } catch (error) {
        outcome.errors.push({ outputId: output.id, phase: 'primary', message: failureMessage(error) });
      }
    }
    sourcePrimaries.push({ source, primaryByOutput, outcome });
  }

  const readyPrimaryIds = new Map<string, { sourceJobId?: string; error?: string }>();
  for (const { source, primaryByOutput, outcome } of sourcePrimaries) {
    for (const output of input.outputs.filter((item) => item.trimFrom)) {
      if (!input.waitForPrimary || !input.createTrimJob) {
        outcome.errors.push({ outputId: output.id, phase: 'trim', message: 'Trim submission callbacks are required' });
        continue;
      }
      const primary = primaryByOutput.get(output.trimFrom!);
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
        outcome.errors.push({ outputId: output.id, phase: 'wait', message: ready.error ?? 'Primary output is unavailable' });
        continue;
      }
      const spec = buildSpec(input.config, source, output);
      try {
        const result = await input.createTrimJob({ source, output, spec, sourceJobId: ready.sourceJobId });
        submitted.push({
          sourceId: source.libraryId ?? source.localId,
          outputId: output.id,
          spec,
          ...result,
        });
        outcome.accepted = true;
      } catch (error) {
        outcome.errors.push({ outputId: output.id, phase: 'trim', message: failureMessage(error) });
      }
    }
  }
  return { submitted, outcomes: sourcePrimaries.map(({ outcome }) => outcome) };
}
