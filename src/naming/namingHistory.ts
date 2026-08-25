import { NamingMeta } from '../../shared/render-contract';
import { NamingStorage } from './namingConfig';

/**
 * Remembers which game/version/suffix combinations have already been rendered.
 *
 * Reusing one produces the same output filenames as a previous run, which
 * silently overwrites the earlier download. Worth a warning, not a refusal —
 * re-rendering a version on purpose is legitimate.
 */

export const NAMING_HISTORY_STORAGE_KEY = 'resize-video:naming-history:v1';
export const NAMING_HISTORY_LIMIT = 500;

/**
 * Two namings share a key exactly when they would produce the same filenames.
 * Output names are compared case-insensitively because the filesystems these
 * land on are. Fields are length-prefixed so a separator inside one cannot
 * imitate a different split.
 */
export const namingKey = (meta: NamingMeta): string => [meta.gameName, meta.version, meta.suffix]
  .map((part) => (part ?? '').toLocaleLowerCase('en-US'))
  .map((part) => `${part.length}:${part}`)
  .join('|');

export const loadNamingHistory = (storage: NamingStorage): string[] => {
  let raw: string | null = null;
  try {
    raw = storage.getItem(NAMING_HISTORY_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

/** Appends the namings just used, newest last, capped at the limit. */
export const rememberNaming = (storage: NamingStorage, metas: NamingMeta[]): string[] => {
  const merged = [...loadNamingHistory(storage)];
  for (const meta of metas) {
    const key = namingKey(meta);
    const existing = merged.indexOf(key);
    if (existing >= 0) merged.splice(existing, 1);
    merged.push(key);
  }
  const capped = merged.slice(-NAMING_HISTORY_LIMIT);
  try {
    storage.setItem(NAMING_HISTORY_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // History is a convenience; failing to persist it must not block a render.
  }
  return capped;
};

/** The namings in this run that a previous run already produced. */
export const findAlreadyUsed = (history: string[], metas: NamingMeta[]): NamingMeta[] => {
  const known = new Set(history);
  const reported = new Set<string>();
  return metas.filter((meta) => {
    const key = namingKey(meta);
    if (!known.has(key) || reported.has(key)) return false;
    reported.add(key);
    return true;
  });
};
