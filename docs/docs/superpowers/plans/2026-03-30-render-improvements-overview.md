# Render Improvements PR Breakdown

## Purpose

This document splits the approved design into separate implementation PR scopes so another engineer or AI agent can execute them independently with minimal ambiguity.

## Project Context

This repository is a React + Vite frontend with an Express + FFmpeg backend.

- Frontend state and queue UI are concentrated in `src/App.tsx`
- Frontend render payload construction lives in `src/render/renderSpec.ts`
- Frontend overlay generation lives in `src/render/overlay.ts`
- Shared contracts live in `shared/render-contract.ts`
- Backend FFmpeg command generation lives in `server/ffmpeg/buildCommand.ts`
- Backend job queue and concurrency controls live in `server/services/jobQueue.ts`
- Backend server bootstrap and concurrency env wiring live in `server/index.ts`

## Approved Scope

1. Add reset controls for logo and button transforms while keeping preview and rendered output aligned
2. For input videos longer than 35 seconds, add a new 30-second output matching the input aspect ratio, while keeping current outputs unchanged
3. Show the real output filename in the Render Queue instead of generic labels like `Output 16:9`
4. Increase default concurrent render capacity to 5, while keeping configurability for stronger machines

## PR Structure

### PR 1
`2026-03-30-pr1-overlay-reset-and-consistency.md`

Focus:
- shared overlay defaults
- reset controls in the UI
- preview/render consistency for logo and button transforms

### PR 2
`2026-03-30-pr2-long-video-output-rules.md`

Focus:
- deriving outputs from duration and input ratio
- rule A: keep current outputs, add one new 30-second output when input duration is greater than 35 seconds

### PR 3
`2026-03-30-pr3-render-queue-real-filenames.md`

Focus:
- queue naming and display logic
- surface real output filenames through the frontend queue cards

### PR 4
`2026-03-30-pr4-render-concurrency-increase.md`

Focus:
- backend concurrency policy
- change default concurrent jobs from 2 to 5
- preserve env configurability and existing queue semantics

## Suggested Execution Order

Recommended order:

1. PR 1
2. PR 2
3. PR 3
4. PR 4

Reasoning:

- PR 1 stabilizes overlay behavior and reset semantics before broader UI changes
- PR 2 centralizes output derivation, which PR 3 can reuse for cleaner naming behavior
- PR 4 is mostly isolated backend configuration/policy work and can happen in parallel if desired

## Cross-PR Constraints

- Do not introduce duplicate output derivation rules in multiple files
- Do not hardcode overlay defaults in more than one place
- Do not change visual layout behavior without preserving preview-to-render parity
- Do not rewrite the queue scheduler in PR 4; only adjust default policy and validate existing behavior

## Definition of Done Across All PRs

- No broken TypeScript types
- Existing app flow still works for current outputs and render queue behavior
- New logic is covered by targeted verification or tests where practical
- Runtime verification confirms the changed behavior, not just static code edits
