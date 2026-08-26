import os from 'node:os';
import { execFile } from 'node:child_process';

/**
 * Pins FFmpeg to a subset of the machine's cores.
 *
 * FFmpeg's `-threads` caps are advisory: measured on a 12-core host, a render
 * capped at two threads still drew three and a half to four and a half cores,
 * and two concurrent renders held the machine at 85% average. Lowering the
 * priority fixed nothing either — it changes who yields, not how much is used.
 *
 * Processor affinity is the one limit the process cannot exceed. Pinned to six
 * of twelve cores, renders cannot take more than half the machine no matter how
 * many threads they spawn. Renders get proportionally slower; that is the trade
 * and it is the point.
 */

/** Fraction of the host renders may occupy when nothing is configured. */
const DEFAULT_SHARE_DIVISOR = 2;

const rawBudget = (): string => (process.env.FFMPEG_CPU_CORES ?? '').trim();

/** `FFMPEG_CPU_CORES=all` hands the whole machine back. */
export const isAffinityEnabled = (): boolean =>
  rawBudget().toLocaleLowerCase('en-US') !== 'all';

/**
 * How many cores renders may use in total — shared by every concurrent render,
 * so the ceiling holds however many are running.
 */
export const renderCoreBudget = (cpuCount = os.cpus().length): number => {
  const total = Math.max(1, Math.floor(cpuCount > 0 ? cpuCount : 1));
  const requested = Number(rawBudget());
  if (Number.isFinite(requested) && requested >= 1) {
    return Math.min(total, Math.floor(requested));
  }
  return Math.max(1, Math.floor(total / DEFAULT_SHARE_DIVISOR));
};

/**
 * Bit per core, counting from core 0. Kept inside the safe integer range: a
 * host wide enough to overflow it would need a different call anyway.
 */
export const affinityMask = (cores: number): number => {
  const usable = Math.min(48, Math.max(1, Math.floor(cores)));
  return 2 ** usable - 1;
};

/**
 * Applies the pin to a freshly spawned render. Best effort: a refusal leaves
 * the render running unpinned, which is better than not rendering at all.
 */
export const pinRenderToCores = (
  pid: number | undefined,
  run: (command: string, args: string[]) => void = defaultRunner,
): boolean => {
  if (pid === undefined || !isAffinityEnabled()) return false;
  const mask = affinityMask(renderCoreBudget());
  try {
    if (process.platform === 'win32') {
      run('powershell', [
        '-NoProfile', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessorAffinity = ${mask}`,
      ]);
    } else {
      run('taskset', ['-p', mask.toString(16), String(pid)]);
    }
    return true;
  } catch {
    return false;
  }
};

const defaultRunner = (command: string, args: string[]): void => {
  // Fire and forget: the render is already running, and a failed pin is not
  // worth blocking it or crashing the queue over.
  execFile(command, args, () => {});
};
