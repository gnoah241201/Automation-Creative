# PR 4 Plan: Increase Default Render Concurrency

## PR Goal

Increase default backend render concurrency from 2 to 5 jobs, while preserving the existing queue scheduler, cancellation behavior, persistence/recovery behavior, and env-based configurability.

## Why This PR Exists

The current queue infrastructure already supports configurable concurrency. The bottleneck is policy, not architecture. The user wants to run 5-6 videos at once, so this PR should change the default behavior safely without rewriting the queue.

## Current Code Context

### Server bootstrap
`server/index.ts`

This file reads `MAX_CONCURRENT_JOBS` and instantiates `JobQueueService`.

### Queue scheduling
`server/services/jobQueue.ts`

This file enforces concurrency using:

- `pending`
- `activeCount`
- `maxConcurrentJobs`
- `schedule()`

It also handles:

- cancellation
- persistence
- restart recovery
- job terminal state transitions

### Render execution
`server/services/renderRunner.ts`

This file executes FFmpeg jobs and reports progress. It is relevant because higher concurrency changes runtime pressure.

## Required Outcome

After this PR:

1. Default max concurrent jobs is 5
2. Env override still works so operators can set a different value such as 6
3. Existing queue behavior remains intact
4. Recovery, cancel, retry, and progress behavior still work under the higher default

## In Scope

- Update default concurrency value in server bootstrap
- Preserve and validate environment override behavior
- Add or improve queue verification around multiple active jobs
- Update docs or README if runtime configuration is documented there

## Out of Scope

- Rewriting queue scheduling logic
- Changing FFmpeg command construction
- Adding GPU-aware adaptive scheduling
- Adding per-user or per-job priority classes

## Affected Files

Expected minimum touch points:

- `server/index.ts`
- optional tests around `server/services/jobQueue.ts`
- `README.md` if it documents concurrency defaults

## Required Edits

These edits are required unless a verified better equivalent exists:

1. Change the default fallback for `MAX_CONCURRENT_JOBS` in `server/index.ts` from 2 to 5
2. Preserve env override behavior exactly
3. Audit `server/services/jobQueue.ts` for hidden low-concurrency assumptions
4. Verify health/status output still exposes the configured max concurrency
5. Update README or runtime docs if the old default is documented anywhere

This PR should stay narrow. Any queue-internals rewrite requires separate justification and should normally be rejected for this scope.

## Implementation Tasks

### Task 1: Update default concurrency policy

Change the default fallback for `MAX_CONCURRENT_JOBS` from 2 to 5 in `server/index.ts`.

Requirement:

- Preserve explicit env override semantics

### Task 2: Audit queue assumptions

Review `server/services/jobQueue.ts` for any assumptions that accidentally depend on a low concurrency value.

Focus on:

- schedule loop behavior
- active process bookkeeping
- cancellation behavior
- persistence writes under more active jobs

This is an audit task first; only change code if a real issue is found.

### Task 3: Verify runtime observability

Ensure health or queue stats still surface the configured max concurrency clearly.

If already exposed, preserve it. If not obvious in logs or health output, improve only if low-risk.

### Task 4: Update runtime docs if needed

If `README.md` or other runtime guidance mentions the old default, update it.

### Task 5: Add verification for concurrent scheduling

At minimum, verify behavior for:

- 5 jobs queued with default config
- a 6th job waiting in queued state
- cancellation of one active job while others continue

If automated tests are practical, they should focus on queue scheduling semantics rather than FFmpeg-heavy integration.

## Edge Cases

- Machines with weaker CPU/GPU resources
- NVENC usage where encoder hardware may become saturated
- persisted jobs restored after restart under a higher configured concurrency
- multiple jobs failing quickly while scheduler continues draining the queue

## Acceptance Criteria

- Default server config allows 5 concurrent jobs
- Env override still controls the limit
- Queue still schedules, cancels, retries, and recovers correctly
- No regression in queue status reporting

## Non-Goals

The implementer must not do the following in this PR:

- rewrite `JobQueueService`
- add adaptive scheduling or GPU-aware heuristics
- change FFmpeg arguments to compensate for local machine limits
- silently reduce the requested default below 5 without evidence and stakeholder approval

## Verification Checklist

- Run diagnostics on modified backend files
- Run relevant backend tests if present
- Run typecheck / lint command used by the repo
- Start the server and confirm health/status reflects the new default
- Queue enough jobs to confirm 5 active and the next one pending

## Exact Verification Commands

Run these commands from repo root after implementation:

1. `npm run lint`
2. `npm run build`

Runtime verification required:

1. Start the server with no `MAX_CONCURRENT_JOBS` override and confirm health/status reports `5`
2. Queue enough jobs to observe 5 active jobs and at least 1 queued job
3. Repeat with an explicit env override such as `MAX_CONCURRENT_JOBS=6` and confirm the override is honored
4. Cancel one active job and verify the queue continues draining correctly

## Rollback Notes

If this PR causes queue instability under load, revert toward these safe conditions:

1. Restore only the default fallback value first
2. Keep any harmless observability/documentation improvements if they are accurate
3. Do not merge queue-audit refactors that change scheduling semantics without direct evidence they are needed

## Handoff Notes for the Implementer

- This PR is intentionally narrow; resist the urge to refactor queue internals unless a verified bug appears
- If you discover resource issues on the local machine, document them as environment capacity concerns, not as reasons to shrink the requested default without evidence
