# Hook Composer: Library ZIP, Bulk Apply, and Source Trim Design

**Date:** 2026-07-14  
**Status:** Approved in conversation; awaiting written-spec review  
**Branch:** `feature/hook-composer`

## Objective

Extend Hook Composer with three related workflow improvements:

1. Download selected Local Library outputs as one ZIP when the user does not want to send them to Resize.
2. Apply one Step 2 timeline configuration across a complete original row, a complete hook-duration-group column, or the entire configuration matrix.
3. Non-destructively trim unwanted time from uploaded originals and hooks before grouping, configuration, preview, or final rendering.

The design must preserve the existing 1–10 originals by 1–10 hooks workflow, exact-preview cache correctness, atomic draft persistence, 24-hour retention, and Local Library-to-Resize handoff.

## Confirmed Product Decisions

- Local Library downloads only the currently selected outputs.
- The download is one ZIP, not a sequence of browser MP4 downloads.
- Step 2 bulk Apply exposes two independent scope controls:
  - every hook group for the current original;
  - the current hook group for every original.
- Selecting both Apply scopes targets the entire original-by-hook-group matrix, not only the current row and column.
- Applying across originals keeps exact second values. An insertion beyond a shorter target original is clamped to that original's end.
- Applied targets are marked reviewed immediately after confirmation.
- Source trimming is non-destructive and optional.
- Trimming opens from a button on each source card rather than automatically after upload.
- Re-trimming an asset invalidates affected Step 2 review state. Hook edits also rebuild duration groups.
- Editing uses a collapsible right drawer. On narrow layouts it becomes a near-full-screen bottom sheet.

## Out of Scope

- Destructively rendering a new source file after every trim edit.
- Transitions, fades, speed changes, audio mixing controls, or source splicing.
- Selecting multiple disjoint source ranges.
- Adding waveform generation as a prerequisite. The trim timeline may use the existing video frame/thumbnail presentation.
- Creating a persistent ZIP file in Local Library.
- Changing the existing 24-hour output retention policy.

## Architecture

The implementation is metadata-native:

- Each Composer asset stores an optional effective time range.
- The original uploaded file remains authoritative and unchanged.
- All consumers derive the same effective duration and FFmpeg offsets from asset metadata.
- Bulk Apply is a single server-side atomic draft mutation.
- ZIP preparation validates and holds entries before a one-time streaming download begins.

This avoids browser memory pressure, partially saved matrices, duplicate trimmed sources, and preview/final disagreement.

## Source Trim Data Model

`ComposerAsset` gains:

```ts
interface ComposerAsset {
  // existing fields
  sourceTrimStart?: number;
  sourceTrimEnd?: number;
  revision: number;
}
```

Rules:

- Omitted values mean the complete uploaded source: `0` to probed duration.
- Effective start is `sourceTrimStart ?? 0`.
- Effective end is `sourceTrimEnd ?? duration`.
- Effective duration is `effectiveEnd - effectiveStart`.
- Both endpoints are finite, inside the probed source duration, and snapped to the source frame grid.
- The effective range contains at least one source frame.
- API responses continue to expose the probed duration and add an explicit effective duration, or clients derive it through one shared helper. The project must not redefine this calculation independently in multiple modules.
- Spatial crop metadata remains independent and persists when the time range changes.

Asset metadata writes remain atomic and serialized per asset. New assets start at `revision: 1`; every successful crop or source-trim mutation increments it once. The source-trim endpoint requires `expectedRevision`, so a stale drawer receives a typed `409` and cannot overwrite a newer edit.

## Source Trim Effects

### Originals

- Step 2 treats the selected source range as a new zero-based original timeline.
- `insertAt` is measured from the beginning of that effective range.
- Combined duration is effective original duration plus effective hook duration.

### Hooks

- Duration grouping uses effective hook durations.
- Changing a hook trim can move it to a different group.
- The draft rebuilds groups deterministically using the existing 0.1-second spread rule.

### Draft invalidation

