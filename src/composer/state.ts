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
  draftRevision?: number;
  assetRevisions: Record<string, number>;
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
  assetRevisions: {},
  durationGroups: [],
  configurations: {},
  selectedCellIds: [],
};

export type ComposerAction =
  | { type: 'assetsLoaded'; originals: ComposerAsset[]; hooks: ComposerAsset[] }
  | { type: 'batchCreated'; batch: ComposerBatchDraft }
  | { type: 'draftReplaced'; draft: ComposerBatchDraft }
  | { type: 'selectVariant'; originalId: string; durationGroupId: string }
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
        draftRevision: undefined,
        assetRevisions: {},
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
        draftRevision: action.batch.revision,
        assetRevisions: { ...action.batch.assetRevisions },
        stage: 'edit',
        originals,
        hooks,
        durationGroups,
        configurations: { ...action.batch.configurations },
        activeVariant: undefined,
        selectedCellIds: [],
      };
    }
    case 'draftReplaced': {
      const groups = new Map(action.draft.durationGroups.map((group) => [group.id, group]));
      const configurationsAreCanonical = Object.entries(action.draft.configurations).every(([id, configuration]) => {
        const group = groups.get(configuration.durationGroupId);
        return id === configuration.id
          && id === `${configuration.originalId}:${configuration.durationGroupId}`
          && action.draft.originalIds.includes(configuration.originalId)
          && state.originals.some((original) => original.id === configuration.originalId)
          && action.draft.hookIds.includes(configuration.representativeHookId)
          && Boolean(group?.hookIds.includes(configuration.representativeHookId))
          && state.hooks.some((hook) => hook.id === configuration.representativeHookId);
      });
      const assetRevisionsAreValid = [...action.draft.originalIds, ...action.draft.hookIds]
        .every((id) => Number.isSafeInteger(action.draft.assetRevisions[id]) && action.draft.assetRevisions[id] > 0);
      if (
        state.batchId !== action.draft.id
        || (state.draftRevision !== undefined && action.draft.revision < state.draftRevision)
        || !configurationsAreCanonical
        || !assetRevisionsAreValid
      ) return state;
      return {
        ...state,
        draftRevision: action.draft.revision,
        assetRevisions: { ...action.draft.assetRevisions },
        durationGroups: action.draft.durationGroups.map((group) => ({ ...group, hookIds: [...group.hookIds] })),
        configurations: { ...action.draft.configurations },
      };
    }
    case 'selectVariant': {
      const hasOriginal = state.originals.some((original) => original.id === action.originalId);
      const hasGroup = state.durationGroups.some((group) => group.id === action.durationGroupId);
      return hasOriginal && hasGroup
        ? { ...state, activeVariant: { originalId: action.originalId, durationGroupId: action.durationGroupId } }
        : state;
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
