import {
  ComposerAsset,
  ComposerBatchDraft,
  ComposerVariantConfig,
  HookDurationGroup,
} from '../../shared/composer-contract.ts';
import { groupHooksByDuration } from '../../shared/composerTimeline.ts';

export type ComposerStage = 'sources' | 'edit' | 'review';
export type ComposerTool = 'insert' | 'trim' | 'crop';

export interface ComposerState {
  stage: ComposerStage;
  tool: ComposerTool;
  batchId?: string;
  originals: ComposerAsset[];
  hooks: ComposerAsset[];
  durationGroups: HookDurationGroup[];
  configurations: Record<string, ComposerVariantConfig>;
  activeVariant?: { originalId: string; durationGroupId: string };
  selectedCellIds: string[];
}

export const initialComposerState: ComposerState = {
  stage: 'sources',
  tool: 'insert',
  originals: [],
  hooks: [],
  durationGroups: [],
  configurations: {},
  selectedCellIds: [],
};

export type ComposerAction =
  | { type: 'assetsLoaded'; originals: ComposerAsset[]; hooks: ComposerAsset[] }
  | { type: 'batchCreated'; batch: ComposerBatchDraft }
  | { type: 'selectVariant'; originalId: string; durationGroupId: string }
  | { type: 'configurationSaved'; batchId: string; configuration: ComposerVariantConfig }
  | { type: 'toggleCellSelection'; cellId: string }
  | { type: 'setCellSelection'; cellIds: string[] }
  | { type: 'setTool'; tool: ComposerTool }
  | { type: 'setStage'; stage: ComposerStage };

export const composerReducer = (state: ComposerState, action: ComposerAction): ComposerState => {
  switch (action.type) {
    case 'assetsLoaded':
      return {
        ...state,
        stage: 'sources',
        batchId: undefined,
        originals: [...action.originals],
        hooks: [...action.hooks],
        durationGroups: groupHooksByDuration(action.hooks),
        configurations: {},
        activeVariant: undefined,
        selectedCellIds: [],
      };
    case 'batchCreated': {
      const originalIds = new Set(action.batch.originalIds);
      const hookIds = new Set(action.batch.hookIds);
      const originals = state.originals.filter((original) => originalIds.has(original.id));
      const hooks = state.hooks.filter((hook) => hookIds.has(hook.id));
      const retainedHookIds = new Set(hooks.map((hook) => hook.id));
      const durationGroups = action.batch.durationGroups
        .map((group) => ({
          ...group,
          hookIds: group.hookIds.filter((hookId) => retainedHookIds.has(hookId)),
        }))
        .filter((group) => group.hookIds.length > 0);
      return {
        ...state,
        batchId: action.batch.id,
        stage: 'edit',
        originals,
        hooks,
        durationGroups,
        configurations: { ...action.batch.configurations },
        activeVariant: undefined,
        selectedCellIds: [],
      };
    }
    case 'selectVariant': {
      const hasOriginal = state.originals.some((original) => original.id === action.originalId);
      const hasGroup = state.durationGroups.some((group) => group.id === action.durationGroupId);
      return hasOriginal && hasGroup
        ? { ...state, activeVariant: { originalId: action.originalId, durationGroupId: action.durationGroupId } }
        : state;
    }
    case 'configurationSaved': {
      const configuration = action.configuration;
      const group = state.durationGroups.find((item) => item.id === configuration.durationGroupId);
      const isCurrentBatch = state.batchId === action.batchId;
      const hasOriginal = state.originals.some((original) => original.id === configuration.originalId);
      const hasRepresentative = Boolean(
        group?.hookIds.includes(configuration.representativeHookId)
        && state.hooks.some((hook) => hook.id === configuration.representativeHookId),
      );
      const hasCanonicalId = configuration.id === `${configuration.originalId}:${configuration.durationGroupId}`;
      if (!isCurrentBatch || !hasOriginal || !group || !hasRepresentative || !hasCanonicalId) return state;
      return {
        ...state,
        configurations: {
          ...state.configurations,
          [configuration.id]: configuration,
        },
      };
    }
    case 'toggleCellSelection':
      return {
        ...state,
        selectedCellIds: state.selectedCellIds.includes(action.cellId)
          ? state.selectedCellIds.filter((id) => id !== action.cellId)
          : [...state.selectedCellIds, action.cellId],
      };
    case 'setCellSelection':
      return { ...state, selectedCellIds: [...new Set(action.cellIds)].slice(0, 100) };
    case 'setTool':
      return { ...state, tool: action.tool };
    case 'setStage':
      return { ...state, stage: action.stage };
    default:
      return state;
  }
};

export const selectReviewProgress = (state: ComposerState) => {
  const configurations = Object.values(state.configurations);
  return {
    reviewed: configurations.filter((configuration) => configuration.reviewed).length,
    total: configurations.length,
  };
};
