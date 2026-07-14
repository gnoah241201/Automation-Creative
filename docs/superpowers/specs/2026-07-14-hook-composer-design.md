# Hook Composer Design

## Summary

Add a Hook Composer workflow for combining up to 10 hook videos with up to 10 original videos. Every selected hook is inserted into every selected original, producing a matrix of up to 100 outputs. The feature targets vertical `9:16` media, provides an always-visible hybrid preview, supports a shared insertion and trim configuration for hooks with approximately equal duration, stores outputs locally for 24 hours, and can pass multiple outputs directly into the existing Resize workflow without re-uploading them.

The first release uses hard cuts only. The composition model records an explicit `transition: "cut"` value so later releases can add crossfades or other transitions without replacing the segment model.

## Goals

- Combine `N` original videos with `M` hooks to create `N × M` outputs.
- Accept up to 10 originals and 10 hooks per batch.
- Make insertion and trimming understandable to non-technical users.
- Keep a large preview visible throughout editing.
- Avoid requiring configuration of every output when hooks have equal duration.
- Produce consistent `1080×1920` H.264 MP4 files with usable audio.
- Store generated outputs on the backend for 24 hours.
- Transfer multiple stored outputs into Resize without browser download and re-upload.
- Reuse the existing native FFmpeg queue, persistence, cancellation, recovery, and metrics patterns where practical.

## Non-goals

- Transitions other than a direct cut.
- Arbitrary multi-track editing, text, stickers, filters, or keyframes.
- Distributed queues or cloud object storage.
- Permanent media storage.
- Supporting a source directly when it has not been validated or cropped to `9:16`.

## User Experience

### Navigation

The authenticated app has three primary tabs:

1. **Resize** — the current resize workflow, extended to accept a batch of library assets.
2. **Hook Composer** — source import, crop, timeline editing, preview, and matrix rendering.
3. **Local Library** — locally stored outputs with selection, deletion, expiry information, download, and transfer to Resize.

### Visual direction

Use a Canva-inspired workspace with a simplified CapCut-style timeline:

- A collapsible media/tool rail on the left.
- A large `9:16` preview that remains visible while changing tools or variants.
- Contextual properties in a top toolbar or small popover instead of a permanent right inspector.
- A compact timeline below the preview.
- A single visual track containing `original before | hook | original after`.
- A purple hook clip that can be dragged to change the insertion point.
- Green range handles that select the retained output range.
- Clear progress such as `7/8 configurations reviewed`.
- Three workflow stages: `Select sources → Edit & preview → Review & render`.

The initial release does not expose a complex multi-track editor. The compact timeline may be made vertically resizable, but its controls remain limited to insertion, trim, zoom, playback, and frame snapping.

### Stage 1: Select sources

- Import or drag up to 10 originals and 10 hooks.
- Read duration, dimensions, frame rate, codecs, and audio presence with ffprobe.
- Generate thumbnails and show validation state on every asset.
- Accept a source directly only when its display aspect ratio is `9:16`, allowing a small metadata tolerance for non-square pixels.
- For another ratio, offer a crop editor constrained to `9:16`.
- Crop is non-destructive and stores normalized crop coordinates against the asset.
- If the user declines to crop an invalid asset, the asset must be removed before continuing.
- Group valid hooks by duration after metadata extraction.

### Hook duration grouping

Hook durations within `0.1` seconds share a configuration for each original video. Grouping is deterministic:

1. Sort hooks by exact probed duration and stable asset ID.
2. Start a group with the first ungrouped hook.
3. Add subsequent hooks only while `group maximum duration - group minimum duration <= 0.1` seconds.
4. Start a new group when adding a hook would exceed the range.

This avoids transitive grouping where a chain of individually close durations produces a group wider than `0.1` seconds.

### Stage 2: Edit and preview

The editable unit is a `variant configuration`, keyed by an original asset and a hook-duration group. A configuration contains:

