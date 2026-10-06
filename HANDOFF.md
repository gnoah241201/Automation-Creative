# Resize Video: handoff

Read [README.md](README.md) first for what the app does, how to run and build it, where
output lands and the two length modes. This file is what you need on top of that to
own the code.

## Snapshot

- A Windows x64 desktop app: Tauri 2 shell (Rust) + React/Vite webview + a bundled ffmpeg.
- App version `2.0.0` (`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`). `package.json`
  still says `1.1.5` and is not used for anything the installer shows.
- Tests at this commit: 352 TypeScript (`npm test`), 55 Rust (`cargo test`). `tsc --noEmit` is clean.
- There is no server. This repo used to be an Express + Vite web service with a Hook
  Composer and a Local Library tab; all of that has been deleted. It is not maintained.
  If you need it, it is in git history (the design note
  `docs/superpowers/specs/2026-10-06-desktop-app-tauri-design.md` names `028feaa` as the last
  web build); read the HANDOFF.md at that commit before doing anything with it.

## Toolchain you need to build

| Need | Notes |
|---|---|
| Node.js 22+ | Developed on 26. `npm test` relies on `node --test` globbing and `tsx`. |
| Rust, stable, **MSVC** toolchain | `rustup default stable-x86_64-pc-windows-msvc`. Developed on 1.99. The GNU toolchain is not supported. |
| Visual Studio Build Tools | The "Desktop development with C++" workload (MSVC compiler and linker). |
| **A Windows 10/11 SDK** | Part of the same installer, but it is a separate component and easy to miss. |
| WebView2 runtime | Already on Windows 11 and on any Windows 10 with a current Edge. |

**The missing-SDK error is misleading.** Without a Windows SDK, `cargo build` fails with
`linker 'link.exe' not found`, which reads as "MSVC is not installed" even when it is. If you
see that error, check the SDK before reinstalling anything:

```
dir "C:/Program Files (x86)/Windows Kits/10/Lib"
```

There should be a version folder (for example `10.0.22621.0`) containing `um/x64/kernel32.lib`.
If it is empty or missing, open the Visual Studio Installer, *Modify*, *Individual components*,
and tick a Windows 10 or 11 SDK. If the installer exits immediately with an "update available"
status, let it update itself first and then retry; `--quiet` and `--passive` installs must be
started from an elevated shell.

## The ffmpeg sidecar

All rendering is done by an ffmpeg binary that Tauri bundles next to the app and starts as
a *sidecar*. `src-tauri/tauri.conf.json` declares it as `externalBin: ["binaries/ffmpeg"]`, and
Tauri expects the file to be named with the Rust target triple:

```
src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe
```

**That file is not in git.** `src-tauri/.gitignore` ignores `/binaries` because it is 64 MB.
It comes from the `@ffmpeg-installer/ffmpeg` npm package, which is why that package is a
dependency even though no JavaScript imports it at runtime.

`scripts/copy-ffmpeg.mjs` does the copy. It runs automatically before both `npm run app:dev`
and `npm run app:build` (via `npm run prepare:ffmpeg`, which you can also run yourself). It:

- copies the binary out of `node_modules`, through a `.part` file and a rename;
- **skips the copy when the destination already exists with the same size**, so a dev start
  costs a `stat` and not 64 MB of I/O;
- fails with a message naming the package and the destination if the package is missing
  ("Run npm install first"), because without it `tauri-build` dies with an error that does not
  say which file is absent;
- refuses to run on anything other than Windows x64, since the package would hand it the wrong binary.

Things to know about the binary itself:

- It is `ffmpeg N-92722` **built in 2018**, and a GPLv3 build (`--enable-gpl --enable-libx264`
  and many others). It has no security updates. Distributing the installer
  brings the GPL obligations with it (see Open items: the installer does not carry the
  licence text or a source offer). Moving to a newer build means replacing what the
  script copies; do that in the script, not by dropping a file in `binaries/`, because a file
  of a different size at that path is overwritten.
