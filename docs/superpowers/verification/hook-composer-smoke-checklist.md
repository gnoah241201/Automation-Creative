# Hook Composer real-media smoke checklist

Run this checklist from the repository root with the bundled FFmpeg/ffprobe binaries. Store generated fixtures only below `temp_superpowers/native-renders`, and remove the smoke directory after collecting evidence. Do not mark an interactive item complete unless it was observed in the app.

## Required checks

- [ ] Import one 9:16 original with audio, one hook with audio, and one hook without audio.
- [ ] Import one 16:9 source, crop it to 9:16, reload, and confirm crop persistence.
- [x] Verify duration groups at 3.000s/3.090s together and 3.180s separately.
- [x] Preview insertion at 0, middle, and exact original end.
- [x] Confirm trim handles cannot remove any part of the longest hook.
- [ ] Render an exact 360x640 preview and compare its segment order to browser preview.
- [x] Render a 2x2 matrix; verify four unique `<original>__<hook>.mp4` outputs.
- [x] Confirm every output is 1080x1920, 30 FPS, H.264/yuv420p, AAC stereo 48 kHz.
- [x] Trim an original and hook; verify removed leading tones are absent while distinct kept tones remain in preview and final output.
- [x] Verify effective hook durations rebuild groups and exact-second Apply clamps a short original at its end.
- [x] Apply one configuration to a full 2x2 matrix; confirm all four canonical configurations are reviewed.
- [x] Confirm original audio → hook audio/silence → original audio ordering.
- [x] Force one output failure, retry it, and confirm successful siblings remain downloadable.
- [x] Select multiple Local Library outputs and submit them through Resize without browser byte upload.
- [x] Stream four selected Local Library outputs as one ZIP; verify four unique non-empty archive entries and no persisted ZIP.
- [x] Verify pending-token expiry and an active streaming hold, then release it and remove all outputs after 24 hours.
- [x] Advance retention time past 24 hours; confirm held files remain and released files are cleaned.

## Interactive extension checks

- [ ] Open **Edit source** and operate both trim handles with pointer and keyboard; confirm In/Out values and playback stay aligned.
- [ ] Change a trim, try to close the drawer, and confirm dirty-close cancellation preserves the unsaved edit.
- [ ] Switch between **Trim segment** and **Crop 9:16** without losing unsaved state; save a crop and confirm it persists after reload.
- [ ] At a narrow viewport, confirm source editing becomes a near-full-screen bottom sheet with video above its controls.
- [ ] Open Apply for row, column, and both scopes; confirm the target count, clamped-target warning, and **Apply & mark reviewed** copy.
- [ ] Create a stale draft from a second page, receive a safe `409`, and confirm the page reload/retry orchestration does not partially Apply.
- [ ] Select/Clear Local Library outputs, prepare the selected ZIP, and confirm a real browser download contains only the selection.

## Evidence commands

```powershell
node --import tsx --test test/composer-real-media-smoke.test.ts
node --import tsx --test test/composer-timeline.test.ts test/composer-timeline-geometry.test.ts
node --import tsx --test test/composer-batch-render.test.ts test/library-resize-handoff.test.ts test/composer-retention-integration.test.ts
node --import tsx --test test/composer-workflow-extensions.test.ts
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

The real-media test creates short generated videos, renders start/middle/end insertion and a 2x2 final matrix through the production command builder, probes the resulting streams, checks visual/audio segment order and kept/removed tone frequencies, and cleans its temporary directory. The integrated extension test runs trim and full-matrix Apply through production routes, submits final renderer jobs, streams selected ZIP bytes, verifies pending/streaming holds and 24-hour cleanup, and removes its managed fixture in `finally`.

## Interactive verification still required

The first two import/crop checks, exact-preview comparison, and every item under **Interactive extension checks** require observing the browser workflow. Leave those boxes unchecked when the in-app browser harness is unavailable; SSR, component, route, and service tests are not substitutes for visual or page-orchestration confirmation.

## Final hardening evidence (2026-07-14)

- Automated component coverage verifies that the crop editor renders uploaded MP4 media with a real `<video>` element while keeping the accessible crop overlay.
- Automated restore coverage verifies persisted batch lookup, restored asset crop metadata, stale draft removal, safe local identifier persistence, and the visible restore affordance.
- Route regressions verify that upload probing, exact-preview creation, Resize job status/debug responses, and trim submission do not expose managed paths or FFmpeg diagnostics.
- The full test command now includes both `.test.ts` and `.test.tsx` files and runs serially to avoid Windows file-rename contention in storage tests.
- Reload coverage restores active batch jobs before exposing the review flow; server coverage proves duplicate and concurrent batch submissions are rejected atomically with a safe conflict response.
- Retry-lineage coverage proves only the latest unresolved failed attempt per original/hook cell can be retried, while historical cards lose their Retry action and distinct cells remain independent.

The in-app browser harness remained unavailable during final hardening. No browser-only checkbox above was changed.
