# PR 1 Plan: Overlay Reset Controls and Preview/Render Consistency

## PR Goal

Add explicit reset controls for logo and button transforms, while guaranteeing that the rendered video output matches the frontend preview after reset and after manual adjustments.

## Why This PR Exists

The current implementation stores overlay transform state in `src/App.tsx`, but the actual rendered overlay is produced by `src/render/overlay.ts` using `RenderSpec`. That means the UI preview and final output are part of the same feature, but they are not driven by a single explicit source of truth for defaults.

If reset is added only in the UI without consolidating defaults and transform semantics, the preview can appear correct while the rendered output drifts.

## Current Code Context

### Frontend state location
`src/App.tsx`

Current relevant state includes:

- `logoSize`
- `logoX`
- `logoY`
- `buttonType`
- `buttonText`
- `buttonImage`
- `buttonImageFile`
- `buttonSize`
- `buttonX`
- `buttonY`

Current default values observed in the codebase:

- logo: size `100`, x `0`, y `0`
- button: type `text`, text `Play Now`, size `100`, x `0`, y `0`

### Render payload composition
`src/render/renderSpec.ts`

This file packages the current UI state into a `RenderSpec` object. It is the critical bridge between the preview controls and the backend render request.

### Overlay rendering
`src/render/overlay.ts`

This file creates the actual overlay PNG. It computes logical dimensions and translates `logoX/logoY/logoSize` and `buttonX/buttonY/buttonSize` into draw operations.

### Shared contract
`shared/render-contract.ts`

This defines the render-spec fields that carry overlay transform values.

## Required Outcome

After this PR:

1. The UI has a `Reset Logo` control
2. The UI has a `Reset Button` control
3. Resetting returns those controls to their true default values
4. The render spec uses exactly those reset values
5. The resulting rendered output matches the preview layout after reset

## In Scope

- Extract shared overlay default values into a dedicated utility/module
- Wire state initialization in `src/App.tsx` to use those defaults
- Add reset handlers for logo and button
- Add reset buttons in the relevant control panels
- Ensure the same values flow into `buildRenderSpec(...)`
- Verify that `createOverlayPng(...)` still interprets them consistently
- Add tests or targeted verification for reset/default behavior

## Out of Scope

- Redesigning the overlay UI visually
- Changing the art style of the button or logo shadow
- Introducing drag-and-drop positioning
- Changing overlay placement math beyond what is required to preserve current preview/render parity

## Affected Files

Expected minimum touch points:

- `src/App.tsx`
- `src/render/renderSpec.ts`
- `src/render/overlay.ts`
- `shared/render-contract.ts` only if a shared type needs to be refined
- one new utility file for shared defaults, likely under `src/render/` or `src/lib/`

## Required Edits

These edits are required unless a verified better equivalent exists:

1. Create a dedicated shared-defaults module for overlay defaults
2. Replace inline default state literals in `src/App.tsx` with imports from that module
3. Add one logo reset handler and one button reset handler in `src/App.tsx`
4. Add visible `Reset Logo` and `Reset Button` controls in the appropriate UI sections
5. Confirm `src/render/renderSpec.ts` consumes the same values after reset without introducing new transform math
6. Review `src/render/overlay.ts` and preserve parity with the preview behavior after reset

If an implementer cannot satisfy one of the above, they must document why in the PR notes.

## Implementation Tasks

### Task 1: Create a shared defaults module

Create a small module that defines canonical default values for:

- logo size/x/y
- button type/text/image presence
- button size/x/y

Requirements:

- Do not repeat these defaults inline in multiple places after this refactor
- Name the exports clearly enough that another maintainer can identify them as UI/render shared defaults

### Task 2: Refactor `src/App.tsx` state initialization

Update the initial `useState(...)` calls so they derive from the shared defaults module.

Requirements:

- State initialization must stay readable
- Avoid large anonymous default objects inline inside JSX-heavy regions

