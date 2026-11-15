# Implementation Plan: foreman-pi reliability audit, Phase B (token cuts)

Branch: `feat/foreman-reliability` (Phase A merged at `b1b55b2`, package 0.3.4 + Unreleased); the foreman may cut a new branch from it. Source of truth for each item's gap and task: `PLAN.md`, section "Architecture & Token Efficiency Audit Improvements" (items B4, A1, A2, A5, A3 and "Suggested order" Phase B). This plan only adds the concrete files, tests and acceptance; it does not restate that prose.

## Overview

Phase B cuts orchestrator and worker tokens, measurably. B4 comes first: per-worker usage lands in the run json and `scripts/trace-report.mjs` prints the audit table, with three replay fixtures from the directAds readme-gap run as the before-numbers. Then A1 (stale `foreman_delegate` handoffs pruned from context), A2 (coordinator-appended worker footer, slimmer template), A5 (`scripts/run-suites.mjs`, filtered test output) and A3 (compaction that keeps run state). 11 required steps plus 1 optional; strictly sequential, each ends green on `npm test` and is independently mergeable.

## Conventions

- Step line format `N. **Title** (Touches: ...)` is what `lib/plan-steps.ts` parses (`parseStepTitle`, `parseTouches`, `findParallelOverlaps`); no other numbered bold lines appear here. There is no `## Parallel` section: steps 1, 4, 5 and 12 all edit `extensions/coordination/{coordinator,index,spawn-worker}.ts`, and `package.json`/READMEs are shared by most steps.
- `Checks` are exact npm scripts plus named tests the step adds. Every step also runs `npm run typecheck` (part of `npm test`). Every new `*-test.ts` gets an npm script and joins the `test` chain in `package.json`.
- Do not touch `extensions/model-fallback/`, `AGENTS.md`, or the pinned "Model fallback" section of the READMEs (`lib/readme-test.ts` pins its sha256). New env vars go in the env tables of `README.md` and `README.pt-BR.md` (existing context-filter rows `FOREMAN_CONTEXT_*`), outside that section.
- Token proxy used everywhere (trace-report, fixtures, acceptance): `tokens = ceil(chars / 4)`, the same convention as the PLAN.md baseline.
- Worker commands stay guard-friendly: one literal command per suite, scratch under `.foreman/`.

## Pre-flight (builder of step 1 records the output in its report)

