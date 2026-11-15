# Replay baselines (Phase B, B4)

Before-numbers for the token cuts in `docs/plans/reliability-phase-b.md` (A1, A2, A5). Three
`plan-step-builder` tasks from the directAds readme-gap runs are frozen in
`lib/testdata/replay/readme-gap-step-{0,6,15}.json` (verbatim `handoff_prompt` plus `baseline`
numbers). Tokens are `ceil(chars / 4)`. Cost is in USD as reported by the provider.

| Step | Source (run / task) | Handoff tok | Turns | Tools | In | Out | cacheRead | cacheWrite | Denials |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 20261112-115613-08kici / t3-plan-step-builder | 420 | 4 | 3 | 10 | 1105 | 58079 | 20506 | 1 |
| 6 | 20261112-150722-ta7m95 / t8-plan-step-builder | 459 | 22 | 28 | 46 | 17522 | 1021966 | 46382 | 0 |
| 15 | 20261112-150722-ta7m95 / t23-plan-step-builder | 755 | 18 | 31 | 38 | 23587 | 952902 | 85367 | 0 |

Median handoff: 459 tokens (A2 target: <= 350). Step 0's one denial: a `cp` whose path resolved
outside the repository.

## How it was produced

The source run dirs are in `~/Code/directAds/.foreman/runs/<run>/`. Those tasks predate the run-json
`usage` field, so `node scripts/trace-report.mjs <run-dir> --json` recomputed usage from each task's
`.events.jsonl` (the events files are not copied here; they are 200-300 KB each and `lib/testdata`
is excluded from the package). The task's `plan_step`, `handoff_prompt` and the report's numbers were
written into the fixture. Running `trace-report.mjs <source-run-dir> --baseline lib/testdata/replay`
on the sources prints all-zero deltas for these three tasks (checked when the fixtures were made).

## Manual replay procedure (after-merge check, not a gate)

1. In the directAds repo, check out the commit the original step started from (the run's
   `ledger.log` and the plan's step list name it) and dispatch the same three plan steps (0, 6, 15) with
   the changed foreman.
2. Run `node scripts/trace-report.mjs <new-run-dir> --baseline lib/testdata/replay`. Each row is
   matched by `(role, plan_step)` and prints `current - baseline` for handoff tokens, turns, tool calls,
   in/out/cache and guard denials.
3. Compare the worker reports (files touched, checks run, status) against the originals in
   `<source-run>/<task>.md`. Lower tokens with a different outcome is a regression, not a win.
4. Watch `cacheWrite`: if it grows by more than the handoff pruning (A1) saves, widen the kept window.