- Original asset ID.
- Hook-duration group ID.
- Representative hook ID used for preview.
- Insertion time measured on the original timeline, inclusive from `0` through the exact original duration.
- Retained range start and end measured on the combined timeline.
- Crop references for the original and hooks.
- `transition: "cut"`.
- Review status.

All hooks in the group use the same insertion point and retained range for that original. Because grouped hooks may differ by up to `0.1` seconds, validation uses the longest hook in the group. The retained range must include the full interval from insertion time through insertion time plus the longest group duration. The UI clamps both trim handles so the user cannot trim any part of the longest hook.

For each original and duration group, the user can:

- Drag the purple hook clip anywhere from the start through the end of the original.
- Drag green range handles to trim the combined result.
- Switch the representative hook to inspect different content in the same duration group.
- Play an immediate browser preview.
- Request an exact FFmpeg preview.
- Mark the configuration reviewed and navigate to the previous or next configuration.

The user configures once per original and hook-duration group, not once per output. For hook durations `3, 3, 5, 5, 7`, each original has three configurations while still producing five outputs.

### Stage 3: Review and render

Display a matrix with originals as rows and hooks as columns. Every cell shows:

- Derived output name.
- Whether its shared variant configuration is reviewed and valid.
- Selection state for inclusion in the render.

The screen shows selected output count, estimated duration, estimated storage, and any remaining unreviewed configuration. Rendering is blocked while a selected cell has an invalid or unreviewed configuration. Users may deselect unwanted cells before submitting the batch.

Once submitted, every selected cell becomes an independently observable queue job. A failure in one job does not fail successful siblings. Users can cancel a job, cancel queued jobs in the batch, or retry failed outputs using the immutable source and configuration snapshot taken at submission time.

## Preview Design

### Immediate browser preview

The browser preview coordinates the original and representative-hook media elements as one virtual timeline:

1. Play the original until the insertion point.
2. Play the representative hook from its start through its end.
3. Resume the original from the insertion point.
4. Respect the configured retained range and crop transforms.

The virtual player is optimized for interaction, not frame-perfect continuity. Seeking and dragging update immediately without creating a server file. The preview stays mounted while the user changes tools or configuration values.

### Exact FFmpeg preview

An exact preview is generated only on request for the selected original, representative hook, and configuration. It:

- Uses the final composition pipeline.
- Outputs `360×640` H.264 MP4.
- Uses lower preview bitrate and the fastest CPU preset.
- Is cached by source content identifiers, crop configuration, insertion time, retained range, transition, and pipeline version.
- Is invalidated naturally by a changed cache key.
- Expires with the draft after 24 hours from the draft's last update.

Failure to create an exact preview does not discard the browser preview or draft. The UI reports the error and offers retry.

## Media Composition

### Normalization

Every final output is normalized to:

- `1080×1920` pixels.
- 30 FPS constant frame rate.
- H.264 video using the configured application encoder.
- `yuv420p` pixel format.
- AAC stereo audio at 48 kHz.
- MP4 with fast-start metadata.

The existing default video bitrate applies unless the application later exposes a composer-specific setting. Source crop is applied before scale. A valid `9:16` crop is scaled to fill `1080×1920` without further content crop.

### Audio

- The original audio is used during both original segments.
- The hook audio is used during the hook segment.
- A source with no audio receives a generated silent stereo track for its segment.
- Audio streams are normalized before concat to avoid sample-rate and layout mismatches.
- The first release uses hard audio cuts matching the video cuts.

### FFmpeg composition

For each output, the command builder:

1. Applies the stored crop to both sources as needed.
2. Normalizes video and audio streams.
3. Splits and trims the original at the insertion time.
4. Places the complete hook between the two original segments.
5. Concatenates video and audio segments.
6. Applies the retained combined-timeline range.
7. Resets timestamps and encodes the final MP4.

Insertion at `0` produces `hook + original`. Insertion at the exact original duration produces `original + hook`. Empty before/after segments are omitted rather than sent as zero-length concat inputs.

