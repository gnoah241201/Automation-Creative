# Duration-Tiered Long-Form Outputs — Design

Date: 2026-07-27

## Goal

Add longer trimmed-length output variants to the resize feature, gated on the
input (foreground) video duration. These apply to **both** input ratios
(`16:9` and `9:16`) and only to the `9:16` and `16:9` output ratios — never
`4:5` or `1:1`.

| Input duration `d` (seconds) | Add output length | Output ratios |
|---|---|---|
| `d > 70`  | 60s  | `9:16` + `16:9` |
| `d > 100` | 90s  | `9:16` + `16:9` |
| `d > 130` | 120s | `9:16` + `16:9` |

Thresholds are strict (`>`), consistent with the existing 30s rule
(`fgDuration > 35`). `d = 70` gets no 60s variant; `d = 71` does.

"60s output" means the **first 60 seconds** of the video (cut from the start),
consistent with the existing 6s/15s/30s cuts and the server trim command
(`-t <duration> -c copy`).

## Scope

The entire change lives in `src/render/outputDerivation.ts` (the
`deriveOutputs()` function) plus its tests. No changes are needed to:

- `src/App.tsx` — the download modal auto-lists whatever `deriveOutputs()`
  returns, and the existing trim orchestration (group by `trimFrom` source,
  wait for the source primary job, then submit a trim) already handles both
  dependency shapes this feature introduces.
- `server/**` — `buildTrimCommand` already trims the first N seconds via
  `-i input -t <duration> -c copy` (stream copy, no re-encode).

## Production mechanism

Let `R` = the input ratio and `C` = the other primary ratio (`16:9 ↔ 9:16`).

- **Cross-ratio (`C`) variants** — trim from the existing full-length primary
  of ratio `C` (`trimFrom: 'C'`). For a `16:9` input the full `9:16` primary
  exists; for a `9:16` input the full `16:9` primary exists. These are pure
  stream-copy trims, no extra encode. The full source length (`fgDuration`) is
  always `>` the trim length by construction (e.g. 120s trim only added when
  `d > 130`), so every trim has enough source.

- **Same-ratio (`R`) variants** — there is no full-length same-ratio primary to
  trim from, so:
  1. Render the **longest active tier** as a real (re-encoded) primary output —
     the "master" (`isLongFormExtension: true`, no `trimFrom`).
  2. Trim the shorter active tiers from that master
     (`trimFrom: '<R>-<masterSeconds>s'`), stream copy.

  This yields exactly **one** extra same-ratio encode for the whole new tier
  block, regardless of how many tiers are active.

The existing 30s same-ratio output (`isLongFormExtension`, real render) is left
untouched — it is **not** folded into the new master. This keeps the change
purely additive and avoids disturbing existing behavior/tests. (Folding 30s
into the master to save one more encode is a possible future optimization,
explicitly out of scope here.)

## Output IDs and labels

Following the existing convention:

- id: `<ratio>-<seconds>s` — e.g. `16:9-60s`, `9:16-90s`, `16:9-120s`
- label: `Output: <ratio> (<seconds>s cut)` — e.g. `Output: 16:9 (60s cut)`
- `showPreview: false` for all new variants (no preview box, same as 30s)
- Same-ratio master: `isLongFormExtension: true`, no `trimFrom`
- Same-ratio shorter + all cross-ratio: `trimFrom` set as above

## Worked examples

### Input `16:9` (R = 16:9, C = 9:16)

| `d` | Active tiers | New outputs |
|---|---|---|
| 75  | {60}       | `16:9-60s` (master render); `9:16-60s` (trim `9:16`) |
| 105 | {60, 90}   | `16:9-90s` (master); `16:9-60s` (trim `16:9-90s`); `9:16-90s`, `9:16-60s` (trim `9:16`) |
| 140 | {60,90,120}| `16:9-120s` (master); `16:9-90s`, `16:9-60s` (trim `16:9-120s`); `9:16-120s`, `9:16-90s`, `9:16-60s` (trim `9:16`) |

### Input `9:16` (R = 9:16, C = 16:9)

Mirror of the above with R/C swapped: same-ratio masters are `9:16-*`, trimmed
shorter `9:16-*` come from the `9:16` master, and cross-ratio `16:9-*` trim from
the full `16:9` primary.

## Known limitation (pre-existing)

A trim output depends on its source primary actually being rendered. The
download modal defaults to selecting **all** outputs (including masters), so the
normal flow always works. If a user manually deselects a same-ratio master but
keeps a dependent shorter trim, that trim will fail/time out — identical to the
existing limitation for the `30s ↔ full` dependency. Not addressed in this
change.

## Testing

`test/output-derivation.test.ts`:

- **Fix pre-existing failures:** two assertions (currently failing on `main`)
  expect the pre-"Rule B" behavior where a `16:9`/`9:16` input above 35s does
  not include the cross-ratio 30s variant. The code has since added cross-ratio
  30s variants. Update these assertions to match actual behavior.
- **New tier boundaries:** at `d = 70` no 60s; at `d = 71` both `9:16-60s` and
  `16:9-60s` appear. Same for 100/90 and 130/120.
- **Master selection:** the longest active same-ratio tier is a real render
  (no `trimFrom`); shorter same-ratio tiers `trimFrom` that master.
- **Cross-ratio trims:** cross-ratio long variants `trimFrom` the full-length
  cross primary (`9:16` or `16:9`).
- **Exclusions:** no `4:5-60s/90s/120s` or `1:1-60s/90s/120s` are ever produced.
- Cover both input ratios.
