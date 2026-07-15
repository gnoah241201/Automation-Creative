import { ComposerAsset } from '../../shared/composer-contract.ts';

export type ComposerSourceChange =
  | { type: 'upsert'; asset: ComposerAsset }
  | { type: 'replace'; asset: ComposerAsset }
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
  if (change.type === 'upsert' || change.type === 'replace') {
    const index = current.findIndex((asset) => asset.id === change.asset.id);
    if (index < 0 && change.type === 'upsert') assets = [...current, change.asset];
    else if (index >= 0 && current[index] !== change.asset) {
      assets = current.map((asset, assetIndex) => assetIndex === index ? change.asset : asset);
    }
  } else if (current.some((asset) => asset.id === change.assetId)) {
    assets = current.filter((asset) => asset.id !== change.assetId);
  }

  return { assets, invalidateBatch: hasBatch && assets !== current };
};
