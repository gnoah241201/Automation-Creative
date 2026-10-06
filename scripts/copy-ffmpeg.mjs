// Copies the ffmpeg binary out of node_modules to the name Tauri expects for a
// sidecar: `<name>-<target triple>.exe`, here binaries/ffmpeg + the Windows triple.
//
// Why this exists: src-tauri/.gitignore ignores /binaries (64 MB does not belong
// in git), but tauri.conf.json declares `externalBin: ["binaries/ffmpeg"]`. On a
// fresh clone tauri-build therefore fails, and its message does not say which
// file is missing. This script recreates the file from the package that already
// ships it, and runs before both `app:dev` and `app:build`.
//
// It runs before EVERY dev start, so it must be cheap when there is nothing to do:
// an existing destination of the same size is left alone.

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@ffmpeg-installer/ffmpeg';
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'src-tauri', 'binaries', `ffmpeg-${TARGET_TRIPLE}.exe`);

const fail = (reason) => {
  console.error(`copy-ffmpeg: ${reason}`);
  console.error(`  package:     ${PACKAGE}`);
  console.error(`  destination: ${destination}`);
  process.exit(1);
};

// The app is built for one target. Copying a Linux or macOS binary to an .exe
// name would produce an installer that fails on the first render.
if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail(`this app is built for ${TARGET_TRIPLE}; this host is ${process.platform}/${process.arch}, so the package would supply the wrong binary.`);
}

let source;
try {
  source = createRequire(import.meta.url)(PACKAGE).path;
} catch (error) {
  fail(`could not load ${PACKAGE} (${error instanceof Error ? error.message : error}). Run "npm install" first.`);
}

if (typeof source !== 'string' || !existsSync(source)) {
  fail(`${PACKAGE} loaded but its binary is missing at ${source}. Run "npm install" again; its optional platform package may not have been installed.`);
}

const sourceSize = statSync(source).size;

if (existsSync(destination) && statSync(destination).size === sourceSize) {
  console.log(`copy-ffmpeg: up to date (${(sourceSize / 1048576).toFixed(1)} MB), skipping copy`);
  process.exit(0);
}

mkdirSync(path.dirname(destination), { recursive: true });
// Copy beside the destination and rename, so an interrupted copy never leaves a
// truncated file under the real name.
const partial = `${destination}.part`;
try {
  copyFileSync(source, partial);
  renameSync(partial, destination);
} catch (error) {
  rmSync(partial, { force: true });
  fail(`copy failed: ${error instanceof Error ? error.message : error}`);
}

console.log(`copy-ffmpeg: copied ${(sourceSize / 1048576).toFixed(1)} MB to ${path.relative(root, destination)}`);