- Any source-trim change marks the current batch stale.
- Existing configurations affected by the changed asset are not silently reused.
- Returning to Step 2 requires configurations to be reviewed again.
- A hook trim rebuilds the duration-group matrix before review.
- Exact-preview keys and immutable final-render snapshots include both sources' time ranges.

## FFmpeg Ordering

For each source, FFmpeg processing is ordered as follows:

1. Seek/trim to the effective source range.
2. Reset timestamps to a zero-based timeline.
3. Apply normalized spatial crop.
4. Normalize resolution, frame rate, pixel format, sample rate, and audio layout.
5. Split the effective original at `insertAt`.
6. Concatenate original-before, hook, and original-after.
7. Apply the existing combined-output trim.

Audio follows the same effective ranges. A source without audio still receives duration-bounded stereo silence. Preview and final modes share the same timeline builder.

## Source Editing Drawer

Each original and hook card in Step 1 has an **Edit source** action with clear sub-actions for **Trim segment** and **Crop 9:16**.

The collapsible right drawer contains:

- asset filename and source type;
- video preview;
- `Trim segment` and `Crop 9:16` tabs;
- a source timeline with In/Out handles;
- numeric In and Out fields in seconds;
- current time and selected effective duration;
- play-selected-range control;
- `Use full video`, `Cancel`, and `Save segment` actions.

Source cards show both values when trimmed, for example `Original 23.4s → Using 16.5s`.

The drawer must not discard unsaved edits when switching tabs accidentally. Closing with changes asks for confirmation. When closed, the main preview regains its full available width. On small screens the drawer becomes a bottom sheet with the video above the timeline and controls.

## Step 2 Bulk Apply

The current configuration remains identified by `(originalId, durationGroupId)`. The existing representative hook identity stays specific to each target group; bulk Apply copies timeline behavior, not an invalid representative hook from another group.

The Apply drawer exposes:

- **All hook groups for this original**;
- **This hook group for all originals**;
- a target count;
- a preview of clamped results;
- a list/count of targets whose insertion point moves because the target original is shorter;
- `Apply & mark reviewed (N variants)`.

Scope semantics:

| Selected controls | Targets |
|---|---|
| Original only | Current original × every hook group |
| Hook group only | Every original × current hook group |
| Both | Every original × every hook group |

At least one scope control is required.

### Exact-second transformation

For every target:

- `targetInsertAt = min(source.insertAt, targetEffectiveOriginalDuration)`.
- Start from the source configuration's exact `trimStart` and `trimEnd` seconds.
- Clamp `trimStart` to `[0, targetInsertAt]`.
- Ensure `trimEnd` is at least `targetInsertAt + targetGroup.maxDuration`.
- Clamp `trimEnd` to the target combined duration.
- If clamping the upper bound would violate complete-hook containment, expand toward the start while keeping the complete longest hook; if no valid range exists, reject the entire Apply operation.
- Keep `transition: 'cut'`.
- Keep each target's valid representative hook, or deterministically select a member of that target group when the target does not yet exist.
- Mark every target `reviewed: true`.

### Atomicity and concurrency

The UI requests an Apply preview, then confirms. The server recomputes all targets during commit rather than trusting previewed client values.

`ComposerBatchDraft` gains a monotonically increasing numeric `revision`, starting at `1`. Every successful configuration or matrix mutation increments it once. The Apply commit requires `expectedRevision`. If another tab or request changed the draft, the server returns a safe typed `409` and writes nothing. Validation or persistence failure also writes nothing. A successful response returns the complete canonical changed-configuration set and new draft revision.

## Local Library ZIP Download

Local Library keeps the existing selection checkboxes and adds:

- **Select all** / **Clear selection**;
- selected count;
- **Download selected (.zip)**;
- preparation/error status.

Only selected, unexpired, locally usable entries are eligible. The maximum remains the Local Library's bounded Composer output count (up to 100).

### Two-step protocol

