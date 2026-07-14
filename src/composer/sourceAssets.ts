import { ComposerAsset } from '../../shared/composer-contract.ts';

export type ComposerSourceChange =
  | { type: 'upsert'; asset: ComposerAsset }
  | { type: 'remove'; assetId: string };

export interface ComposerSourceChangeResult {
  assets: ComposerAsset[];
  invalidateBatch: boolean;
}

export const reduceComposerSourceAssets = (
  current: ComposerAsset[],
  change: ComposerSourceChange,
  hasBatch: boolean,
): ComposerSourceChangeResult => {
  let assets = current;
  if (change.type === 'upsert') {
    const index = current.findIndex((asset) => asset.id === change.asset.id);
    if (index < 0) assets = [...current, change.asset];
    else if (current[index] !== change.asset) {
      assets = current.map((asset, assetIndex) => assetIndex === index ? change.asset : asset);
    }
  } else if (current.some((asset) => asset.id === change.assetId)) {
    assets = current.filter((asset) => asset.id !== change.assetId);
  }

  return { assets, invalidateBatch: hasBatch && assets !== current };
};