- There is **no ffprobe**. Codec, container, duration and picture size are read from the banner
  that `ffmpeg -i` prints (`src-tauri/src/probe.rs`).
- The script's size check is not a hash. A same-size but different file would be kept.

## Unsigned installer and SmartScreen

`npm run app:build` produces an NSIS installer that is **not code-signed**. The first time it
runs on a machine, Windows SmartScreen shows "Windows protected your PC". Tell people to choose
*More info*, then *Run anyway*. The warning does not mean the file is damaged; it means there is
no signature and no download reputation. Removing it needs a code-signing certificate and a
`bundle.windows` signing configuration, neither of which exists here.

## How the code is laid out

The rule: **the webview decides, Rust touches the machine.** All business logic is plain
TypeScript functions that return data and are tested with `node:test`; the Rust side has no
business logic.

- `src/core/`: pure logic. `outputDerivation.ts` (which outputs a source can fill, in each
  mode), `renderPlan.ts` (ticks to an ordered job list, plus retry planning), `renderQueue.ts`
  (runs a plan with a concurrency limit and parent-before-child ordering), `buildCommand.ts`
  (ffmpeg argument arrays), `naming*`, `batchSources.ts`, `batchOriginals.ts`, `originalCopy.ts`,
  `outputCollision.ts`, `settings.ts`.
- `src/render/`: glue between the plan and the bridge. `runBatch.ts` builds each job's ffmpeg
  arguments and runs the queue; `copyOriginals.ts` handles the originals.
- `src/ui/`: the single-column React screen (`App.tsx` is the large one).
- `src/bridge/tauri.ts`: the only file that talks to Tauri. Everything else gets a `Bridge`
  object that tests replace with `setBridge`, which is how the whole suite runs under plain Node.
- `src-tauri/src/`: `commands.rs` (run/cancel ffmpeg, list and copy files, probe, check the output
  folder, write overlay PNGs), `process.rs` (the registry of running ffmpeg children, kill on
  close, priority lowering), `probe.rs` (parses `ffmpeg -i` output), `main.rs`.
- `docs/superpowers/specs/` and `plans/`: the design and the plan for this conversion, and older
  plans for features that still exist (output rules, render concurrency). The design doc's file tree
  (and the plan) predate the final structure: for example they still list `validation.ts` and
  `submitBatch.ts`, which no longer exist. Treat the tree there as intent, not as current.

## Behaviour that is easy to break

- **Nothing is ticked by default.** Render stays disabled until something is ticked. This was
  a deliberate decision: ticking every ratio for a 20-video batch means 100 composites.
- **Output names must not collide.** Two sources with the same game, version and suffix would
  render to the same filename. `validateBatchNaming` refuses that, and `findCollisions` /
  `dropColliding` guard against overwriting files already in the folder. They are the only
  guards; the planner does not check.
- **Naming is locked once the user edits a field**, and the version's trailing number counts up
  per video (`v60`, `v61`, `v62`; padding is kept). A version with no trailing number cannot be
  counted and the run is refused rather than writing several videos to one name.
- **Partial files.** Rust writes `<name>.mp4.part` and renames on exit code 0 (see the README).
  A cancelled render therefore leaves nothing under a real name.
- **Cancel is not failure.** `cancel_job` marks the run as cancelled so ffmpeg's non-zero exit is
  reported as a cancel; the UI shows it grey and a retry treats it as unfinished work.
- **Retry** runs only failed and skipped jobs, from the original plan, and does not re-run a
  finished parent whose file is still on disk. It does not go through the overwrite prompt,
  because the file it replaces is the broken one.
- **Threads.** Each job is capped to `(cores - 1) / concurrency` ffmpeg threads and runs at below-normal
  priority. The default concurrency is `(cores - 1) / 2`, rounded down and clamped to between 1 and 16 jobs
  (`src/core/settings.ts`), so a run uses most of the machine. The
  web version used to leave half free; this one does not.
- **Settings** are in the webview's `localStorage` under `resize.settings`, and the naming config
  under `resize-video:naming-config:v1`. They are per-user, not in the repo.
