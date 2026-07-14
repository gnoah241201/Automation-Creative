import { InputRatio } from '../../shared/render-contract.ts';
import { ResizeBatchSource } from './librarySources.ts';

export interface ResizeBatchState {
  revision: number;
  sources: ResizeBatchSource[];
}

export interface ResizeBatchSnapshot {
  revision: number;
  sources: ResizeBatchSource[];
}

export const createResizeBatchState = (): ResizeBatchState => ({ revision: 0, sources: [] });

export const canMutateBrowserForeground = (state: ResizeBatchState): boolean => state.sources.length === 0;

export const replaceResizeBatch = (
  state: ResizeBatchState,
  sources: ResizeBatchSource[],
): ResizeBatchState => ({ revision: state.revision + 1, sources: [...sources] });

export const removeResizeBatchSource = (
  state: ResizeBatchState,
  localId: string,
): ResizeBatchState => ({
  revision: state.revision + 1,
  sources: state.sources.filter((source) => source.localId !== localId),
});

export const clearResizeBatch = (state: ResizeBatchState): ResizeBatchState => ({
  revision: state.revision + 1,
  sources: [],
});

export const snapshotResizeBatch = (state: ResizeBatchState): ResizeBatchSnapshot => ({
  revision: state.revision,
  sources: [...state.sources],
});

export const applyResizeBatchResult = (
  state: ResizeBatchState,
  snapshot: ResizeBatchSnapshot,
  acceptedSourceIds: string[],
): ResizeBatchState => {
  if (state.revision !== snapshot.revision) return state;
  const accepted = new Set(acceptedSourceIds);
  return {
    revision: state.revision + 1,
    sources: state.sources.filter((source) => !accepted.has(source.libraryId ?? source.localId)),
  };
};

export const deriveResizeInput = (
  state: ResizeBatchState,
  browserInput: { inputRatio: InputRatio; duration?: number },
): { inputRatio: InputRatio; duration?: number } => state.sources.length === 0
  ? browserInput
  : {
      inputRatio: '9:16',
      duration: Math.max(...state.sources.map((source) => source.duration)),
    };
