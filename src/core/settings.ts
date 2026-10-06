import { LengthMode } from './outputDerivation';

export interface Settings {
  lengthMode: LengthMode;
  outputFolder: string | null;
  concurrency: number;
  advancedOpen: boolean;
}

const KEY = 'resize.settings';
const MIN_JOBS = 1;
const MAX_JOBS = 16;

/**
 * Half of (cores - 1), rounded down, so a batch never takes the whole machine.
 *
 * Each job also caps its own ffmpeg threads. The web version taught this the
 * hard way: lowering the job count alone changed nothing, because the thread
 * cap divides the host by the job count and the product stayed put.
 */
export const defaultConcurrency = (cpuCount: number): number =>
  Math.min(MAX_JOBS, Math.max(MIN_JOBS, Math.floor((cpuCount - 1) / 2) || 1));

// The 3 is a deliberate static placeholder, not a missed call to
// defaultConcurrency: the Settings UI re-seeds it from the real core count on
// first run. Do not "fix" the apparent disagreement here.
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  lengthMode: 'speed',
  outputFolder: null,
  concurrency: 3,
  advancedOpen: false,
});

// Fallbacks return a copy so a caller mutating its Settings cannot corrupt the
// shared defaults for the rest of the session.
const defaults = (): Settings => ({ ...DEFAULT_SETTINGS });

const store = (given?: Storage): Storage | null => {
  if (given) return given;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const clampJobs = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.concurrency;
  return Math.min(MAX_JOBS, Math.max(MIN_JOBS, Math.round(value)));
};

/**
 * Never throws and never returns a half-valid object.
 *
 * A settings file is the one thing read before anything else works, so a
 * stray value in it has to degrade to the default rather than stop the app.
 */
export const readSettings = (storage?: Storage): Settings => {
  const target = store(storage);
  if (!target) return defaults();

  let raw: unknown;
  try {
    const text = target.getItem(KEY);
    if (!text) return defaults();
    raw = JSON.parse(text);
  } catch {
    return defaults();
  }
  if (typeof raw !== 'object' || raw === null) return defaults();

  const value = raw as Partial<Record<keyof Settings, unknown>>;
  return {
    lengthMode: value.lengthMode === 'cut' || value.lengthMode === 'speed'
      ? value.lengthMode
      : DEFAULT_SETTINGS.lengthMode,
    outputFolder: typeof value.outputFolder === 'string' ? value.outputFolder : null,
    concurrency: 'concurrency' in value ? clampJobs(value.concurrency) : DEFAULT_SETTINGS.concurrency,
    advancedOpen: value.advancedOpen === true,
  };
};

export const writeSettings = (next: Settings, storage?: Storage): void => {
  const target = store(storage);
  if (!target) return;
  try {
    target.setItem(KEY, JSON.stringify(next));
  } catch {
    // A locked-down profile can refuse writes. Losing a preference is not
    // worth failing a render over.
  }
};

const hasStoredConcurrency = (storage?: Storage): boolean => {
  const target = store(storage);
  if (!target) return false;
  try {
    const raw: unknown = JSON.parse(target.getItem(KEY) ?? 'null');
    return typeof raw === 'object' && raw !== null
      && typeof (raw as { concurrency?: unknown }).concurrency === 'number'
      && Number.isFinite((raw as { concurrency: number }).concurrency);
  } catch {
    return false;
  }
};

/**
 * What the app starts with: `readSettings`, except that a machine which has
 * never chosen a job count gets one worked out from its own cores.
 *
 * `DEFAULT_SETTINGS.concurrency` is a fixed 3, which is right for a 7-8 core
 * laptop and too few for a 16-core desktop. The seed is written back so the
 * number is stable across launches instead of being re-derived each time. A
 * stored number is never second-guessed, including a stored 3.
 */
export const loadSettings = (cpuCount: number, storage?: Storage): Settings => {
  const read = readSettings(storage);
  if (hasStoredConcurrency(storage)) return read;
  const seeded = { ...read, concurrency: defaultConcurrency(cpuCount) };
  writeSettings(seeded, storage);
  return seeded;
};
