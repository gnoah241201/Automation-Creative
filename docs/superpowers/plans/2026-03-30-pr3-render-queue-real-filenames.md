# PR 3 Plan: Render Queue Displays Real Output Filenames

## PR Goal

Update the Render Queue so jobs display the real output filename instead of generic labels like `Output 16:9` or `Output 4:5`, especially after render completes.

## Why This PR Exists

The queue currently favors UI-friendly labels, but the user needs the queue to reflect the actual file identity. This is important for trust, batch review, and download accuracy.

The rendered output already has a specific generated filename, so the queue should surface that filename instead of hiding it behind generic labels.

## Current Code Context

### Queue UI
`src/App.tsx`

The sidebar render queue maps over jobs and currently renders `job.label` in the card header.

### Naming utility
`src/naming.ts`

This is the canonical place where output filenames are generated from metadata, ratio, and optional duration.

### Render-spec builder
`src/render/renderSpec.ts`

This prepares the `outputFilename` for a job before submission.

### Backend job record and API

- `server/types/renderJob.ts`
- `server/routes/jobs.ts`

These files determine what filename information is retained and returned to the frontend.

## Required Outcome

After this PR:

1. Queue cards show the real filename whenever it is available
2. Completed jobs always show the real filename
3. Download actions align with the same displayed filename
4. Failed jobs still retain enough filename identity for the user to understand what failed

## In Scope

- Update queue display logic in the frontend
- Ensure job data includes the correct output filename at the right lifecycle points
- Improve fallbacks for pre-render or failed states
- Add targeted verification around queue naming

## Out of Scope

- Redesigning the queue layout
- Renaming files in storage
- Changing the naming algorithm itself except where necessary for consistency

## Affected Files

Expected minimum touch points:

- `src/App.tsx`
- `src/render/renderSpec.ts`
- `server/routes/jobs.ts`
- `server/types/renderJob.ts`

Possible touch point:

- `src/naming.ts` only if a helper is needed to make display/fallback logic cleaner

## Required Edits

These edits are required unless a verified better equivalent exists:

1. Audit and document the current flow of `outputFilename` from render-spec creation to queue polling response
2. Implement an explicit queue display-priority rule in code
3. Update queue card rendering in `src/App.tsx` to use that display rule
4. Ensure backend job responses retain enough filename information for queued, processing, completed, and failed states
5. Verify download behavior uses the same filename visible in the queue

If an implementer decides backend schema changes are unnecessary, they must still document where the filename already survives the full flow.

## Implementation Tasks

### Task 1: Audit the data flow for `outputFilename`

Confirm where `outputFilename` already exists and where it is dropped or ignored.

Specifically inspect:

- render-spec creation
- job creation request payload
- backend queue record creation
- job polling response payload
- frontend job state mapping

### Task 2: Define queue display priority

Implement a clear priority rule such as:

1. real output filename
2. fallback human-readable label

This rule must be explicit in code, not implicit in JSX.

### Task 3: Update frontend queue card rendering

Change queue card title rendering in `src/App.tsx` to use the display-priority rule.

Requirements:

- completed jobs must show the real filename
- queued and processing jobs should show the real filename as soon as it is known
- failed jobs should still show the intended output filename if available

### Task 4: Confirm backend response coverage

Review `server/routes/jobs.ts` and `server/types/renderJob.ts` to ensure the frontend receives all data needed for this display logic.

If fields are already present, avoid unnecessary schema churn.

### Task 5: Verify download consistency

Ensure the same filename shown in the queue is the filename used by the save/download flow.

### Task 6: Add targeted verification

At minimum, verify:

- a queued job shows the right target name if known
- a completed job shows the final filename
- the download uses the same filename

## Edge Cases

- Job is created before all metadata-derived naming fields are available
- Job fails before completion but should still retain intended filename
- Queue contains old jobs persisted from before this change
- Jobs with identical naming metadata but different ratios/durations coexist

## Acceptance Criteria

- Queue no longer relies on generic output labels when real filenames are available
- Completed jobs display the real filename
- Downloaded file name matches queue display
- Failed and retryable jobs still show meaningful identity

## Non-Goals

The implementer must not do the following in this PR:

- redesign the queue card layout
- change the filename generation format itself unless required for consistency
- introduce queue-only naming conventions separate from `src/naming.ts`
- refactor unrelated job-state polling behavior

## Verification Checklist

- Run diagnostics on modified frontend/backend files
- Run typecheck / lint command used by the repo
- Manually queue at least one job and verify queued, processing, completed, and download states
- If feasible, test one failed job path and confirm filename identity remains visible

## Exact Verification Commands

Run these commands from repo root after implementation:

1. `npm run lint`
2. `npm run build`

Manual verification required:

1. Queue at least one render job and inspect the queue while status is `queued` or `processing`
2. Confirm the queue title uses the intended filename when available
3. Let the job complete and confirm the same filename remains visible
4. Download the output and confirm the saved filename matches the queue display
5. If feasible, force or reproduce one failed job and confirm the queue still identifies the intended output file meaningfully

## Rollback Notes

If this PR causes queue naming confusion or broken downloads, revert toward these safe conditions:

1. Restore the previous queue title rendering but keep any harmless backend filename plumbing if it is correct
2. Preserve `outputFilename` propagation work if it is accurate and only the display rule is wrong
3. Do not leave partial logic where completed jobs show one filename but downloads use another

## Handoff Notes for the Implementer

- Treat `src/naming.ts` as the canonical naming authority
- Avoid inventing queue-only naming formats
- Keep display fallback logic centralized or at least easy to discover
