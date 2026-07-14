# PR 2 Plan: Long-Video Output Rules and 30s Variant Generation

## PR Goal

Introduce a rule-driven output derivation flow so that input videos longer than 35 seconds gain one extra 30-second output matching the input aspect ratio, while all current outputs remain unchanged.

This PR must implement approved rule A.

## Approved Rule A

- If input duration is less than or equal to 35 seconds: keep current outputs only
- If input duration is greater than 35 seconds:
  - keep all current outputs
  - add `16:9 30s` if the input ratio is `16:9`
  - add `9:16 30s` if the input ratio is `9:16`

Do not replace existing 6s/15s outputs.

## Why This PR Exists

The current output list is frontend-derived and effectively fixed. The new 30-second output needs to appear consistently across:

- preview cards
- export selection modal
- render-spec building
- filename generation
- downstream queue naming behavior

If rule logic is duplicated in multiple UI locations, the app will drift.

## Current Code Context

### Main UI and output rendering
`src/App.tsx`

This file currently renders preview cards from a derived `outputs` array and uses that same output model for queue/export selection.

### Render-spec building
`src/render/renderSpec.ts`

This file takes output ratio and duration and packages a request payload.

### Naming
`src/naming.ts`

This file builds output filenames and already understands duration suffixes.

### Shared contract
`shared/render-contract.ts`

This is relevant if any additional metadata shape is needed for output definitions.

## Required Outcome

After this PR:

1. Output derivation is centralized
2. The new 30-second variant appears only when input duration is greater than 35 seconds
3. The added output ratio matches the input ratio exactly
4. Existing outputs continue working unchanged

## In Scope

- Extract output derivation into a dedicated utility
- Update preview rendering and export modal to use the utility
- Ensure duration flows into `buildRenderSpec(...)`
- Ensure generated filenames include the 30-second suffix where applicable
- Add targeted tests for the derivation rule

## Out of Scope

- Changing current output ratios unrelated to the new rule
- Changing the 35-second threshold
- Adding multiple 30-second outputs for a single input
- Moving output derivation to the backend in this PR

## Affected Files

Expected minimum touch points:

- `src/App.tsx`
- `src/render/renderSpec.ts`
- `src/naming.ts`
- one new utility file for output derivation

Potential optional touch points:

- `shared/render-contract.ts` if a formal output-definition type should be shared

## Required Edits

These edits are required unless a verified better equivalent exists:

1. Create a dedicated output-derivation utility
2. Move current output-generation behavior into that utility before adding the new rule
3. Implement rule A with a strict `duration > 35` threshold
4. Replace inline output derivation in `src/App.tsx` with the shared utility
5. Ensure `src/render/renderSpec.ts` receives `duration = 30` for the new long-video variant
6. Ensure `src/naming.ts` remains the filename source of truth for the new output

If an implementer changes output ordering, they must justify the product reason in the PR.

## Implementation Tasks

### Task 1: Create a dedicated output-derivation utility

Create a single function that accepts at least:

- `inputRatio`
- foreground duration

and returns the ordered output-definition list used by the UI.

The return shape should be expressive enough to include:

- id
- ratio
- duration
- label

Optional but useful:

- a semantic flag such as `isLongFormExtension`

### Task 2: Recreate current behavior in the utility first

Before adding the new 30-second rule, the utility should reproduce current outputs exactly.

Reasoning: this prevents accidental regressions during refactor.

### Task 3: Add the `> 35s` extension rule

Implement the approved rule A exactly.

Requirements:

- threshold is strictly greater than 35 seconds
- input duration `35` does not get the extra 30-second output
- only one extra 30-second output is added
- that output ratio must match the input ratio

### Task 4: Update all UI consumers

Replace any inline output derivation in `src/App.tsx` with the shared utility.

Consumers to check:

- preview list rendering
- download/export modal checkbox list
- any preview filename block that assumes a single representative output

### Task 5: Confirm render-spec duration behavior

Review `src/render/renderSpec.ts` and ensure selected outputs correctly set `duration = 30` for the new long-form output.

### Task 6: Confirm filename behavior

Review `src/naming.ts` and ensure the 30-second outputs receive the expected duration suffix.

Requirement:

- Do not add ad hoc naming logic in `App.tsx`
- Continue using the naming utility as the filename source of truth

### Task 7: Add targeted tests

At minimum, cover:

- `16:9`, duration `20`
- `16:9`, duration `35`
- `16:9`, duration `36`
- `9:16`, duration `36`

Verify both count and exact output identities.

## Edge Cases

- Duration is temporarily undefined before metadata is loaded
- Duration is fractional, for example `35.1`
- User changes input ratio after video metadata has already been read
- Existing filename preview UI shows only one example filename while multiple outputs exist

## Acceptance Criteria

- Videos with duration `<= 35s` behave exactly as before
- Videos with duration `> 35s` gain exactly one additional 30-second output
- Added output ratio matches input ratio
- Existing outputs remain present
- Filename generation correctly reflects the 30-second duration

## Non-Goals

The implementer must not do the following in this PR:

- change the 35-second threshold
- replace existing 6s/15s outputs
- add more than one extra 30-second output per long input
- move output derivation to the backend
- redesign preview cards or export modal visuals

## Verification Checklist

- Run diagnostics on modified frontend files
- Run tests covering the derivation utility
- Run typecheck / lint command used by the repo
- Manual UI verification with one short video and one long video per input ratio if possible

## Exact Verification Commands

Run these commands from repo root after implementation:

1. `npm run lint`
2. `npm run build`

If tests are added for the derivation utility, run the narrowest matching test command available in the repo and document it in the PR description.

Manual verification required:

1. Load a short input video with duration less than 35 seconds and confirm output list remains unchanged
2. Load a long `16:9` input video with duration greater than 35 seconds and confirm exactly one extra `16:9 30s` output appears
3. Load a long `9:16` input video with duration greater than 35 seconds and confirm exactly one extra `9:16 30s` output appears
4. Queue one new 30-second output and confirm its filename includes the duration suffix

## Rollback Notes

If this PR causes inconsistent output lists across the UI, revert toward these safe conditions:

1. Keep the shared utility only if it still reproduces old behavior exactly
2. Remove the new `> 35s` branch before reintroducing old inline logic
3. Do not leave the app in a mixed state where preview cards and export modal derive outputs differently
4. If naming becomes inconsistent, restore `src/naming.ts` as the sole filename authority before retrying

## Handoff Notes for the Implementer

- Centralization matters more than where the file lives
- If you see output logic duplicated in `App.tsx`, replace it instead of layering over it
- Preserve ordering of existing outputs unless there is a strong product reason to change it
