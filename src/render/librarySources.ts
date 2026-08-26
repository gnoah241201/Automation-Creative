import { InputRatio } from '../../shared/render-contract.ts';

export interface ResizeBatchSource {
  localId: string;
  libraryId?: string;
  uploadId?: string;
  filename: string;
  duration: number;
  /** Omitted for library entries, which are always portrait composer outputs. */
  inputRatio?: InputRatio;
  gameName: string;
  version: string;
  suffix: string;
  pendingOutputIds?: string[];
  completedPrimaryJobIds?: Record<string, string>;
}
