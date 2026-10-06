import { InputRatio } from './contract.ts';

export interface ResizeBatchSource {
  localId: string;
  /** Absolute path on disk. The file is read where it sits; nothing is copied. */
  path: string;
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
