import { namingKey } from '../naming/namingHistory';
import { parseVersion } from '../naming/versionSequence';
import { ResizeBatchSource } from './librarySources';

/**
 * Refuses a batch whose sources would render to the same filenames.
 *
 * Two sources sharing game/version/suffix produce byte-identical output names,
 * so the second silently replaces the first in the download and there is no way
 * to tell which video any file came from. Blocked before render rather than
 * discovered afterwards.
 */
export const validateBatchNaming = (sources: ResizeBatchSource[]): string[] => {
  const byKey = new Map<string, ResizeBatchSource[]>();
  for (const source of sources) {
    const key = namingKey(source);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(source);
    else byKey.set(key, [source]);
  }

  const errors: string[] = [];
  for (const clash of byKey.values()) {
    if (clash.length < 2) continue;
    const files = clash.map((source) => source.filename).join(', ');
    const { gameName, version, suffix } = clash[0];
    const naming = [gameName, version, suffix].filter(Boolean).join(' / ');
    errors.push(parseVersion(version)
      // The version cannot be counted up, so every video in the run keeps it.
      ? `Trùng tên xuất ra (${naming}): ${files}. Đổi tên game, version hoặc hậu tố cho khác nhau.`
      : `Version "${version}" không kết thúc bằng số nên không tự tăng cho từng video được (${files}). `
        + 'Đặt version dạng có số ở cuối, ví dụ v60 hoặc ver61.');
  }
  return errors;
};
