/**
 * Version numbering for a batch.
 *
 * Several videos rendered under one locked config would otherwise share a
 * version, and therefore produce byte-for-byte identical output filenames. The
 * version's trailing number is what tells them apart, so each video in a batch
 * takes the next one.
 */

export interface VersionParts {
  /** Everything before the trailing number, e.g. 'v' in 'v60' or 'ver' in 'ver61'. */
  prefix: string;
  number: number;
  /** Digit count as written, so 'v02' keeps its padding. */
  width: number;
}

const TRAILING_NUMBER = /^(.*?)(\d+)$/;

export const parseVersion = (version: string): VersionParts | null => {
  const match = TRAILING_NUMBER.exec(version);
  if (!match) return null;
  const [, prefix, digits] = match;
  return { prefix, number: Number(digits), width: digits.length };
};

const format = (parts: VersionParts, value: number): string =>
  `${parts.prefix}${String(value).padStart(parts.width, '0')}`;

/** Returns null when the version has no trailing number to move. */
export const incrementVersion = (version: string, by: number): string | null => {
  const parts = parseVersion(version);
  if (!parts) return null;
  return format(parts, parts.number + by);
};

/**
 * One version per video, counting up from the configured one.
 * Returns null when the version cannot be numbered — the caller must refuse to
 * render rather than fall back to duplicate names.
 */
export const sequenceVersions = (version: string, count: number): string[] | null => {
  if (count <= 0) return [];
  const parts = parseVersion(version);
  if (!parts) return null;
  return Array.from({ length: count }, (_, index) => format(parts, parts.number + index));
};
