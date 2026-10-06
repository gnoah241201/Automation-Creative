import { InputRatio } from './contract.ts';

export interface ResizeBatchSource {
  localId: string;
  /** Absolute path on disk. The file is read where it sits; nothing is copied. */
  path: string;
  filename: string;
  duration: number;
  /** Orientation of the picture as shown. Omitted means 9:16 wherever it is read. */
  inputRatio?: InputRatio;
  gameName: string;
  version: string;
  suffix: string;
}