- `git branch --show-current` is the plan branch; `git status --short` is clean apart from `.foreman/`; `npm test` is green on the untouched tree. If anything fails, record failing names in `.foreman/baseline.txt` and diff later with `node scripts/baseline-diff.mjs .foreman/baseline.txt` (shared worker rule); do not start on an unexplained failure.
- `node --version` is >= 22.19 (`engines`). No step imports `.ts` from a `.mjs` script: scripts are plain JS and self-contained, like `scripts/baseline-diff.mjs`.
- The replay sources exist: `~/Code/directAds/.foreman/runs/20261112-115613-08kici/t3-plan-step-builder.json` (readme-gap step 0), `.../20261112-150722-ta7m95/t8-plan-step-builder.json` (step 6), `.../20261112-150722-ta7m95/t23-plan-step-builder.json` (step 15), each with a sibling `.events.jsonl`. If any is missing, step 3 reports `Status: blocked` naming it; do not fabricate fixtures.
- Verified while planning (read, not assumed): `extensions/context-filter/index.ts` (`pruneMessages`, one `context` handler, no `session_before_compact`); `extensions/coordination/coordinator.ts` (`writeMeta` already stores `handoff_prompt`; `startTask` feeds `onEvent` into the activity tracker; `finishTask` writes meta; `persist` appends `foreman-task` entries with `runId, taskId, role, planStep, planSlug, state, output, summary`); `extensions/coordination/index.ts` (tool result text is `{task_id, state, ack}`, `details` carries `run_id`); `extensions/coordination/spawn-worker.ts` (`promptText = inlineOrPointerPrompt(...)`, `buildArgs` prepends `Task:` and the resume preamble); `lib/activity.ts` (non-exported `DENIAL_PREFIX`); `lib/retry.ts` (the final `PiRunResult` holds only the last attempt's messages); `lib/spawn.ts` (the events log appends `message_end` lines across attempts; `message_end` assistant messages carry `usage {input, output, cacheRead, cacheWrite, cost.total}`, seen in `.foreman/runs/*/*.events.jsonl`); pi docs `compaction.md` and `extensions.md` (`session_before_compact` returns `{cancel}` or `{compaction: {summary, firstKeptEntryId, tokensBefore, details?}}`; `event.branchEntries` is every entry on the branch).

## Architecture changes

- New `lib/usage.ts`: pure per-worker usage tally; `extensions/coordination/coordinator.ts` writes it to `<task>.json` (B4).
- New `scripts/trace-report.mjs`, `lib/testdata/replay/*`, `docs/replay-baselines.md` (B4).
- `extensions/context-filter/index.ts`: handoff pruning in the `context` handler (A1).
- New `lib/handoff-footer.ts`, `extensions/coordination/spawn-worker.ts`, `templates/*handoff-prompt.md`, both skills (A2).
- New `scripts/run-suites.mjs`, agent files and `references/worker-common.md` (A5).
- New `extensions/context-filter/compaction.ts`, registered from `index.ts` (A3).

## Steps

1. **B4: usage tally and run-json usage** (Touches: `lib/usage.ts`, `lib/usage-test.ts`, `lib/activity.ts`, `extensions/coordination/coordinator.ts`, `extensions/coordination/smoke-test.ts`, `package.json`)
   - Item: B4 (persist per-worker usage).
   - Action: export `DENIAL_PREFIX` from `lib/activity.ts` (no behaviour change). New `lib/usage.ts`: `createUsageTally()` with `feed(event)` and `snapshot()`; it reads only `message_end` events (O(1), safe on the hot path), sums assistant `message.usage` (`input, output, cacheRead, cacheWrite, cost.total`), counts `turns` (assistant messages), `toolCalls` (`toolCall` content parts), `attempts` (`noteAttempt()`), `firstRequestTokens` (input+cacheRead+cacheWrite of the first assistant message, the A4-style comparison number) and `guardDenials: {total, byReason}` from `toolResult` messages with `isError` and text starting `DENIAL_PREFIX` (reason key = text after the prefix up to the first sentence end, capped 120 chars). Also export `tokensOf(text)` and `median(numbers)`. In `coordinator.ts`: create the tally in `startTask`, feed it from the existing `onEvent` closure and call `noteAttempt` from `onAttempt` (so resumed attempts accumulate, which the final `PiRunResult` cannot give), and add `usage: snapshot` to the `writeMeta` call in `finishTask`. Unknown or malformed events are ignored.
   - Why: B4 needs usage in the run json; deriving it from `r.messages` would lose earlier attempts.
   - Risk: low-medium (hot path; a throw must never break the stream: wrap the feed like the activity feed).
   - Checks: `npm run test:usage` (new), `npm run test:coordination`. Named tests: `tally sums usage across two assistant messages`, `tally ignores non-message_end and malformed events`, `tally counts guard denials by reason`, `tally accumulates across attempts`, `usage tally on lib/testdata/worker-stream.jsonl matches hand-counted totals`, `coordinator meta json has usage after finish`, `usage feed throwing does not fail the task`.
   - Renders: no

2. **B4: trace-report script** (Touches: `scripts/trace-report.mjs`, `lib/trace-report-test.ts`, `lib/testdata/trace/`, `references/diagnosing-a-run.md`, `package.json`)
   - Item: B4 (`trace-report.mjs <run-dir>` prints the audit table).
   - Action: plain-JS CLI `node scripts/trace-report.mjs <run-dir> [--baseline <dir>] [--json]`. Per task from `<task>.json`: role, plan_step, state, handoff tokens (`tokensOf(handoff_prompt)`), turns, tool calls, in/out/cacheRead/cacheWrite, cost, guard denials. Use `usage` from the json when present; for runs that predate step 1 recompute it from `<task>.events.jsonl` with an inline aggregator (skip the leading `role: system` line). Footer: totals, per-role totals, median handoff tokens, top denial reasons. With `--baseline <dir>`, match tasks to the fixtures from step 3 by `(role, plan_step)` and print deltas. Unreadable files are skipped with one `skipped:` line, never a crash. Add a short "Measuring a change" section to `references/diagnosing-a-run.md` (how to run it, what each column means). The inline aggregator duplicates `lib/usage.ts` on purpose (the script ships to plain `node`); the test below is the drift guard.
   - Why: the audit table must be reproducible, not hand-built.
   - Dependencies: requires step 1.
   - Risk: low.
   - Checks: `npm run test:trace-report` (new; spawns the script as a child process on a small synthetic run dir under `lib/testdata/trace/` and on a temp dir). Named tests: `table lists one row per task`, `legacy run without usage is recomputed from events.jsonl`, `parity: script totals equal createUsageTally totals on the same events file`, `--json output parses`, `missing events file is skipped, exit 0`, `--baseline prints deltas`, `median handoff tokens correct`.
   - Renders: no

3. **B4: replay fixtures and recorded baselines** (Touches: `lib/testdata/replay/`, `lib/replay-fixtures-test.ts`, `docs/replay-baselines.md`, `package.json`)
   - Item: B4 (3 replay fixtures: readme-gap steps 0, 6, 15).
   - Action: from the three source tasks in the pre-flight, write `lib/testdata/replay/readme-gap-step-{0,6,15}.json` holding `source` (run id, task id), `role`, `plan_step`, the verbatim `handoff_prompt`, and `baseline` (the numbers `trace-report.mjs` prints for that task's events: handoff tokens, turns, tool calls, in/out/cache, guard denials by reason). Do not copy the events files (200-300 KB each; `lib/testdata` is excluded from the package). Write `docs/replay-baselines.md`: the table, how it was produced, and the manual replay procedure (re-run the same three steps on the directAds repo at the matching commit, run trace-report with `--baseline`, compare worker reports). Ruling: a new doc, not `docs/verification-log.md`, which is marked historical.
   - Why: gives A1, A2 and A5 a before-number to compare against.
   - Dependencies: requires step 2.
   - Risk: low (blocked only if the sources are gone; see pre-flight).
   - Checks: `npm run test:replay` (new). Named tests: `each fixture parses and has role, plan_step, handoff_prompt, baseline`, `fixture handoff token counts equal baseline.handoffTokens`, `fixtures cover steps 0, 6 and 15`.
   - Renders: no

4. **A1: prune old foreman_delegate handoffs from context** (Touches: `extensions/context-filter/index.ts`, `extensions/context-filter/smoke-test.ts`, `extensions/coordination/index.ts`, `extensions/coordination/smoke-test.ts`, `README.md`, `README.pt-BR.md`)
   - Item: A1.
   - Action: in `context-filter/index.ts` add `pruneHandoffs(messages)` and call it in the `context` handler next to `pruneMessages` (both pure, input never mutated: clone each changed message). Latest turn = every assistant message after the last `user` message or last `foreman-task-notification` message; calls there keep full text. For older assistant `toolCall` parts named `foreman_delegate` whose `arguments.handoff_prompt` is longer than 300 chars, replace only that field with `[handoff pruned: <N> chars; full text in .foreman/runs/<run_id>/<task_id>.json (handoff_prompt); role=<role> step=<plan_step>]`. `<run_id>/<task_id>` come from the matching `toolResult` (by `toolCallId`): `details.run_id`/`details.task_id`, else the JSON in its text. No matching result, an error result or no ids: leave the call untouched (never prune what cannot be pointed to). `role`, `plan_slug`, `plan_step` stay as they are. The stub is a pure function of the call, so a pruned message is byte-stable on every later turn (prompt-cache friendly). In `coordination/index.ts` add `run_id` to the tool result text (`{task_id, run_id, state, ack}`) so the stub never depends on `details` surviving. `FOREMAN_CONTEXT_PRUNE_HANDOFFS=false` disables it; `FOREMAN_CONTEXT_PRUNE=false` still disables everything; `FOREMAN_CONTEXT_DEBUG=1` also logs handoffs pruned. Document the variable in both README context-filter tables.
   - Why: ~28k tokens of dispatch text sit in the directAds transcript although the run json has them.
   - Dependencies: requires step 3 (sequential on shared files).
   - Risk: medium (rewriting mid-transcript content moves the cache boundary once per turn; stable stub text limits it to that single move; see Risks).
   - Checks: `npm run test:context-filter`, `npm run test:coordination`. Named tests: `5 dispatches over 5 turns: only the last turn keeps full handoff`, `dispatches in the same latest turn all keep full text`, `pruned stub names run, task, chars, role and step`, `pruning twice yields identical output (idempotent)`, `call without result or with error result is untouched`, `short handoff (<=300 chars) untouched`, `FOREMAN_CONTEXT_PRUNE_HANDOFFS=false disables`, `input messages not mutated`, `delegate result text includes run_id`, `notification pruning still behaves as before`.
   - Renders: no

5. **A2: coordinator-appended worker footer** (Touches: `lib/handoff-footer.ts`, `lib/handoff-footer-test.ts`, `extensions/coordination/spawn-worker.ts`, `extensions/coordination/smoke-test.ts`, `package.json`)
   - Item: A2 tasks (1) and (3).
   - Action: new pure `lib/handoff-footer.ts`: `workerFooter({locale, cwd})` returns at most ~6 short English lines: `User language: <en|pt-BR>.` (the exact label, so agents that read the handoff's `User language:` keep working; "if the handoff above names another language, follow that"), "Orchestrator mode does not apply to you; proceed normally", `Working directory: <cwd>`, and "The guard and report rules are the Shared worker rules in your system prompt". Locale comes from `detectLocale()` in `lib/i18n.ts`; the footer prose itself stays English (handoffs are English per `skills/foreman/SKILL.md`). `composeTaskArg({handoff, resume, footer})` builds the `Task:` argument (resume preamble first, footer last). In `spawn-worker.ts`, append the footer after `inlineOrPointerPrompt` (so an oversized handoff still gets it) and pass the final `cwd` (the isolated worktree when isolated); `buildArgs` calls `composeTaskArg`. The run json keeps the raw orchestrator text (`t.prompt`), so the A1 stub and trace-report measure what the orchestrator wrote.
   - Why: the footer is written once by code instead of 44 times as orchestrator output tokens.
   - Dependencies: requires step 4.
   - Risk: low-medium (`spawn-worker.ts` has no behavioural test; the logic is in the pure helper, the wiring is two lines).
   - Checks: `npm run test:handoff` (new), `npm run test:coordination`. Named tests: `footer contains language, mode and workdir lines`, `pt-BR locale yields pt-BR`, `footer is under 90 tokens`, `composeTaskArg puts resume preamble before handoff and footer last`, `pointer-prompt handoff still gets the footer`, `isolated cwd appears in the footer`, `compose: every worker prompt still has the contract marker` (existing check at `extensions/coordination/smoke-test.ts:829`, unchanged).
   - Renders: no

6. **A2: slim handoff templates, skill rules, slim-fixture gate** (Touches: `templates/handoff-prompt.md`, `templates/review-handoff-prompt.md`, `templates/release-handoff-prompt.md`, `skills/foreman/SKILL.md`, `skills/plan-runner/SKILL.md`, `extensions/orchestrator-guardrail/instructions-test.ts`, `lib/testdata/replay/`, `lib/replay-fixtures-test.ts`)
   - Item: A2 tasks (2), (3), (4).
   - Action: in the three templates delete the `User language` section and `About orchestrator mode` (with its anecdote), and the role blurb in `handoff-prompt.md`; keep Task/Build instructions/Grilled requirement/Decided context/Deliverable/Constraints. Say in the template header what the coordinator appends. Update `skills/foreman/SKILL.md` (Language rule near line 21 and §4 near line 156) and `skills/plan-runner/SKILL.md` (§2 near line 112, the `User language:` bullet, and line 19): the orchestrator writes only the deltas; the footer carries language/mode/workdir; add one line in Constraints only when the user's language differs from the machine locale. No `handoff_file` parameter (PLAN.md A2 task 4). Update the assertions in `extensions/orchestrator-guardrail/instructions-test.ts` that grep the old sections (lines 70, 71, 114, 139, 140 as read while planning) to the new contract: the template mentions the footer, the footer helper carries `User language:` and the mode line. Gate: for each replay fixture write `readme-gap-step-N.slim.md`, the same handoff rewritten to the new template keeping every task-specific fact (paths, decisions, constraints) and dropping only what the footer, `worker-common.md` and the agent file already carry.
   - Why: PLAN.md A2 acceptance: median handoff <= 350 tokens.
   - Dependencies: requires step 5.
   - Risk: medium (prompt wording; reviewer/shipper agents refer to `User language:` in the handoff, which the footer now provides).
   - Checks: `npm run test:instructions`, `npm run test:agents`, `npm run test:replay`. Named tests: `slim fixtures: median tokens <= 350` (reported with the three numbers; if a fixture cannot get there without dropping a task fact, report the real number, do not force), `slim fixtures keep every path named in the original`, `templates no longer contain About orchestrator mode`, `handoff template still has Build instructions`, `skills reference the footer`.
   - Renders: no

7. **A5: run-suites script** (Touches: `scripts/run-suites.mjs`, `lib/run-suites-test.ts`, `package.json`)
   - Item: A5 (script half).
   - Action: plain-JS CLI `node scripts/run-suites.mjs [--cwd DIR] [--python ABS] [--pyright ABS --baseline FILE] [--timeout-s N] <suite>...`. A suite is explicitly prefixed: `py:<path>` (run with `--python`), `node:<path>`, `npm:<script>` (`npm run <script>`); anything else exits 2 with usage. Run with `spawn`, `shell: false`, serially, per-suite timeout (default 600 s, `--timeout-s`). Full output to `<cwd>/.foreman/qa-logs/<sanitised suite>.log`. Stdout: one line per suite (`PASS <name> 12.3s` / `FAIL <name> 4.1s`), for a failure the failing test names (best-effort parse of pytest `FAILED x::y`, node:test `not ok N - name`, unittest `FAIL: name`, this repo's `FAIL - name`) and the last 30 lines (each capped 300 chars), then `N passed, M failed`; exit 1 on any failure, 2 on usage error. `--pyright ABS` runs `<ABS> --outputjson`, turns `generalDiagnostics` errors into `file:line rule message` names and pipes them to `scripts/baseline-diff.mjs` with `--baseline`, printing its `NEW:`/`FIXED:` lines verbatim (exit 1 on NEW); without `--baseline` it prints the error count only. The script runs only the named suites; the guard cannot see inside it (documented limit, step 8).
   - Why: one literal guard-friendly command replaces 17 loops and keeps suite output out of context.
   - Dependencies: requires step 6 (sequential; no shared files except `package.json`).
   - Risk: medium (child-process handling; pyright JSON shape is assumed, see Risks).
   - Checks: `npm run test:run-suites` (new; black-box on temp-dir fixture suites written by the test, including a fake pyright script emitting JSON). Named tests: `pass suite prints one PASS line and exits 0`, `failing suite prints names, tail 30 and exits 1`, `full log written under .foreman/qa-logs`, `timeout kills the suite and reports FAIL`, `unprefixed suite exits 2`, `suites run serially in the order given`, `pyright baseline: only NEW errors fail`, `long lines are capped`.
   - Renders: no

8. **A5: point workers at run-suites** (Touches: `references/worker-common.md`, `references/worker-guard.md`, `agents/qa.md`, `agents/qa-bugfix.md`, `agents/plan-step-builder.md`, `extensions/orchestrator-guardrail/instructions-test.ts`, `lib/agents-test.ts`)
   - Item: A5 (docs half).
   - Action: add a short "Running test suites" block to `references/worker-common.md` (at most 6 lines, to leave room for B1's size target in Phase C): the literal command with `{{PACKAGE_ROOT}}/scripts/run-suites.mjs`, one line for `--pyright`, "read `.foreman/qa-logs/<suite>.log` only for a failing suite". Add the matching line to the three agent files in place of ad-hoc loops. In `references/worker-guard.md` "Honest limits": the script's child processes are not judged by the guard, it only runs the suites named on the command line. The reviewer never runs it (read-only role).
   - Why: without wiring, workers keep running suites directly.
   - Dependencies: requires step 7.
   - Risk: low.
   - Checks: `npm run test:agents`, `npm run test:instructions`, `npm run test:coordination` (compose test reads `worker-common.md`). Named tests: `worker-common names run-suites with a literal command`, `qa, qa-bugfix and plan-step-builder reference run-suites`, `worker-common stays under 1100 tokens`.
   - Renders: no

9. **A3: pure run-state summary builder** (Touches: `extensions/context-filter/compaction.ts`, `extensions/context-filter/smoke-test.ts`)
   - Item: A3 (summary content).
   - Action: `buildRunState(input): string`, pure (inputs passed in: `branchEntries`, a file reader, a git-branch probe, `now`). Sections, each capped, total <= 12,000 chars, deterministic truncation: (a) header marking it a foreman-built state summary; (b) run: run id(s), plan slug and path, workdir (from the newest task's `.foreman/runs/<run>/<task>.json`, else cwd) and branch; (c) step table: the plan's `## Status` lines (`- Step N: <state>`) when present, else the newest `foreman-task` entry per `planStep`; (d) in-flight and queued tasks, then blocked/failed tasks with their `output` path and 200-char summary (an entry is in flight when no later entry for the same task id has a terminal state); (e) rulings (`details.notifications[].rulings` of `foreman-task-notification` entries, deduplicated, newest 20) and unresolved items (`blockedOn`, `guardDenied` of non-completed notifications); (f) `FOREMAN_MEMORY.md` "Decisions log" section (first 2,000 chars) or its path; (g) the user's last 8 text messages (300 chars each, taken from `type: "message"` entries so earlier compactions do not lose them); (h) a recovery line: read the plan Status and `.foreman/runs/<run>/ledger.log`, do not re-dispatch merged steps. Missing or unreadable sources drop their section, never throw.
   - Why: PLAN.md A3: the summary comes from data we own, not an LLM pass.
   - Dependencies: requires step 8.
   - Risk: medium (relies on entry shapes read in `coordinator.ts` `persist()` and `index.ts` `agent_settled`; shapes are asserted in tests).
   - Checks: `npm run test:context-filter`. Named tests: `summary names plan, workdir, branch and step table`, `plan Status wins over entries; entries used when no Status`, `blocked task listed with output path`, `in-flight task listed, finished one not`, `rulings deduplicated and capped`, `user messages survive a second compaction (taken from branchEntries)`, `output length <= 12000 chars on a 500-entry fixture`, `missing plan or memory file drops only that section`, `same input yields identical output`.
   - Renders: no

10. **A3: register session_before_compact, document settings** (Touches: `extensions/context-filter/index.ts`, `extensions/context-filter/compaction.ts`, `extensions/context-filter/smoke-test.ts`, `README.md`, `README.pt-BR.md`)
   - Item: A3 (wiring, fallback, docs).
   - Action: register `pi.on("session_before_compact", ...)` from `index.ts`. Use `createModeTracker(pi)` (`lib/mode.ts`): not in orchestrator mode, a subagent, or no `foreman-task` entry and no plan found: return `undefined` so pi's default compaction runs. Otherwise return `{compaction: {summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details: {foremanRunState: true}}}`. Any exception: return `undefined` (and log under `FOREMAN_CONTEXT_DEBUG=1`). `FOREMAN_CONTEXT_PRUNE=false` also disables it. README "Context filter" section (both languages): what the summary holds, that it replaces pi's LLM summary only in orchestrator mode, and recommended `compaction.reserveTokens` / `compaction.modelOverrides["<provider>/<model>"].reserveTokens` (compaction starts when `contextTokens > contextWindow - reserveTokens`, so `reserveTokens = contextWindow - 100000` starts near 100k; pi default 16384). The package does not write the user's `settings.json`.
   - Why: the directAds orchestrator reached 148k with no compaction and the user typed `resume` six times.
   - Dependencies: requires step 9.
   - Risk: medium (first custom compaction in this package; fallback must be proven).
   - Checks: `npm run test:context-filter`, `npm run test:readme`, `npm run test:mode`. Named tests (fake `ExtensionAPI` + fake session as in the existing smoke test): `handler returns undefined outside orchestrator mode`, `handler returns undefined in a subagent`, `handler returns a compaction with firstKeptEntryId and tokensBefore from preparation`, `builder throwing falls back to undefined`, `FOREMAN_CONTEXT_PRUNE=false disables compaction`, `README documents reserveTokens in both languages`.
   - Renders: no

11. **Close-out: changelog, layout, package check** (Touches: `CHANGELOG.md`, `README.md`, `README.pt-BR.md`, `scripts/check-package.ts`, `package.json`)
   - Action: CHANGELOG "Reliability Phase B" under Unreleased (Added: trace-report, usage in run json, run-suites, run-state compaction, `FOREMAN_CONTEXT_PRUNE_HANDOFFS`; Changed: handoff footer and slimmer templates, stale handoffs pruned). README Layout section (both languages) lists `scripts/run-suites.mjs`, `scripts/trace-report.mjs`. Confirm `package.json` `files` lists both scripts (and, being under `scripts/`, they are not covered by the existing globs); add them to `REQUIRED_FILES` in `scripts/check-package.ts`. No version bump unless the foreman asks.
   - Dependencies: requires step 10.
   - Risk: low.
   - Checks: `npm test`, `npm run test:package` (needs `pi`; if absent report it as skipped, not passed).
   - Renders: no

12. **Optional: safe Phase A leftovers** (Touches: `extensions/coordination/coordinator.ts`, `extensions/coordination/smoke-test.ts`, `extensions/worker-guard/vars.ts`, `extensions/worker-guard/smoke-test.ts`)
   - Action (all three are low-risk and file-compatible with this phase; skip the step if the foreman wants a pure token phase): (a) move the misplaced `gitStatusShort` doc comment in `coordinator.ts` (it currently sits above `isDir`); (b) surface `workdir_fallback` as a one-line `workdir-fallback:` in the notification block via `formatBlock` (today it only reaches the meta json); (c) probe the `expandForLoop` `printf -v` suspicion: `grep -n printf extensions/worker-guard/vars.ts` showed no `printf` while planning, so first reproduce the claimed bypass through `checkBash`; if it does not reproduce, add a regression test asserting the denial and stop; if it does, report `Status: blocked` with the repro instead of patching in this step.
   - Dependencies: requires step 11.
   - Risk: low.
   - Checks: `npm run test:coordination`, `npm run test:worker-guard`. Named tests: `formatBlock shows workdir-fallback only when set`, `for-loop printf -v case is judged on the resolved path or denied`.
   - Renders: no

## Testing strategy

- Per step: the named tests above fail first, then pass; `npm test` green at every step (typecheck included). Black-box script tests (steps 2, 7) spawn the script with `node` on temp-dir fixtures, so they exercise the shipped file.
- Error and partial states are tests, not afterthoughts: malformed events (1), missing events/usage and unreadable files (2), unprunable handoffs (no result, error result, no ids) (4), oversized handoff pointer (5), suite timeout, unknown suite, pyright without a baseline (7), missing plan/memory file and any builder exception (9, 10). There is no UI; `Renders: no` throughout, and `/foreman-status` and the widget are untouched.
- Replay: steps 3 and 6 are offline (fixture sizes and the slim-handoff median). The behavioural replay (same three steps re-run end to end, worker reports compared) and a real `/compact` are after-merge manual checks, not gates (see Risks).
- Guard check after step 7: a worker role runs `node <pkg>/scripts/run-suites.mjs --cwd <repo> npm:test:retry` through the real guard (the `qa` role is allowed `node`; the reviewer is not) to confirm the one-literal-command claim.

## Risks & open questions

- **Prompt-cache cost of rewriting old messages (A1).** Changing an older message invalidates the cached prefix from that point. Mitigations: the stub is deterministic and idempotent, only the previous turn's handoffs transition each turn, and handoffs are near the end of the prefix. Measure `cacheWrite` with trace-report before/after; if it grows more than it saves, raise the kept window to two turns.
- **`toolResult.details` in `context` messages is assumed.** Step 4 reads it and falls back to the result text, which now carries `run_id`. If neither parses, nothing is pruned (fail safe).
- **Footer language is the machine locale (`detectLocale`), not the conversation language.** PLAN.md A2 says "from `lib/i18n.ts`". A user chatting in pt-BR with `LANG=en` gets an English footer; the skill tells the orchestrator to add one Constraints line in that case. Ruling flagged for the foreman: no new `language` parameter on `foreman_delegate` (it would cost schema tokens in every request).
- **The 350-token target may not hold for step handoffs with real task facts.** Step 6 reports the measured median honestly; the plan-runner pointer style (name the plan and step, carry only deltas) is what gets it there.
- **`pyright --outputjson` and its `generalDiagnostics` shape are assumed (not run here).** The step 7 test uses a fake emitter built on that assumption; confirm on one real pyright run in the first QA pass after merge.
- **Custom compaction shape** (`{compaction: {summary, firstKeptEntryId, tokensBefore, details}}`, `branchEntries` including pre-cut message entries) is taken from pi 1.5.2 docs, not run. Step 10's fake-session test only proves our side. After merge, run `/compact` in a real orchestrated session and check the next dispatch is coherent; also unverified: how the `pi-claude-cli` provider treats a replaced summary.
- **Run-json `usage` for orphaned or aborted workers is absent** (written only in `finishTask`); trace-report falls back to the events log for those.
- **Planning-time limit:** the planner guard denied `node`, so `node --version`, the type-stripping behaviour and a baseline `npm test` were not run while planning. Pre-flight covers them; the plan avoids depending on them (scripts are plain JS).
- **Acceptance that needs a real run** (after-merge manual, not gates): median handoff <= 350 tokens on a real replay, worker output unchanged on three replayed steps, coherent post-`/compact` dispatch, `cacheWrite` not regressing.

## Success criteria

- [ ] `<task>.json` carries `usage` (tokens, turns, tool calls, denials by reason, attempts) and `trace-report.mjs <run-dir>` prints the audit table, including for old runs (steps 1 to 2)
- [ ] Three replay fixtures and recorded baselines exist; `--baseline` prints deltas (step 3)
- [ ] Only the latest turn's `foreman_delegate` handoffs keep full text in context; stubs point at the run json; `FOREMAN_CONTEXT_PRUNE_HANDOFFS=false` restores the old behaviour (step 4)
- [ ] Every worker prompt ends with the coordinator footer; templates carry no language or orchestrator-mode boilerplate; slim fixtures' median is <= 350 tokens or the real number is reported (steps 5 to 6)
- [ ] `run-suites.mjs` prints one line per suite plus failures, logs to `.foreman/qa-logs/`, exits non-zero on failure, and qa/qa-bugfix/builder docs point to it (steps 7 to 8)
- [ ] In orchestrator mode `session_before_compact` returns a run-state summary; every error path falls back to pi's default; README documents `reserveTokens` guidance in both languages (steps 9 to 10)
- [ ] `npm test` and `npm run test:package` pass; CHANGELOG, READMEs and package `files` updated (step 11)

## Status

Source of truth for plan-runner; mark a step `merged` only when it is on the plan branch.

- Step 1: merged
- Step 2: merged
- Step 3: merged
- Step 4: merged
- Step 5: merged
- Step 6: merged
- Step 7: merged
- Step 8: merged
- Step 9: not started
- Step 10: not started
- Step 11: not started
- Step 12: not started

## Out of scope

- Phase C: A6, B1, B3, A7, A8, D1 to D4, C1, C6, B2 (prompt and skill rewrites, circuit breaker, promise checks). Step 8 deliberately adds at most 6 lines to `worker-common.md` so B1's <= 900-token target stays reachable.
- Phase A deferred minors, recommendation: do the three safe ones in optional step 12. Defer the behavioural ones to a "Phase A follow-ups" plan or fold into Phase C where the same files are touched: degraded back-off pool without time decay and halving per worker 429 (`lib/backoff.ts`; needs a decay design); back-off sleep not cancelled by kill (`lib/retry.ts` sleep must observe `kill()`; fold into C1/C2-adjacent work); role-agnostic resume preamble (`lib/retry.ts` `resumePreamble`; pairs with B1 wording); guard sibling-worktree rule for nested worktrees (`extensions/worker-guard/policy.ts`; security-relevant, needs its own paired tests); a behavioural test for `spawnWorker` wiring (needs `runPiJson` injected; step 5 covers the prompt composition through a pure helper only).
- Compaction settings written to the user's `settings.json` (documented only), an LLM-assisted summary section, auto-nudging from `ctx.getContextUsage()` (documented in PLAN.md, untried).
- A `handoff_file` parameter for `foreman_delegate` (PLAN.md A2 task 4: revisit only if A1 and A2 leave handoffs too large).
- A4-style live comparisons already done in Phase A; `scripts/herdr-tail.mjs` live activity.
