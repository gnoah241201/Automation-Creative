export interface NamingMeta {
  gameName: string;
  version: string;
  suffix: string;
}

export const parseVideoNamingMeta = (filename: string): Partial<NamingMeta> => {
  // Logic: Split by common separators and try to identify pieces
  // Example: HeroWars_v1_Android.mp4 -> {gameName: 'HeroWars', version: 'v1', suffix: 'Android'}
  const nameWithoutExt = filename.split('.').slice(0, -1).join('.');
  const parts = nameWithoutExt.split(/[_-]/);

  const result: Partial<NamingMeta> = {};

  if (parts.length > 0) result.gameName = parts[0];
  if (parts.length > 1) {
    // Check if second part looks like a version (starts with v)
    if (parts[1].toLowerCase().startsWith('v')) {
      result.version = parts[1];
      if (parts.length > 2) result.suffix = parts.slice(2).join('_');
    } else {
      result.suffix = parts.slice(1).join('_');
    }
  }

  return result;
};

export const buildOutputFilename = (meta: NamingMeta, ratio: string, duration?: number): string => {
  const ratioStr = ratio.replace(':', 'x');
  const durationStr = duration ? `_${Math.round(duration)}s` : '';
  const nameParts = [meta.gameName, meta.version].filter(Boolean);
  const sizePart = `${ratioStr}${durationStr}`;
  const suffixPart = meta.suffix ? `_${meta.suffix}` : '';
  return `${nameParts.join('_')}_${sizePart}${suffixPart}.mp4`;
};
