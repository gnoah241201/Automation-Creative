/**
 * Client-side re-export. The implementation lives in `shared/` so the server
 * can name bundled files exactly the way the browser does, without reaching
 * into `src/`.
 */
export type { NamingMeta } from '../shared/naming';
export { buildOutputFilename, parseVideoNamingMeta } from '../shared/naming';
