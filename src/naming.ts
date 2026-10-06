/** Re-export so callers outside `src/core` keep a short import path. The implementation is in `./core/naming`. */
export type { NamingMeta } from './core/naming';
export { buildOutputFilename, parseVideoNamingMeta } from './core/naming';
