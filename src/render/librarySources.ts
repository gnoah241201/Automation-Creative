export interface ResizeBatchSource {
  localId: string;
  libraryId?: string;
  uploadId?: string;
  filename: string;
  duration: number;
  gameName: string;
  version: string;
  suffix: string;
  pendingOutputIds?: string[];
  completedPrimaryJobIds?: Record<string, string>;
}