### Output naming

The base filename is:

```text
<original-name>__<hook-name>.mp4
```

Extensions are removed from both source names and unsafe filename characters are replaced. If the derived filename already exists within the same batch, append a stable numeric suffix such as `__2` before `.mp4`. Asset IDs, not filenames, are the authoritative identity.

## Frontend Structure

The existing `App.tsx` is already large, so the feature is implemented in focused modules rather than adding another workflow inline. Expected boundaries are:

- Application tab shell.
- Hook Composer page and workflow state.
- Media import and crop editor.
- Duration grouping and variant derivation pure functions.
- Persistent preview player.
- Timeline model and controls.
- Review matrix.
- Composer API client.
- Local Library page.
- Resize batch source adapter.

Pure timeline, grouping, naming, crop, and validation logic must remain independent of React so it can be tested with the existing Node test runner.

## Backend Structure

### Contracts

Add explicit shared contracts for:

- Composer asset metadata and crop.
- Hook-duration groups.
- Draft batch and variant configurations.
- Exact preview request/status.
- Composer render job specification.
- Local library entries.
- Resize library-source references.

Composer jobs are distinct from the current resize `RenderSpec`; they do not overload background, overlay, or output-ratio fields.

### Services

Use isolated services with clear responsibilities:

- `ComposerAssetStore`: uploaded sources, metadata, crops, and thumbnails.
- `ComposerDraftStore`: atomic persistence of batches and configurations.
- `ComposerPreviewService`: exact preview cache and lifecycle.
- `ComposerCommandBuilder`: FFmpeg normalization, segment concat, and retained-range trimming.
- `LocalLibraryService`: output metadata, expiry, deletion, and safe path resolution.
- Queue adapter/runner for composer jobs using the existing concurrency and lifecycle patterns.

The scheduler may be shared or generalized, but resize and composer command builders remain separate. All filesystem access resolves trusted IDs beneath the managed storage root. API requests never accept an arbitrary filesystem path.

### Suggested API surface

- `POST /api/composer/assets` — upload sources once and return probed asset metadata.
- `POST /api/composer/assets/:id/crop` — persist validated normalized crop data.
- `POST /api/composer/batches` — create a draft from asset IDs.
- `GET /api/composer/batches/:id` — restore a draft and statuses.
- `PUT /api/composer/batches/:id/configurations/:configurationId` — save one variant configuration.
- `POST /api/composer/batches/:id/preview` — create or return an exact preview.
- `POST /api/composer/batches/:id/render` — validate and enqueue selected matrix cells.
- `GET /api/composer/batches/:id/jobs` — batch job status.
- `DELETE /api/composer/batches/:id/jobs` — cancel queued/running jobs in scope.
- `GET /api/library` — list non-expired outputs.
- `DELETE /api/library/:id` — delete one stored output.
- `POST /api/library/delete` — delete selected stored outputs.

Existing authentication protects all composer and library routes.

## Persistence and Retention

Use local backend storage under the existing managed render root with separate source, preview, output, thumbnail, and state directories. Metadata is persisted using the existing atomic temp-write-and-rename pattern.

- Draft assets, configuration state, and exact previews expire 24 hours after the draft's last update.
- Final output expiry is 24 hours after that output completes.
- Manual deletion may remove final outputs earlier.
- Successful download does not shorten the composer output retention window.
- Sending an asset to Resize does not reset or extend its expiry.
- Active jobs hold references that prevent source deletion until those jobs terminate.
- A cleanup scheduler removes expired files and state and reconciles missing files.

Before render submission, estimate required output bytes from selected durations and bitrate. Require available free space to exceed the estimate by a 20% safety margin. Recheck before individual jobs start; if space has fallen below a safe threshold, fail the job clearly without starting FFmpeg.

## Local Library and Resize Integration

The Local Library lists:

- Output filename and thumbnail.
- Source original and hook.
- Batch ID.
- Duration, dimensions, and byte size.
- Completion time and remaining retention.
- Download, delete, and selection controls.