- **Closing the window** kills every ffmpeg child it started.

## Known limitations

State these to users rather than finding out later.

- **Windows x64 only.** The sidecar name and the installer target are fixed to it.
- **Not verified on a clean machine.** At this commit the NSIS installer has not been built and
  run on a PC without Node, Rust and the SDK. In particular, how the installer behaves on a
  Windows 10 machine without WebView2 is untested.
- **HEVC sources cannot be previewed** on a machine without the Windows HEVC video extension,
  because the webview cannot decode them. Their duration and size are still read through ffmpeg
  and they render correctly; only the preview is blank.
- **The audio codec of an original is never checked.** An h264 mp4 carrying AMR or PCM audio is
  copied as is and may not play on another machine. A source that is h264 in a `mov` or `3gp`
  container is also copied under a `.mp4` name; that was judged acceptable, since they share the
  same structure.
- **Pixel aspect ratio is not applied** when ffmpeg, not the webview, has to supply a file's picture
  size (HEVC and other files the webview cannot read). An anamorphic source of that kind could be
  classified by its stored size rather than its displayed one.
- **A hard kill leaves ffmpeg running.** Ending the app from Task Manager does not close the
  child processes and leaves a `.part` file. Closing the window normally does.
- **Cut mode lengths are approximate.** A stream copy lands on a keyframe, so a cut can be up to
  one keyframe interval off its nominal length. Speed mode re-encodes and is exact.
- **`copy_file` overwrites silently** when called directly; the overwrite prompt is the guard,
  and it covers the originals as well as the renders.
- **Some leftovers.** A source whose picture size could not be read has no ratio and is kept out of
  the plan, but `batchOutputs.ts`, `renderPlan.ts`, `runBatch.ts`, `ui/overlays.ts`, `PreviewBox.tsx`
  and `ui/App.tsx` still say `?? '9:16'` as a fallback, which would mislabel such a source if the
  filter were ever bypassed; `src/core/sourceNormalize.ts` imports `node:path`, which makes Vite print an
  externalisation warning at build (harmless, the desktop app never calls the function that
  needs it); `src/core/librarySources.ts` keeps its name from the Local Library days though it
  only defines the batch-source type.

## Verifying a change

```bash
npm run lint                  # tsc --noEmit
npm test                      # 352 tests
npm run prepare:ffmpeg        # needed before any cargo build / cargo test on a fresh clone
cd src-tauri && cargo build   # must stay warning-free
cd src-tauri && cargo test    # 55 tests
npm run app:dev               # the window opens and the page renders
```

Any direct `cargo` or `tauri` call bypasses the npm scripts, so the sidecar file
`src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` must already exist. On a fresh clone it
does not, and `tauri-build` fails without saying which file is missing; run
`npm run prepare:ffmpeg` first (it needs `npm install` to have run).

`test/output-derivation.test.ts` is the executable spec for output lengths, and
`test/render-plan.test.ts` and `test/run-batch.test.ts` cover the planner and the ffmpeg arguments.
`test/speed-up-real-media-smoke.test.ts` runs the bundled ffmpeg for real, so it needs
`node_modules/@ffmpeg-installer` to be installed.

## Open items

1. Build the installer on a clean Windows machine and record what happens (WebView2, SmartScreen).
2. Decide on code signing, or accept the SmartScreen warning as the cost of an internal tool.
3. **Settle the ffmpeg licence before distributing the installer.** The bundled ffmpeg is a GPLv3
   build. Shipping it requires including the licence text and offering the corresponding source;
   the installer bundles neither today. Replacing the 2018 build with a newer GPL build does not remove that obligation.
4. Pick one source of truth for the version number. `Cargo.toml` and `tauri.conf.json` are both
   `2.0.0`; only `package.json` (`1.1.5`) disagrees, and the installer takes its version from
   `tauri.conf.json`.
5. Pin `@tauri-apps/api` exactly; it is a caret range and the whole test suite depends on it not
   touching `window` at import time.