1. `POST /api/library/download-bundles` with selected library IDs.
2. The server validates all IDs, acquires temporary holds, and returns a short-lived one-time download URL.
3. Browser navigation to the returned URL starts a streaming ZIP response.
4. Holds are released after stream completion, stream failure, disconnect, or token expiry.

The preparation step is all-or-nothing. If any entry is missing, expired, outside managed storage, or otherwise unusable, no bundle is created and the response identifies the affected public filename/ID without exposing a filesystem path.

The ZIP is not persisted. Its filename is deterministic and human-readable, such as `hook-composer-20260714-1530.zip`. MP4 name collisions inside the archive receive stable `__2`, `__3`, and later suffixes using case-insensitive allocation.

Bundle tokens:

- are cryptographically random;
- are bound to the authenticated session/user;
- are single-use;
- expire after five minutes if unused;
- do not contain file paths or raw IDs;
- have cleanup on normal shutdown and periodic retention cycles.

## Error Handling and Security

- All new endpoints use existing authentication middleware.
- Asset IDs, batch IDs, library IDs, and bundle tokens are validated before path resolution.
- Source and output paths are derived only from trusted managed-storage metadata.
- ZIP entry names are sanitized and never taken as archive paths.
- Public errors never contain FFmpeg stderr, executable locations, managed paths, or stack traces.
- A failed source-trim save leaves old metadata unchanged.
- A failed bulk Apply leaves the complete draft unchanged.
- A ZIP stream failure releases all bundle holds.
- Source media that disappears between validation and use returns a safe gone/unavailable state and invalidates dependent draft work.

## Retention and Cleanup

- Trimming metadata follows the containing draft/asset lifecycle.
- Old exact previews become unreachable because trim metadata participates in the cache key; standard preview cleanup removes them.
- Bundle holds temporarily override 24-hour deletion only while the bundle is pending or streaming.
- Abandoned bundle tokens expire after five minutes and release holds.
- Cleanup remains non-overlapping and reconciles stale holds after restart.

## Testing Strategy

### Unit tests

- effective-range validation, frame snapping, and one-frame minimum;
- effective duration and hook grouping;
- exact-second Apply transformation and short-original clamping;
- row, column, and full-matrix scope expansion;
- reviewed-state updates and target representative selection;
- deterministic case-insensitive ZIP name collisions.

### Service and route tests

- atomic source-trim metadata writes and stale revision conflict;
- atomic bulk Apply and no partial persistence;
- concurrent Apply conflict;
- bundle preparation validation and authentication;
- one-time token behavior and session binding;
- holds on success, failure, disconnect, expiry, cleanup, and restart reconciliation;
- safe error redaction and path containment.

### Frontend component tests

- source drawer open/close, tab switching, dirty-close confirmation, In/Out controls, and full-source reset;
- source card original/effective duration display;
- Apply drawer scopes, affected count, clamping warning, confirmation, and `409` recovery;
- Local Library Select all, Clear selection, Download ZIP, progress, and unavailable-entry error.

### Real-media tests

- trim both an original and a hook, then verify visual/audio segment order;
- verify duration groups use effective hook durations;
- compare browser timeline math, exact preview, and final FFmpeg output;
- inspect the streamed ZIP central directory and extracted MP4 hashes/names;
- verify output remains 1080×1920, 30 FPS, H.264/yuv420p, AAC stereo 48 kHz.

### Manual checklist

The existing Hook Composer smoke checklist gains source-drawer, bulk-Apply, and selected-ZIP checks. Browser-only observations are marked complete only after actual browser verification; component/service tests do not falsely substitute for manual visual confirmation.

## Success Criteria

- A user can trim any uploaded original or hook without creating a replacement source file.
- All grouping, preview, Apply, and final-render behavior uses the selected source ranges consistently.
- A user can configure one variant, Apply it to the chosen matrix scope, and review the exact affected count before one atomic save.
- A user can select Local Library outputs and receive one valid ZIP without sending them to Resize.
- No new workflow can leak local paths, create partial draft state, revive expired files, or allow cleanup to delete an actively streamed ZIP member.
