import { NamingMeta, parseVideoNamingMeta } from '../naming';
import { ResizeBatchSource } from '../render/librarySources';
import { sequenceVersions } from './versionSequence';

/**
 * Persisted output-naming configuration.
 *
 * Auto-detection from the filename is a convenience for the first upload only.
 * Once the user has set the naming themselves the config is `locked` and every
 * later upload uses it verbatim — re-detecting would silently rename outputs
 * from one video to the next and break the grouping downloads rely on.
 */
export interface NamingConfig extends NamingMeta {
  locked: boolean;
}

/** The slice of `localStorage` this module needs. */
export interface NamingStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export const NAMING_CONFIG_STORAGE_KEY = 'resize-video:naming-config:v1';

export const emptyNamingConfig = (): NamingConfig => ({
  gameName: '',
  version: '',
  suffix: '',
  locked: false,
});

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Reads the stored config. Storage access throws outright in some privacy
 * modes, and the stored payload is user-editable, so every failure degrades to
 * the empty config rather than breaking the page.
 */
export const loadNamingConfig = (storage: NamingStorage): NamingConfig => {
  let raw: string | null = null;
  try {
    raw = storage.getItem(NAMING_CONFIG_STORAGE_KEY);
  } catch {
    return emptyNamingConfig();
  }
  if (!raw) return emptyNamingConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyNamingConfig();
  }
  if (!parsed || typeof parsed !== 'object') return emptyNamingConfig();

  const record = parsed as Record<string, unknown>;
  return {
    gameName: asString(record.gameName),
    version: asString(record.version),
    suffix: asString(record.suffix),
    locked: record.locked === true,
  };
};

export const saveNamingConfig = (storage: NamingStorage, config: NamingConfig): void => {
  try {
    storage.setItem(NAMING_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // A config that cannot be persisted is still usable for this session.
  }
};

export const clearNamingConfig = (storage: NamingStorage): void => {
  try {
    storage.removeItem(NAMING_CONFIG_STORAGE_KEY);
  } catch {
    // Nothing to recover from — the caller resets its in-memory copy anyway.
  }
};

/**
 * Applies a user edit. Any edit locks the config, including one that clears a
 * field: a deliberately blank suffix is a decision, not an invitation to guess.
 */
export const lockNamingConfig = (
  config: NamingConfig,
  patch: Partial<NamingMeta>,
): NamingConfig => ({ ...config, ...patch, locked: true });

/**
 * The naming to use for a newly uploaded file.
 *
 * Locked: the config, verbatim. Unlocked: detect from the filename but never
 * overwrite a field the user has already filled in.
 */
export const resolveNamingMeta = (config: NamingConfig, filename: string): NamingMeta => {
  if (config.locked) {
    return { gameName: config.gameName, version: config.version, suffix: config.suffix };
  }
  const detected = parseVideoNamingMeta(filename);
  return {
    gameName: config.gameName || detected.gameName || '',
    version: config.version || detected.version || '',
    suffix: config.suffix || detected.suffix || '',
  };
};

/**
 * Batch sources arrive from the library carrying naming derived from their own
 * filenames. A locked config replaces it so every output of a run shares one
 * game/version/suffix; an unlocked config leaves them untouched.
 */
export const applyNamingConfigToSource = (
  config: NamingConfig,
  source: ResizeBatchSource,
): ResizeBatchSource => (config.locked
  ? { ...source, gameName: config.gameName, version: config.version, suffix: config.suffix }
  : source);

/**
 * Applies a locked config to a whole batch at the moment its sources enter.
 *
 * The version counts up per source: one shared version renders every video to
 * the same filename. Applied once on entry, never again at submit time — doing
 * it twice would renumber a retry differently from the run it is retrying.
 */
export const applyNamingConfigToBatch = (
  config: NamingConfig,
  sources: ResizeBatchSource[],
): ResizeBatchSource[] => {
  if (!config.locked) return sources;
  // Null when the version has no trailing number; left as configured so
  // `validateBatchNaming` can refuse the run with a specific message.
  const versions = sequenceVersions(config.version, sources.length);
  return sources.map((source, index) => ({
    ...source,
    gameName: config.gameName,
    version: versions?.[index] ?? config.version,
    suffix: config.suffix,
  }));
};
