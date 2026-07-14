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
- [x] Confirm original audio → hook audio/silence → original audio ordering.
- [x] Force one output failure, retry it, and confirm successful siblings remain downloadable.
- [x] Select multiple Local Library outputs and submit them through Resize without browser byte upload.
- [x] Advance retention time past 24 hours; confirm held files remain and released files are cleaned.

## Evidence commands

```powershell
node --import tsx --test test/composer-real-media-smoke.test.ts
node --import tsx --test test/composer-timeline.test.ts test/composer-timeline-geometry.test.ts
node --import tsx --test test/composer-batch-render.test.ts test/library-resize-handoff.test.ts test/composer-retention-integration.test.ts
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

The real-media test creates short generated videos, renders start/middle/end insertion and a 2x2 final matrix through the production command builder, probes the resulting streams, checks visual/audio segment order, and cleans its temporary directory. The duration, trim, retry, handoff, and retention entries are backed by the focused service tests listed above.

## Interactive verification still required

The first two import/crop checks require observing the browser workflow. The exact-preview comparison also requires comparing the rendered preview with the browser preview. Leave those boxes unchecked when the in-app browser harness is unavailable; service-level checks are not a substitute for a visual confirmation.

## Final hardening evidence (2026-07-14)

- Automated component coverage verifies that the crop editor renders uploaded MP4 media with a real `<video>` element while keeping the accessible crop overlay.
- Automated restore coverage verifies persisted batch lookup, restored asset crop metadata, stale draft removal, safe local identifier persistence, and the visible restore affordance.
- Route regressions verify that upload probing, exact-preview creation, Resize job status/debug responses, and trim submission do not expose managed paths or FFmpeg diagnostics.
- The full test command now includes both `.test.ts` and `.test.tsx` files and runs serially to avoid Windows file-rename contention in storage tests.
- Reload coverage restores active batch jobs before exposing the review flow; server coverage proves duplicate and concurrent batch submissions are rejected atomically with a safe conflict response.
- Retry-lineage coverage proves only the latest unresolved failed attempt per original/hook cell can be retried, while historical cards lose their Retry action and distinct cells remain independent.

The in-app browser harness remained unavailable during final hardening. No browser-only checkbox above was changed.
