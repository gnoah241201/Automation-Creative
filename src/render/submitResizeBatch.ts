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

export async function submitResizeBatch(input: SubmitResizeBatchInput): Promise<SubmittedResizeJob[]> {
  const submitted: SubmittedResizeJob[] = [];
  const sourcePrimaries: Array<{
    source: ResizeBatchSource;
    primaryByOutput: Map<string, SubmittedResizeJob>;
  }> = [];
  for (const source of input.sources) {
    const primaryByOutput = new Map<string, SubmittedResizeJob>();
    for (const output of input.outputs.filter((item) => !item.trimFrom)) {
      const spec = buildSpec(input.config, source, output);
      const result = await input.createJob({ source, output, spec });
      const job = {
        sourceId: source.libraryId ?? source.localId,
        outputId: output.id,
        spec,
        ...result,
      };
      submitted.push(job);
      primaryByOutput.set(output.id, job);
    }
    sourcePrimaries.push({ source, primaryByOutput });
  }

  const readyPrimaryIds = new Map<string, string>();
  for (const { source, primaryByOutput } of sourcePrimaries) {
    for (const output of input.outputs.filter((item) => item.trimFrom)) {
      if (!input.waitForPrimary || !input.createTrimJob) {
        throw new Error('Trim submission callbacks are required');
      }
      const primary = primaryByOutput.get(output.trimFrom!);
      if (!primary) throw new Error(`Primary output ${output.trimFrom} was not selected`);
      let sourceJobId = readyPrimaryIds.get(primary.jobId);
      if (!sourceJobId) {
        sourceJobId = await input.waitForPrimary(primary);
        readyPrimaryIds.set(primary.jobId, sourceJobId);
      }
      const spec = buildSpec(input.config, source, output);
      const result = await input.createTrimJob({ source, output, spec, sourceJobId });
      submitted.push({
        sourceId: source.libraryId ?? source.localId,
        outputId: output.id,
        spec,
        ...result,
      });
    }
  }
  return submitted;
}
