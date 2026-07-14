# Task 13 report — operational verification

## Outcome

- Added idempotent Prometheus metric registration and bounded Hook Composer labels for created/completed jobs, preview cache results, and retained library bytes.
- Added one testable cleanup coordinator covering queue jobs, drafts, exact previews, unreferenced assets, final library outputs, and orphan job directories.
- The five-minute coordinator timer is unreferenced and coalesces overlapping triggers. It protects active Resize holds, active queue work directories, in-flight exact previews, and source assets referenced by live drafts.
- Documented Hook Composer storage, retention, concurrency, metrics, and release verification.
- Added a repeatable real-FFmpeg smoke test using generated media under managed temporary storage. The test always removes its fixture directory.
- Real-media RED exposed a bundled FFmpeg compatibility defect: a bare `-autorotate` consumed the following `-i`. The command builder now emits `-autorotate 1` for both inputs.

## TDD evidence

1. `node --import tsx --test test/composer-retention-integration.test.ts`
   - RED: `runCleanupCycle` was `undefined`.
   - GREEN: exposed deterministic clock-driven queue cleanup.
2. Same focused test after adding metric expectations.
   - RED: `A metric with the name resize_video_jobs_created_total has already been registered.`
   - GREEN: all existing and composer metrics use get-or-create registration.
3. Same focused test after adding in-flight preview protection.
   - RED: `an in-flight exact preview is retained` (`false !== true`).
   - GREEN: active preview job IDs protect expired preview directories until terminal.
4. `node --import tsx --test test/composer-real-media-smoke.test.ts`
   - RED: FFmpeg reported `Invalid file index 0` because `-autorotate` consumed `-i`.
   - GREEN: explicit `-autorotate 1`; generated media rendered and probed successfully.

## Fresh final verification

Run from `D:\Videcode\ResizeVideo1\.worktrees\hook-composer` on 2026-07-14:

- `npm.cmd test`
  - PASS: 175 tests, 0 failed, 0 skipped, exit 0 after review fixes.
  - Includes the generated real-media test (about 3.3 seconds in the final run).
- `npm.cmd run lint`
  - PASS: TypeScript `tsc --noEmit`, exit 0.
- `npm.cmd run build`
  - PASS: Vite production build, 1704 modules transformed, exit 0.
- `git diff --check`
  - PASS: exit 0. Git printed only the repository's LF-to-CRLF checkout warnings.
- Managed fixture check
  - PASS: no `temp_superpowers/native-renders/composer-smoke-*` directory remained.
- Background process check
  - No backend/frontend server was started by this task; no task-owned background process remains.

## Real-media evidence

`test/composer-real-media-smoke.test.ts` generated two vertical originals with audio, one vertical hook with audio, one vertical hook without audio, and one 16:9 source. It used the production command builder and bundled binaries to verify:

- start, middle, and exact-end insertion at 360x640;
- segment order by decoded RGB frame sampling;
- a normalized 16:9-to-9:16 crop through the production filter graph;
- four unique 2x2 matrix filenames;
- every final output is 1080x1920, 30 FPS, H.264/yuv420p, AAC stereo 48 kHz;
- missing hook audio becomes bounded silence, with original audio before and after, using decoded PCM RMS samples;
- generated files are removed in `finally`.

Focused service tests additionally verify exact duration grouping and trim containment, failed-cell retry without losing siblings, Local Library-to-Resize trusted handoff without browser byte upload, and 24-hour hold/release cleanup with persisted state removal.

## Checklist status and limitation

Verified items are checked in `docs/superpowers/verification/hook-composer-smoke-checklist.md` with their evidence commands. Three interactive observations remain deliberately unchecked:

- importing the generated audio/no-audio files through the browser UI;
- cropping a 16:9 source in the UI, reloading, and observing persisted crop state;
- comparing exact preview segment order side-by-side with the browser preview.

The in-app browser harness is unavailable in this session (`Cannot redefine property: process`, including after reset). Service-level and FFmpeg checks were not represented as visual browser verification.

## Review fixes

Two independent review findings were reproduced with failing tests before implementation:

1. A completed exact preview reused at hour 23 and extended to hour 47 was deleted by queue retention at hour 24. The cleanup coordinator now reads preview metadata before queue cleanup and passes a bounded set of protected preview job IDs through the queue to file cleanup. The regression uses `ComposerPreviewService` to perform the real cross-batch cache reuse, confirms the file and queue record survive hour 24, then confirms both are removed after hour 47.
2. Direct queued-to-cancelled composer jobs did not increment cancellation metrics. The queued branch now increments both the global cancelled counter and `resize_video_composer_jobs_completed_total{status="cancelled"}` after its terminal state is persisted. A regression cancels queued and running composer jobs twice each and verifies exactly one increment per job.

Fresh post-review verification: focused tests PASS (14/14), full suite PASS (174/174), lint PASS, production build PASS, and `git diff --check` PASS. The full suite includes the real-media smoke test, which remains green.

A final preview-lifecycle review found that a completed preview whose metadata had already expired could still be returned as a cache hit and have its lifetime extended. A RED regression created the completed output, advanced the clock exactly to expiry, and requested the same preview from a second batch; the stale job was incorrectly reused. Completed reuse is now gated by `record.expiresAt > now`. Expired terminal preview storage is removed before a fresh attempt and fresh metadata are written, while active expired attempts retain the existing replacement behavior. The valid pre-expiry cross-batch test remains green with a corrected still-live fixture.

Fresh verification after this final fix: preview/retention/queue focused tests PASS (24/24), full suite PASS (175/175), lint PASS, production build PASS, real-media smoke PASS as part of the suite, and `git diff --check` PASS.