Users can select multiple entries and choose **Send to Resize**. The frontend passes trusted library asset IDs into Resize. The backend resolves those IDs to managed files; the browser does not download and re-upload media.

Resize receives a list of sources and applies one shared resize configuration to the selected batch. Users can remove individual sources before submission. Existing single-file upload remains supported.

If a library file expires before its resize job starts, that resize job fails with a specific source-expired message. Queue submission should snapshot/hold an active reference so normal expiry cleanup cannot remove a file already accepted by a resize job.

## Job Lifecycle and Recovery

Composer output jobs follow the existing lifecycle:

```text
queued → processing → completed
                    → failed
queued/processing → cancelling → cancelled
```

- Jobs are persisted after every material lifecycle change.
- Queued jobs are requeued after restart if their sources still exist.
- Processing or cancelling jobs interrupted by restart become failed with an explicit restart error and can be retried.
- Completed siblings remain available when another matrix cell fails.
- Retry creates a new job from the original immutable render snapshot.
- Cancelling a batch cancels queued jobs immediately and signals active FFmpeg processes.

## Error Handling

- Reject corrupt/unprobeable media with an asset-level error.
- Require crop or removal for non-`9:16` sources.
- Generate silence for sources without audio.
- Normalize differing codecs, frame rates, sample rates, and channel layouts.
- Prevent trim ranges that omit any part of the longest hook in a duration group.
- Preserve the browser preview and draft when exact preview generation fails.
- Isolate failures to individual matrix cells.
- Reject render submission with invalid, missing, expired, or unreviewed selected configurations.
- Sanitize output filenames and resolve all data through trusted IDs.
- Block or fail safely when disk capacity is insufficient.
- Surface cleanup races and missing files as explicit expired/gone states rather than generic server errors.

## Testing Strategy

### Unit tests

- Duration grouping at, below, and above the `0.1` second boundary.
- Deterministic grouping that prevents transitive range expansion.
- Insertion at the start, middle, and exact end.
- Combined timeline duration and source-to-output time mapping.
- Retained-range clamping that preserves the longest hook.
- Crop validation and preview-to-FFmpeg coordinate conversion.
- Matrix derivation for `1×1`, `5×5`, and `10×10`.
- Filename sanitization and collisions.
- Storage expiry and reference holds.

### Command-builder tests

- Inputs with different codecs and frame rates.
- Both sources with audio, one source without audio, and neither source with audio.
- Cropped sources.
- Empty before or after segment at boundary insertion.
- Final retained-range trim.
- CPU and configured NVENC encoder argument selection.

### API and service tests

- Upload/probe/crop lifecycle.
- Draft persistence and restore.
- Exact preview cache hit and invalidation.
- Partial batch failure and retry.
- Job cancellation and restart recovery.
- Cleanup after 24 hours.
- Low-disk rejection.
- Safe asset-ID resolution and rejection of path traversal.
- Multi-selection transfer from Local Library to Resize.

### UI and smoke tests

- Preview remains mounted while changing tools and variants.
- Timeline drag, trim handles, frame snapping, and review navigation.
- Crop flow for invalid aspect ratios.
- Matrix selection and unreviewed warnings.
- Real FFmpeg smoke files verifying output picture, audio segment order, duration, boundary insertion, naming, download, and library-to-resize handoff.

## Success Criteria

- Five valid originals and five valid hooks can produce 25 independently tracked outputs.
- Ten by ten is accepted and produces at most 100 selected jobs without duplicate source uploads.
- Hooks grouped within `0.1` seconds share one configuration per original.
- Every selected final output contains its complete hook at the configured insertion point.
- Every output is `1080×1920`, playable H.264/AAC MP4 with the expected duration and audio order.
- A user can preview, review, render, recover from partial failures, and transfer multiple outputs into Resize without re-uploading them.
- Local outputs and drafts are removed according to the 24-hour policy.
