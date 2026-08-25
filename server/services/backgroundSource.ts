import { RenderSpec } from '../../shared/render-contract.ts';

/**
 * Where a video background comes from.
 *
 * Batch resize offers only two choices: every clip blurs itself, or one
 * uploaded image sits behind all of them. `self` covers the first — there is no
 * file to upload, so the renderer reuses the foreground as its own background
 * input and the existing blur path handles the rest.
 */
export const resolveBackgroundVideoPath = (
  spec: Pick<RenderSpec, 'bgType' | 'backgroundSource'>,
  paths: { foregroundPath: string; uploadedBackgroundVideoPath?: string },
): string | undefined => {
  if (spec.bgType !== 'video') return undefined;
  if (spec.backgroundSource === 'self') return paths.foregroundPath;
  return paths.uploadedBackgroundVideoPath;
};