### Task 3: Add reset handlers

Implement:

- a logo reset handler
- a button reset handler

Logo reset must restore:

- `logoSize`
- `logoX`
- `logoY`

Button reset must restore:

- `buttonType`
- `buttonText`
- `buttonSize`
- `buttonX`
- `buttonY`
- `buttonImage`
- `buttonImageFile`

Reasoning: the user asked for values to return to the original state, not only partial transform fields.

### Task 4: Add reset buttons to the UI

Place reset controls in the Logo and Button control cards in `src/App.tsx`.

Requirements:

- Buttons must be easy to discover near the controls they affect
- Labels must make scope explicit: `Reset Logo`, `Reset Button`
- Do not mix both reset behaviors into one generic reset button in this PR

### Task 5: Validate render-spec flow

Review `src/render/renderSpec.ts` and ensure the reset values from UI state are passed through unchanged.

Requirements:

- No new derived math should be added here unless current code already does so
- This layer should remain a packaging layer, not a second layout engine

### Task 6: Validate overlay consistency

Review `src/render/overlay.ts` and verify that the transformed defaults are interpreted exactly as expected.

Requirements:

- If magic numbers are currently duplicated only to support existing layout math, preserve behavior
- If extracting a small shared helper improves parity without large churn, it is acceptable
- Do not silently change overlay placement behavior for non-reset scenarios

### Task 7: Add verification

At minimum, verify:

- reset restores correct state values
- render spec after reset contains those values
- preview and generated overlay remain aligned in at least one manual runtime check

If tests are added, good targets include:

- a small unit test for defaults
- a targeted test for the output of `buildRenderSpec(...)`

## Edge Cases

- Button is currently in `image` mode when reset is pressed
- Button image file exists when reset is pressed
- Logo has been uploaded and transform changed before reset
- Input ratio changes after reset
- Foreground position changes for `9:16 -> 16:9` output scenarios

## Acceptance Criteria

- Reset Logo restores logo transform to the canonical defaults
- Reset Button restores button content and transform to the canonical defaults
- Preview updates immediately after reset
- Rendered output generated after reset matches preview behavior
- No duplicated hardcoded default transform values remain scattered through the code

## Non-Goals

The implementer must not do the following in this PR:

- redesign the Logo or Button cards
- change button visual styling unrelated to reset behavior
- introduce drag handles, direct manipulation, or canvas editing UI
- refactor unrelated preview layout code for cleanliness only
- change output-generation rules or queue naming behavior

## Verification Checklist

- Run diagnostics on modified frontend files
- Run relevant tests if present
- Run typecheck / lint command used by this repo
- Run a manual preview + render check with:
  - changed logo transform, then reset
  - changed button transform and mode, then reset
- Confirm the resulting video matches the preview after reset

## Exact Verification Commands

Run these commands from repo root after implementation:

1. `npm run lint`
2. `npm run build`

If tests are added for this PR, also run the narrowest applicable test command available in the repo and record the exact command in the PR description.

Manual verification required:

1. Start the app with the existing local dev workflow
2. Load a video and optional logo/button assets
3. Change logo position/size, then press `Reset Logo`
4. Change button mode/position/size, then press `Reset Button`
5. Queue a render and compare preview vs rendered output after reset

## Rollback Notes

If this PR causes preview/render mismatch, revert toward these safe conditions:

1. Keep the shared-defaults module if it is correct and only back out UI wiring
2. Revert reset handlers and buttons if they alter state correctly in UI but break render output
3. Restore previous `src/render/overlay.ts` behavior if any refactor changed placement semantics for non-reset scenarios
4. Do not keep a partial state where UI resets but render-spec values diverge from the preview

## Handoff Notes for the Implementer

- Treat preview/render parity as the primary invariant
- Favor small shared utilities over duplicating constants
- If parity is uncertain, compare `src/App.tsx` visual assumptions against `src/render/overlay.ts` logical dimension math before editing anything
