# Implementation Plan: foreman-pi reliability audit, Phase A

Branch: `feat/foreman-reliability` (linked worktree, base `0895045`, package 0.3.4). Source of truth for each item's gap: `PLAN.md`, section "Architecture & Token Efficiency Audit Improvements" (items C5, C4, C2, C3, A4, E1, A9, "Suggested order" Phase A). This plan only adds the concrete tasks and acceptance; it does not restate the audit prose.

## Overview

Phase A makes the worker pipeline reliable before any token work: the guard stops blocking legitimate work (C5), workers run in the plan's worktree (C4), transient provider errors no longer kill a working builder and orphaned workers leave evidence (C2, C3), workers stop loading the user's global skills (A4), a live activity line plus stuck detection shows working versus stuck (E1), and the planner can `edit` its plan instead of re-emitting it (A9). 16 steps, strictly sequential: C4, C2, C3, A4 and E1 all touch `extensions/coordination/spawn-worker.ts` and/or `coordinator.ts`, and C5 steps touch `policy.ts`; no `## Parallel` wave exists in this plan. Each step ends green on `npm test` and is independently mergeable.

## Conventions used by plan-runner and builders

- Step line format `N. **Title** (Touches: ...)` is the only thing code parses (`lib/plan-steps.ts` `parseStepTitle`; it matches `^\s*N\.\s+\*\*Title\*\*` anywhere in the file, so no other numbered bold lines appear in this document). `Touches`, `Checks` and `Renders` are conventions read by plan-runner and `agents/plan-step-builder.md`; `agents/planner.md` does not define them and no code consumes `Checks`.
- `Checks` lists the exact npm scripts from `package.json` plus the named regression tests the step must add. Every step also runs `npm run typecheck` (part of `npm test`).
- `Renders: no` on every step: there is no UI screenshot. Widget and `/foreman-status` text (steps 13 and 14) are verified by the pure renderers in `lib/workers.ts` under unit tests (existing pattern in `extensions/coordination/smoke-test.ts`: `renderWorkersUi`, `renderReport`).
- Do not touch `extensions/model-fallback/`, `AGENTS.md`, or the pinned "Model fallback" section of `README.md` (`lib/readme-test.ts` pins its sha256). New env vars go in the env tables of `README.md` and `README.pt-BR.md` (both list `FOREMAN_MAX_WORKERS` today), outside that section.
- Guard-friendly worker commands: one literal command per suite (`npm run test:worker-guard`), no loops over globs, scratch under `.foreman/`.

## Pre-flight checks (builder of step 1 runs these once and records the output in its report)

- `git branch --show-current` prints `feat/foreman-reliability`; `git status --short` is clean apart from `.foreman/`.
- `npm test` is green on the untouched tree. If anything fails, write the failing test names to `.foreman/baseline.txt` and diff later with `node scripts/baseline-diff.mjs .foreman/baseline.txt` (shared worker rule); do not start step 1 on an unexplained failure.
- `pi --help` lists `--no-skills` (confirmed in `docs/cli.md` of pi 1.5.2, line 204) and `pi` is on PATH for the one live check in step 10 (a missing `pi` means step 10 reports its live check as skipped, not passed).
- Tools confirmed present while planning: `lib/spawn.ts` (`runPiJson`, `getPiInvocation`), `lib/retry.ts` (`runWithRetry`, `TRANSIENT_RE`, `isTransientFailure`), `lib/worktree.ts` (`createWorktree`, `finishWorktree`, `retargetPrompt`), `lib/workers.ts` (`renderWorkersUi`, `renderReport`), `lib/plan-steps.ts`, `extensions/coordination/{coordinator,spawn-worker,index}.ts`, `extensions/worker-guard/{policy,vars,index}.ts`. Every test script named below exists in `package.json`.

## Repo facts that change how PLAN.md items are executed (verified by reading the code)

- `TRANSIENT_RE` already matches `503` and `429`; only the phrase "credential validation" is missing (C2 task 1).
- The guard extension already routes the `edit` tool through `checkWrite` (`extensions/worker-guard/index.ts`), and `plannerMayWrite` is path-based, so A9 needs no `policy.ts` change, only tests and the agent file.
- The guard root is `ctx.cwd` of the worker process. Spawning workers with `cwd = workdir` (C4) therefore moves the guard root with no policy change; `policy.ts` only needs the C5 path fixes.
- `events.jsonl` is written only when herdr panes are active (`panesEnabled()` in `spawn-worker.ts`), and it keeps only `message_end` lines; `message_update` is dropped both there and in `runPiJson`'s `processLine`. No recorded stream with `message_update` exists in the repo (`.foreman/runs/*/t1-planner.events.jsonl` has 51 `message_end` lines only), so E1 event shapes come from pi's `docs/json.md`.
- `recover()` treats any existing `<task>.md` as a finished report: a C3 stub file must carry a marker that `recover()` recognises, or an orphan would be reported `completed`.
- `activeWriters` in `spawn-worker.ts` is a module-level counter; coordinator `maxWorkers` is global (`FOREMAN_MAX_WORKERS`, default 4).

## Architecture changes

- `extensions/worker-guard/policy.ts`, `vars.ts`: path and probe fixes (C5); `references/worker-common.md`, `references/worker-guard.md`: new `Guard-denied:` field and wording (C5).
- `lib/worktree.ts`, `extensions/coordination/{index,coordinator,spawn-worker}.ts`, `lib/plan-steps.ts`, `skills/plan-runner/SKILL.md`, `references/using-worktrees.md`: `workdir` (C4).
- `lib/retry.ts`, new `lib/backoff.ts`, `extensions/coordination/{spawn-worker,coordinator}.ts`: mid-task resume, shared back-off gate, writer cap (C2).
- `extensions/coordination/{coordinator,spawn-worker}.ts`: orphan evidence and unique task ids (C3).
- `lib/spawn.ts`, `extensions/coordination/spawn-worker.ts`: `--no-skills` (A4).
- New `lib/activity.ts` (+ test), `lib/spawn.ts` (`onEvent`), `lib/workers.ts`, `lib/i18n/{en,pt-BR}.ts`, `extensions/coordination/{coordinator,index,spawn-worker}.ts`: activity, status.json, stuck notifications (E1).
- `agents/planner.md`, `templates/handoff-prompt.md`, `extensions/worker-guard/smoke-test.ts`: planner `edit` (A9).

## Steps

1. **Guard: allow the .foreman directory and sibling-worktree .foreman for scoped roles** (Touches: `extensions/worker-guard/policy.ts`, `extensions/worker-guard/smoke-test.ts`)
   - Item: C5 (path cases).
   - Action: in `pathProblem` (cases `scoped`/`shipper`), allow the `.foreman` directory itself (`segs[0] === ".foreman"` with `segs.length >= 1`, so `mkdir .foreman` and `mkdir -p .foreman/x` pass) and allow `<linked worktree>/.foreman` and `<linked worktree>/.foreman/**` when `rel === null` and the path sits inside one of `siblingWorktrees(ctx.root)` (same helper the dev/builder branch already uses; `.git` inside it stays denied). First reproduce each directAds case with `checkBash`/`checkWrite` and write the failing assertion before changing code. For the `../x` redirect case: reproduce, then root-cause. If the resolved path really is outside the allowed area, the denial is correct: keep it and add a regression test asserting the denial plus a note in `references/worker-guard.md`; only if the resolved target is inside an allowed area (for example `../repo/.foreman/x` from a subdirectory) fix `resolveArg`/`redirectProblem` so it is judged on the resolved path.
   - Why: `qa`/`shipper` runs were refused for `mkdir .foreman` and for `.foreman` writes in the plan worktree.
   - Dependencies: none
   - Risk: medium (security-relevant policy; widening must not open `.foreman/../src`).
   - Checks: `npm run test:worker-guard`. New named tests in `extensions/worker-guard/smoke-test.ts`: `qa may mkdir .foreman`, `shipper may mkdir -p .foreman/qa-logs`, `qa may write <sibling worktree>/.foreman/x from main cwd`, `qa may not write <sibling worktree>/src/a.ts`, `qa may not write <sibling worktree>/.git/config`, `.foreman/../src/a.txt still denied`, `relative ../ redirect judged on resolved path`. The fixture needs a real linked worktree (`git worktree add` in the temp repo; `siblingWorktrees` runs `git worktree list`).
   - Renders: no

2. **Guard: compose literal variables with for-loops; widen the python read-only probe** (Touches: `extensions/worker-guard/vars.ts`, `extensions/worker-guard/policy.ts`, `extensions/worker-guard/smoke-test.ts`)
   - Item: C5 (vars/loop and `python3 -c` cases).
   - Action: (a) reproduce `P=<abs path>; for s in a b c; do $P run $s > /tmp/o_$s.txt; done` for `qa` with `checkBash`; find why `resolveLiteralVars(expandForLoop(command))` (order set in `checkBash`) leaves `$P` unresolved (suspects: `resolveLiteralVars` bails on `COMPOUND`/`&`/`|` tests applied to the expanded text, or the assignment regex); make the two compose so the guard judges the real paths, keeping every existing fail-closed rule in the `vars.ts` header (single assignment, literal charset, no reassignment). (b) In `interpreterProbeProblem`/`PY_STMT`, accept for planner/reviewer a small expression grammar inside `python3 -c`: statements `import x`, `NAME = "<literal>"`, `print(<expr>)`; `<expr>` = name, string literal, or `len|sorted|str|list(<expr>)`, or `json.load(open(<string-or-name>))` with a single argument (no mode, so read-only). Everything else (`exec`, `eval`, `__import__`, `os.system`, `open(..., "w")`, attribute chains other than `json.load`/dotted names already allowed) stays denied.
   - Why: assignment plus loop and a `len(json.load(open(f)))` probe produced false blocks that turned complete reviews into `blocked`.
   - Dependencies: requires step 1 (same files, sequential).
   - Risk: medium-high (shell parsing; a loosened regex can create a bypass). Every new allow gets a paired deny test.
   - Checks: `npm run test:worker-guard`. Named tests: `literal var assigned then used inside a for-loop redirect is judged on the real path`, `same with a variable the loop reassigns stays denied`, `loop over a glob stays denied`, `planner may run python3 -c json.load(open) len print`, `planner may not python3 -c open(..., "w")`, `planner may not python3 -c exec/eval/__import__/os.system`, `reviewer same probes as planner`.
   - Renders: no

3. **Guard: Guard-denied report field and non-fatal denial wording** (Touches: `extensions/worker-guard/policy.ts`, `extensions/coordination/coordinator.ts`, `references/worker-common.md`, `references/worker-guard.md`, `extensions/worker-guard/smoke-test.ts`, `extensions/coordination/smoke-test.ts`)
   - Item: C5 (denial suffix and report contract).
   - Action: replace `SUFFIX` in `policy.ts` with wording that says: stop that command, do not work around it, continue the remaining work, list the denied command under `Guard-denied:` in the foreman-report, and use `Status: blocked` only when the denial prevents the core deliverable. Add `Guard-denied:` to the report contract in `references/worker-common.md` (field list near the report block) and `references/worker-guard.md`. In `coordinator.ts`: add `guard-denied` to `FIELD_LABEL`, `ParsedReport.guardDenied: string[]`, store it in the task meta JSON and `Notification.guardDenied`, and print a `guard-denied: ...` line in `formatBlock` only when non-empty. The status stays whatever the worker reported (ruling: the coordinator does not rewrite a worker's `blocked` to `completed`; the worker now decides, the orchestrator sees the denied commands). `extensions/worker-guard/index.ts` has a second copy of the old suffix in its catch branch; update it to match.
   - Why: a refused probe forced `Status: blocked` even when the work was done.
   - Dependencies: requires step 2.
   - Risk: low-medium (existing tests assert on the old suffix text; grep before editing).
   - Checks: `npm run test:worker-guard`, `npm run test:coordination`, `npm run test:agents`, `npm run test:readme`. Named tests: `deny reason mentions Guard-denied and not unconditional blocked`, `parseFinalBlock reads Guard-denied`, `formatBlock omits guard-denied when empty`, `formatBlock includes guard-denied when present`, `worker-common.md documents Guard-denied` (a grep-style check in `lib/agents-test.ts` or `lib/readme-test.ts`).
   - Renders: no

4. **Worktree: base-dir aware isolation, shared env dirs, safe path rewriting** (Touches: `lib/worktree.ts`, `lib/worktree-test.ts`)
   - Item: C4 (library half).
   - Action: (a) `createWorktree(root, taskId)` keeps its signature but is documented as `root = workdir`; after `git worktree add`, symlink these untracked environment dirs from `root` into the new tree when they exist in `root`, are not present in the new tree, and `git check-ignore -q <name>` says they are ignored: `.venv`, `venv`, `node_modules`. (Skipping non-ignored names keeps `git add -A` in `finishNow` from committing the symlinks.) (b) `retargetPrompt`: rewrite only occurrences of `iso.root` that are not followed by `/.foreman` and not already inside `iso.path`, and add a regression for the directAds shape: prompt contains `<main>/.worktrees/<slug>/docs/x` while `iso.root` is `<main>/.worktrees/<slug>`; the rewrite must produce `<iso>/docs/x`, never `<iso>/.worktrees/<slug>/...`. (c) New exported `resolveWorkdir(root, requested)`: realpath, must be a directory, must equal `root` or be one of `git worktree list --porcelain` of `root`; otherwise throws an `Error` listing the allowed paths. `shouldIsolate`/`isolateMode` unchanged.
   - Why: isolation branched from the main checkout, rewrote handoff paths into non-existent dirs and lacked `.venv`.
   - Dependencies: requires step 3 (sequential waves; no file overlap, ordering only).
   - Risk: medium (git worktree behaviour from inside a linked worktree: `git rev-parse --git-path info/exclude` must resolve to the shared file, verify in the test).
   - Checks: `npm run test:worktree`. Named tests in `lib/worktree-test.ts`: `worktree from a linked-worktree root merges back into that worktree's branch, not main`, `.venv and node_modules are symlinked when ignored`, `non-ignored env dir is not symlinked`, `retargetPrompt does not duplicate the .worktrees segment`, `resolveWorkdir accepts root and a sibling worktree`, `resolveWorkdir rejects a path outside the repo and a non-directory`.
   - Renders: no

5. **Coordination: workdir parameter, remembered per run, used as worker cwd** (Touches: `extensions/coordination/index.ts`, `extensions/coordination/coordinator.ts`, `extensions/coordination/spawn-worker.ts`, `extensions/coordination/smoke-test.ts`)
   - Item: C4 (plumbing half).
   - Action: add optional `workdir` (absolute path) to `DelegateParams` in `index.ts` and `DelegateInput`; the coordinator keeps `latchedWorkdir` (a per-call value overrides and re-latches, unlike `planSlug` which latches once; ruling: plan-runner may legitimately move a run to another worktree) and passes `cwd: workdir ?? deps.root` in `SpawnRequest` while `runDir` stays under `deps.root/.foreman/runs` (reports are written by the parent). The coordinator validates through an injected `deps.resolveWorkdir` (default wired in `index.ts` to `resolveWorkdir` from step 4; tests inject a fake) and throws a clear error from `delegate()` on a bad path; record `workdir` in the task meta JSON. In `spawn-worker.ts` `createWorktree(req.cwd, ...)` already uses `req.cwd`, so isolation now branches from the workdir HEAD; confirm no other use of `deps.root` for cwd remains (`recover()` and `readStepTitle` correctly keep `deps.root`). Tool schema description for `workdir` says: set once by plan-runner step 0 to the plan worktree.
   - Why: workers started in the main checkout while the plan lives in a linked worktree; the guard root, `.foreman` writes and isolation base were all wrong.
   - Dependencies: requires step 4.
   - Risk: medium.
   - Checks: `npm run test:coordination`, `npm run test:worker-guard`. Named tests: `delegate passes workdir as SpawnRequest.cwd and keeps runDir under root`, `workdir is remembered for later delegates in the run`, `per-call workdir overrides the remembered one`, `invalid workdir throws from delegate and spawns nothing`, `meta json records workdir`, `guard: qa with cwd = linked worktree may write .foreman/qa-logs/x.log` (in `extensions/worker-guard/smoke-test.ts`).
   - Renders: no

6. **Plan lint for overlapping Touches in a parallel wave; plan-runner and worktree docs** (Touches: `lib/plan-steps.ts`, `lib/plan-steps-test.ts`, `extensions/coordination/coordinator.ts`, `extensions/coordination/smoke-test.ts`, `skills/plan-runner/SKILL.md`, `references/using-worktrees.md`)
   - Item: C4 (lint and docs half).
   - Action: add to `lib/plan-steps.ts` a pure `parseTouches(markdown, step)` (reads the `(Touches: a, b)` list on the step line, backticks stripped) and `findParallelOverlaps(markdown)`: every step line between a `## Parallel` heading and the next `## ` heading is a wave member; return pairs that share a Touches path (exact match or directory prefix). `## Parallel` placement and format are assumed from `skills/plan-runner/SKILL.md` §2 (flagged risk). In `coordinator.delegate()`, when the new task's plan step overlaps a currently running step of the same plan (lint result), still dispatch but append a `warning` sentence to `DelegateAck.ack` ("step N shares files with running step M; dispatch it after M finishes next time") so the orchestrator, which has no bash, sees it. Update `skills/plan-runner/SKILL.md` step 0 to pass `workdir: <abs plan worktree path>` on every `foreman_delegate` and §2 to run overlapping parallel steps serially; update `references/using-worktrees.md` with the `workdir` rule.
   - Why: step 10 and step 16 collided in the shared worktree (i18n key counts).
   - Dependencies: requires step 5.
   - Risk: low-medium (format assumption for `## Parallel`).
   - Checks: `npm run test:plan-steps`, `npm run test:coordination`, `npm run test:readme`. Named tests: `parseTouches reads a backticked list`, `findParallelOverlaps flags two wave steps sharing a file`, `findParallelOverlaps ignores steps outside ## Parallel`, `directory prefix counts as overlap`, `delegate ack warns on overlap with a running step`, `no warning when Touches are disjoint or the plan has no Parallel section`.
   - Renders: no

7. **Retry: resume a worker after a mid-task transient failure** (Touches: `lib/retry.ts`, `lib/retry-test.ts`, `extensions/coordination/spawn-worker.ts`)
   - Item: C2 tasks 1 and 2.
   - Action: (a) add `credential validation` (case-insensitive) to `TRANSIENT_RE`. (b) Split classification: keep `isTransientFailure` (no output) and add `isMidTaskTransient(r)` (failed, transient text, and the worker did produce output). (c) `runWithRetry` gets `maxResumes` (default 2, env `FOREMAN_MAX_RESUMES`, read in `spawn-worker.ts`) and calls `start(attempt, resume?)`, where `resume` is `{ previous: PiRunResult; n: number }` only on a mid-task retry; the no-output retries keep their existing cap of 3 and the two caps are counted separately. (d) New exported `resumePreamble(n)` in `retry.ts`: "Your previous run was interrupted by a provider error. Run `git status` and `git log -3`, continue from what exists, commit only your own paths, then finish and write the foreman-report." (e) In `spawn-worker.ts` build argv per attempt (extract a `buildArgs(promptText)` closure) so a resume attempt sends `Task: <preamble>\n\n<original prompt>`; the child still runs `--no-session`, so git state is the memory. The final result returned is the last attempt's; earlier attempts' work lives in git.
   - Why: every 429/503 hitting a working builder surfaced as `failed` and needed a manual resume dispatch.
   - Dependencies: requires step 6.
   - Risk: medium (a resumed worker can redo work; mitigated by the preamble and the cap of 2).
   - Checks: `npm run test:retry`, `npm run test:coordination`. Named tests in `lib/retry-test.ts`: `credential validation 503 is transient`, `mid-task 429 after output is mid-task transient, not no-output transient`, `mid-task failure resumes with resume.n = 1 then 2 then gives up`, `no-output retries and resumes use separate caps`, `non-transient failure after output is never resumed`, `kill during a resume backoff stops everything`, `resumePreamble mentions git status, git log and commit only your paths`. The existing assertion `429 after output is not` stays true for `isTransientFailure`.
   - Renders: no

8. **Shared back-off gate and writer concurrency cap** (Touches: `lib/backoff.ts`, `lib/backoff-test.ts`, `package.json`, `lib/retry.ts`, `extensions/coordination/coordinator.ts`, `extensions/coordination/spawn-worker.ts`, `extensions/coordination/smoke-test.ts`, `README.md`, `README.pt-BR.md`)
   - Item: C2 tasks 3 and 4.
   - Action: (a) New `lib/backoff.ts`: `createBackoffGate({ now, rng })` with `noteRateLimit(text)` (parses a `retry-after` seconds value from the error text when present, otherwise uses the caller's computed back-off; applies ±25% jitter; pauses until `pausedUntil`), `remainingMs()`, `limit(max)` (halves the effective concurrency on a rate-limit, floor 1), `noteCleanFinish()` (restores one slot, never above `max`), and an exported `sharedGate` singleton (ruling: module singleton like `activeWriters`, because `spawnWorker` is injected as a plain function; coordinator takes `deps.gate ?? sharedGate`, tests inject their own). Rate-limit class = 429, 529, `rate limit`, `overloaded`; other transient errors (502/503/504, credential validation) keep per-worker back-off without pausing the pool. (b) `retry.ts`: `RetryOptions.onTransient?(r)` called before each sleep, and the default sleep becomes `max(own backoff, gate.remainingMs())`. (c) `spawn-worker.ts` wires `sharedGate` into `runWithRetry`. (d) `coordinator.ts`: `pump()` and `delegate()` use `gate.limit(maxWorkers)` and do not start a task while the gate is paused (arm one unref'd timer to pump when the pause ends); `noteCleanFinish()` is called from `finishTask` on `completed`. (e) Writer cap: new `maxWriters` dep (env `FOREMAN_MAX_WRITERS`, default 2, ruling: PLAN.md says "default FOREMAN_MAX_WORKERS for writer roles 2", implemented as a separate variable so `FOREMAN_MAX_WORKERS` keeps meaning total workers); `pump()` skips (does not drop or reorder) queued tasks whose role is in `ISOLATABLE_ROLES` while that many writers run, so readers still start. Document both env vars in the README env tables (en and pt-BR). Add `"test:backoff": "tsx lib/backoff-test.ts"` to `package.json` and append `npm run test:backoff` to the `test` script chain.
   - Why: parallel workers hit the rate limit together and re-hit it on a fixed schedule.
   - Dependencies: requires step 7.
   - Risk: high (scheduling change; a stuck pause would stall the run). Mitigate: the pause is bounded (cap 5 min), the timer is always re-armed from `remainingMs()`, and the 30 min worker timeout is untouched.
   - Checks: `npm run test:backoff`, `npm run test:retry`, `npm run test:coordination`, `npm run test:readme`. Named tests: `jitter stays within ±25% (seeded rng)`, `retry-after seconds is honoured`, `limit halves on rate-limit and restores one slot per clean finish`, `limit never below 1 or above max`, `pause is capped`, `coordinator does not start a queued task while paused, starts it after`, `readers start while two writers run and a third writer queues`, `queued writer keeps its place and starts when a writer finishes`, `FOREMAN_MAX_WRITERS default is 2`, `two workers hitting 429 share one pause`.
   - Renders: no

9. **Orphan evidence: stub report, events log always on, unique task ids** (Touches: `extensions/coordination/coordinator.ts`, `extensions/coordination/spawn-worker.ts`, `extensions/coordination/smoke-test.ts`, `lib/spawn-test.ts`)
   - Item: C3.
   - Action: (a) At task start the coordinator writes `<task>.md` as a stub whose first line is `# <taskId> RUNNING` (with start time, worker cwd and the events-log path) so the orchestrator never hits ENOENT; `finishTask` overwrites it as today. (b) `recover()` must treat a file starting with `# <id> RUNNING` as no report (still `failed`, "orphaned"), otherwise a stub parses as a completed report. (c) `spawnWorker` always passes a `logFile` (`<runDir>/<task>.events.jsonl`, `message_end` lines only, unchanged filter) and only the herdr pane stays conditional on `panesEnabled()`; add `cwd` (the iso path when isolated) to `WorkerHandle` and write it to the task meta JSON. (d) `recover()` enriches an orphan notification with: the last assistant text from `<task>.events.jsonl` (truncated like `SUMMARY_MAX`, via the existing `finalReport` on parsed lines), and `git status --short` of the recorded cwd run with `core.hooksPath=/dev/null` and a 5 s timeout (empty string when the dir is gone or not a repo; failures never throw). The result goes into the orphan `summary` and into the notification as `partial: <n changed paths>`. (e) Unique ids per session: `recover(entries)` seeds `seq` from the highest `t<N>-` seen in the session's task entries so a resumed session never reuses `t1` (ruling: keeps the `tN-role` format other code and docs rely on; a brand new session still starts at `t1`, and run ids already disambiguate output paths).
   - Why: the orchestrator hit ENOENT on orphans and could not tell whether partial work existed; `t1` repeated across runs.
   - Dependencies: requires step 8.
   - Risk: medium (touches `recover()` and the finish path).
   - Checks: `npm run test:coordination`, `npm run test:spawn`. Named tests: `stub report exists right after delegate`, `stub is overwritten by the final report`, `recover: stub-only orphan is failed and orphaned, not completed`, `recover: orphan notification includes last assistant text from events log`, `recover: orphan notification includes git status --short of the worker cwd (temp git repo)`, `recover: missing cwd or events log degrades to the old message`, `seq is seeded from recovered entries so the next task id is higher`, `events log is written without herdr`.
   - Renders: no

10. **Workers start without the user's global skills** (Touches: `lib/spawn.ts`, `lib/spawn-test.ts`, `extensions/coordination/spawn-worker.ts`, `README.md`, `README.pt-BR.md`)
   - Item: A4.
   - Action: new pure helper in `lib/spawn.ts`, `workerBaseArgs(role, env, opts?)`, returning `["--mode","json","-p","--no-session"]` plus `--no-skills` unless `FOREMAN_WORKER_SKILLS=1`. Keep context files and extensions (worker-guard, model routing need them): do not add `--no-extensions` or `--no-context-files`. Because `agents/qa.md`, `agents/frontend-dev.md` and `agents/codebase-auditor.md` use the optional `impeccable` skill "if it is listed among your available skills", the helper also adds `--skill <dir>` for `impeccable` on those three roles when a directory of that name exists under `<cwd>/.agents/skills`, `~/.agents/skills` or `~/.pi/agent/skills` (ruling: keeps the documented optional behaviour instead of silently dropping it; `impeccable` is not installed on this machine, so the code path is covered by a temp-dir test). `spawn-worker.ts` uses the helper instead of the literal array. Document `FOREMAN_WORKER_SKILLS` in both READMEs. Live check by the builder (not by unit test): run one real `pi --mode json -p --no-session --no-skills "reply with ok"` from a temp dir and confirm it answers; then one worker through the real extension if feasible (`test:live:coordination` exists; run it only if it needs no secrets) and confirm `read`/`bash` and the guard still load. If `pi-claude-cli` rejects or mishandles `--no-skills` (flagged unverified in PLAN.md), report `Status: blocked` with the exact error rather than reverting silently.
   - Why: every worker request carried the user's global skill descriptions and risked mis-triggering unrelated skills.
   - Dependencies: requires step 9.
   - Risk: medium (provider interaction is unverified).
   - Checks: `npm run test:spawn`, `npm run test:coordination`, `npm run test:readme`. Named tests in `lib/spawn-test.ts`: `workerBaseArgs includes --no-skills by default`, `FOREMAN_WORKER_SKILLS=1 removes it`, `args still contain --mode json -p --no-session`, `impeccable --skill is added only for qa/frontend-dev/codebase-auditor when the dir exists`, `no --skill for other roles`, `no --no-extensions and no --no-context-files`.
   - Renders: no

11. **Activity tracker (pure) with phase, health and recent actions** (Touches: `lib/activity.ts`, `lib/activity-test.ts`, `package.json`)
   - Item: E1 tasks 1 to 3 (and the first half of 5).
   - Action: new `lib/activity.ts`, no pi imports. `createActivityTracker({ stuckAfterMs })` with `feed(event, now)`, `view(now)` and `reset(now)` (called on a retry attempt). It consumes the event shapes in pi `docs/json.md`: `message_update.assistantMessageEvent` types `thinking_start|thinking_delta` (phase thinking, label = last ~70 chars of accumulated thinking when non-empty), `toolcall_start` (phase writing, label `<toolName> <path or command head>`, bytes streamed counted from `toolcall_delta` delta lengths), `text_delta` (phase reporting), `tool_execution_start` (phase tool, label = command head 60 chars or file path, start time), `tool_execution_end` (records duration, `isError`, clears tool), `turn_end` (turns +1, phase waiting); top-level `message_update.usage` gives live output tokens and cost. `view(now)` returns `{ phase, label, lastEventAt, turns, toolCalls, outTokens, cost, recent[5], health, denials, lastDenial }`. Health: `active` (event within 20 s), `waiting` (20 to 90 s, or a tool running past 60 s), `silent` (more than `stuckAfterMs`, default 90 s, with no tool running), `repeating` (same tool and same target 3 times in a row, or the same failing command), `denied` (a `tool_execution_end` with `isError` whose result text starts with `Blocked by the foreman worker guard`; text shape is assumed from `extensions/worker-guard/index.ts`, flagged risk). Unknown events are ignored; a thinking block with no text leaves the label empty (phase only). Add `"test:activity": "tsx lib/activity-test.ts"` to `package.json` and append `npm run test:activity` to the `test` chain.
   - Why: the widget proves a process is alive, not that it is working.
   - Dependencies: requires step 10 (ordering only).
   - Risk: medium (event shapes come from the docs; a recorded-stream fixture reduces it). The builder captures one short real stream with `pi --mode json -p --no-session "list the files in the current directory with the ls tool"` run from a temp dir, trims it to at most 200 lines, saves it as `lib/testdata/worker-stream.jsonl`, and adds `!**/testdata/**` to `package.json` `files`. If `pi` cannot run, the test uses only synthetic events built from `docs/json.md` and the report says "no recorded stream".
   - Checks: `npm run test:activity`. Named tests: `recorded stream yields thinking, writing, tool and reporting phases in order` (or the synthetic equivalent), `toolcall_delta bytes accumulate into the label`, `silent stream flips to silent after the threshold`, `tool running 70 s is waiting, not silent`, `three identical bash calls flip to repeating`, `a different target resets the repeat count`, `guard denial sets denied and counts`, `reset clears everything for a retry attempt`, `unknown events are ignored without throwing`, `ring keeps only the last 5 actions`.
   - Renders: no

12. **Wire activity into the worker stream, coordinator and status.json** (Touches: `lib/spawn.ts`, `lib/spawn-test.ts`, `extensions/coordination/spawn-worker.ts`, `extensions/coordination/coordinator.ts`, `extensions/coordination/smoke-test.ts`)
   - Item: E1 tasks 6 and 7, plus the C3 link.
   - Action: (a) `RunPiJsonOptions.onEvent?(event)` in `lib/spawn.ts`, called in `processLine` for every parsed event before the `message_end` filter; exceptions from the callback are swallowed; the in-memory `messages` and the on-disk events log filters do not change, so token and disk behaviour stay neutral (activity is UI and disk only and is never sent to the orchestrator). (b) `SpawnRequest.onEvent?` is passed by `spawnWorker` into every `runPiJson` attempt (and the tracker is `reset` when a retry or resume attempt starts). (c) The coordinator creates one tracker per task, feeds it from `onEvent`, exposes it on `getTask(id).activity`, and does NOT call `emitChange` per event (the 1 s UI ticker in `index.ts` re-reads the snapshot; per-delta emits would flood the bus). (d) Atomic `<runDir>/<task>.status.json` (write temp file then rename), at most every 2 s while events arrive, plus a final write on finish; contents: the tracker `view`, `updated_at`, `cwd`. (e) `recover()` adds the last action, tokens and last-event age from `<task>.status.json` to the orphan summary when the file exists (extends step 9; events-log text stays the fallback).
   - Why: provides the data for the widget and is the C3 evidence when an orchestrator restart orphans a worker.
   - Dependencies: requires step 11.
   - Risk: medium (hot path: runs for every streamed delta; keep `feed` O(1)).
   - Checks: `npm run test:spawn`, `npm run test:coordination`, `npm run test:activity`. Named tests: `onEvent receives message_update and tool events that the messages array drops`, `a throwing onEvent does not break message collection`, `messages array is unchanged by onEvent`, `status.json is written atomically and at most every 2 s (fake clock)`, `status.json final write on finish`, `no emitChange per event`, `recover reads status.json into the orphan summary`, `tracker resets on retry attempt`.
   - Renders: no

13. **Widget activity line and /foreman-status detail** (Touches: `lib/workers.ts`, `lib/i18n/en.ts`, `lib/i18n/pt-BR.ts`, `extensions/coordination/coordinator.ts`, `extensions/coordination/index.ts`, `extensions/coordination/smoke-test.ts`, `lib/i18n-test.ts`)
   - Item: E1 task 4.
   - Action: `WorkersSnapshot.running[]` gets an optional `activity` (the tracker `view`), filled by `coordinator.snapshot()`. `renderWorkersUi(s, now, columns = 100)` renders each running worker as one line: `<health glyph> step 13 · Carousel UI · 4m43s · writing app/static/js/builder.js 38 KB · 21 tools · 14k out`, where the glyphs are `●` active, `◐` waiting, `⚠` silent, `⟳` repeating, `✖` denied. Truncation rule: the label segment shrinks (ellipsis) so the whole line fits `columns`; the glyph, step/title and elapsed time are never cut. A worker with no activity yet (first seconds, or `activity` absent) keeps today's line `▶ step 13 · Carousel UI · 4m43s` (the no-data state). `renderReport` expands each running worker: last 5 actions with timings, the last thinking snippet, tokens and cost so far, the guard-denial count, the health reason in words. All strings through `t()` with new keys in both catalogs (`activity.phase.*`, `activity.health.*`, `report.activity.*`); `lib/i18n-test.ts` enforces key parity and no leaked `{}` placeholders. `index.ts` passes the terminal width when available (best effort, default 100) and keeps the 1 s ticker; the status-bar text is unchanged.
   - Why: working versus stuck must be visible without opening the worker output.
   - Dependencies: requires step 12.
   - Risk: low-medium (width handling with wide glyphs; use code-point length, not byte length).
   - Checks: `npm run test:coordination`, `npm run test:i18n`, `npm run test:activity`. Named tests: `widget line for an active writing worker matches the documented shape`, `each health glyph renders for its state`, `line at 100 columns is one line and keeps elapsed time when the label is long`, `no-activity worker keeps the old line`, `queued and finished lines unchanged`, `renderReport lists last 5 actions, tokens and denial count`, `pt-BR renders the same structure`, `empty / no running workers still returns {}`.
   - Renders: no

14. **Stuck and repeating notifications, FOREMAN_STUCK_AFTER_S** (Touches: `extensions/coordination/coordinator.ts`, `extensions/coordination/index.ts`, `lib/workers.ts`, `lib/i18n/en.ts`, `lib/i18n/pt-BR.ts`, `extensions/coordination/smoke-test.ts`, `README.md`, `README.pt-BR.md`)
   - Item: E1 task 5.
   - Action: a `health` watcher on the 1 s tick (in `index.ts`, next to `refreshUi`, reading `coord.snapshot()`): when a running worker's health flips to `silent` or `repeating` (or `denied`), notify once through `say(ctx, ..., "warning")` and `herdr.notify` with the worker label and last action; when it recovers to `active`, clear the flag and emit one recovery notice. No kill: the 30 min worker timeout is the only automatic stop. The threshold comes from `FOREMAN_STUCK_AFTER_S` (default 90, `0` disables stuck detection) read where the tracker is created in `coordinator.ts` (`envInt`-style helper, ms internally). Notifications go to the UI and herdr only, never into the orchestrator context (`pi.sendMessage` is not used), so token cost stays neutral. Document the variable in both READMEs (env table).
   - Why: the planner's single 33k-token write, a three-minute QA suite and a worker looping on the same blocked command are only distinguishable with a signal.
   - Dependencies: requires step 13.
   - Risk: medium (notification spam on flapping; mitigated by notify-once per transition with a 60 s minimum between repeats per worker).
   - Checks: `npm run test:coordination`, `npm run test:readme`, `npm run test:i18n`. Named tests: `flip to silent notifies once`, `staying silent does not re-notify`, `recovery clears the flag and notifies once`, `repeating notifies with the repeated command head`, `FOREMAN_STUCK_AFTER_S=0 disables the silent flip`, `stuck notice is never sent via sendMessage`, `herdr.notify is called when herdr is active (fake herdr)`, `a worker that finishes while flagged does not leak a timer`.
   - Renders: no

15. **Planner can edit its plan instead of rewriting it** (Touches: `agents/planner.md`, `templates/handoff-prompt.md`, `extensions/worker-guard/smoke-test.ts`, `lib/agents-test.ts`)
   - Item: A9.
   - Action: `agents/planner.md`: frontmatter `tools: read, grep, find, bash, write, edit`; change the "If the handoff names a plan file" paragraph to say the planner saves with `write` and revises with `edit`, both limited by the worker guard to `docs/plans/<name>.md`; add a "Large plans" rule: write the outline first (title, overview, architecture, step titles with Touches), then add step bodies in separate calls, keeping every single tool call under about 8k output tokens; and a "Revisions" rule: when the handoff lists decisions to apply, change only the affected steps with `edit`, never re-emit the whole file. `templates/handoff-prompt.md`: add one line for revision handoffs ("apply these decisions to the existing plan with edits"). No `policy.ts` change: `extensions/worker-guard/index.ts` already sends `edit` through `checkWrite`, and `plannerMayWrite` is path-based (verified by reading). Do not edit the planner's own contract sections that PLAN.md assigns to B2 (Seams, Out of scope).
   - Why: the revision pass re-emitted a 71 KB plan (about 18k output tokens in one call) to apply six decisions.
   - Dependencies: requires step 14 (ordering only).
   - Risk: low. Open question for the foreman, not guessed: this document's own build pass does not need the planner, so the acceptance "revision replay under 10k output tokens" is checked manually in a later run (see Risks).
   - Checks: `npm run test:worker-guard`, `npm run test:agents`. Named tests in `extensions/worker-guard/smoke-test.ts`: `planner may edit docs/plans/x.md via the edit tool`, `planner edit of src/a.ts is blocked`, `planner edit of docs/plans/sub/x.md is blocked`, `planner edit of docs/other.md is blocked`, `edit goes through the extension handler (fire tool_call with an edit event)`. In `lib/agents-test.ts`: `planner tools include edit and still exclude nothing else changed` (assert the exact list).
   - Renders: no

16. **Docs, changelog and full verification for Phase A** (Touches: `CHANGELOG.md`, `README.md`, `README.pt-BR.md`, `references/worker-guard.md`, `references/diagnosing-a-run.md`)
   - Item: closes Phase A.
   - Action: add an `## [Unreleased]` section to `CHANGELOG.md` summarising C5, C4, C2, C3, A4, E1, A9 as Added/Changed/Fixed (do not bump `package.json` `version`; the shipper owns release). Make sure the README env tables in both languages list: `FOREMAN_WORKER_SKILLS`, `FOREMAN_MAX_WRITERS`, `FOREMAN_MAX_RESUMES`, `FOREMAN_STUCK_AFTER_S` (added in their steps; this step only verifies and fills gaps), and the new `workdir` parameter and `Guard-denied:` field are described in the references. `references/diagnosing-a-run.md`: add the `<task>.status.json` and always-on `<task>.events.jsonl` locations. Then run the whole gate once.
   - Why: user-visible behaviour changed; docs must match before review.
   - Dependencies: requires step 15.
   - Risk: low (the Model fallback README section is sha-pinned; do not touch it).
   - Checks: `npm test` (full chain, including the new `test:backoff` and `test:activity`), `npm run test:package`. Compare any failing names against `.foreman/baseline.txt` with `scripts/baseline-diff.mjs`; report `NEW:` and `FIXED:` lines verbatim.
   - Renders: no

## Testing strategy

- Per step: add the named regression tests first (red), implement, then run the listed scripts, then `npm run typecheck`. Step 16 runs the complete `npm test` and `npm run test:package`.
- Guard steps (1 to 3, 15): table-driven cases in `extensions/worker-guard/smoke-test.ts` use real temp files and a real linked worktree; every new allow has a paired deny (`.foreman/../src`, `.git`, `open(..., "w")`, glob loop). Success, denial and partial states are all asserted: a denied probe, a denied-but-completed report (`Guard-denied:`), a blocked-core-deliverable report.
- Coordination steps (5 to 9, 12 to 14): fake spawner and fake clock as in the existing `smoke-test.ts`; cover queued, running, paused (gate), orphaned, stub-only, recovered, finished-while-flagged. No real `pi` is started except the two live checks in steps 10 and 11, which are reported as run or skipped, never assumed.
- Retry and gate (7, 8): injected `sleep`, seeded `rng` and fake `now`, so back-off, jitter bounds, `retry-after`, caps and kill-during-backoff are deterministic.
- UI text (13, 14): the pure renderers are the test surface (no screenshots, `Renders: no`). States covered: no activity yet (empty), active, waiting, silent, repeating, denied, queued, finished, no workers (cleared), and both locales.
- Regression guard for token neutrality (steps 12 to 14): assert `messages` is unchanged by `onEvent` and that stuck notices never use `pi.sendMessage`.

## Risks & open questions

- **Event shapes for E1 come from `docs/json.md`, not from a recorded stream** (repo logs hold only `message_end`). Mitigation: step 11 captures one real stream; otherwise synthetic only and reported as such. The thinking snippet is best effort; the phase is the reliable signal (as PLAN.md says).
- **Guard-denial detection in E1 assumes** a blocked tool call surfaces as `tool_execution_end` with `isError: true` and the guard reason text. Unverified; if wrong, `denied` health simply never fires and step 11's test says so.
- **`## Parallel` section format** is assumed from `skills/plan-runner/SKILL.md`; no plan in this repo uses it. If a real plan uses another shape the lint is a no-op, never a false positive.
- **`--no-skills` with the `pi-claude-cli` provider** is unverified (PLAN.md says so too). Step 10 has a live check and a defined fallback (`Status: blocked` with the error).
- **`retry-after` availability**: pi may not surface the header in `errorMessage`; the gate then falls back to the computed back-off.
- **Behaviour-changing defaults**: writer cap 2 (step 8) and `--no-skills` (step 10) change defaults for existing users; both have env opt-outs and are in the CHANGELOG.
- **Interpretation rulings** (made here, flagged so the foreman can overrule): `FOREMAN_MAX_WRITERS` is a new variable rather than re-defining `FOREMAN_MAX_WORKERS`; the coordinator does not auto-rewrite `blocked` to `completed` for guard denials (the worker decides via `Guard-denied:`); per-call `workdir` overrides the remembered one; task-id uniqueness is by seeding the sequence on recovery rather than changing the `tN-role` format; the `../x` redirect case may turn out to be a correct denial; `herdr-tail.mjs` live activity (optional in PLAN.md) is not done in this phase.
- **A9 acceptance** ("a revision costs under 10k output tokens") can only be measured in a real planner run; it is an after-merge check, not a gate for this plan.
- **Sequential only**: any attempt to parallelise steps 4 to 14 will collide in `spawn-worker.ts` or `coordinator.ts`.

## Success criteria

- [ ] `mkdir .foreman`, `<sibling worktree>/.foreman/**` writes, literal-var plus for-loop commands and the python JSON probes pass the guard for the right roles, and every paired deny still denies (step 1 to 2)
- [ ] A denied probe can be reported under `Guard-denied:` without forcing `Status: blocked`; the notification shows it (step 3)
- [ ] `foreman_delegate` with `workdir` starts the worker in that worktree, isolation branches from and merges into it, `.venv` and `node_modules` are shared, handoff paths are not mangled (steps 4 to 5)
- [ ] Two overlapping steps in a `## Parallel` wave produce a visible warning (step 6)
- [ ] A 429 or 503 after output resumes the worker at most twice; a rate-limit pauses new spawns once for all workers, with jitter and `retry-after`, and concurrency recovers one slot per clean finish; writer roles default to 2 concurrent (steps 7 to 8)
- [ ] An orphaned task has a stub report, last assistant text, `git status --short` and (after step 12) last action and tokens; a resumed session never reuses `t1` (steps 9 and 12)
- [ ] Workers run with `--no-skills` unless `FOREMAN_WORKER_SKILLS=1`; the live check result is reported (step 10)
- [ ] The widget shows one activity line per worker with health glyph; `/foreman-status` expands it; stuck and repeating transitions notify once; nothing activity-related reaches the orchestrator context (steps 11 to 14)
- [ ] The planner has `edit`, limited to `docs/plans/<name>.md` (step 15)
- [ ] `npm test` and `npm run test:package` pass; CHANGELOG and both READMEs updated (step 16)

## Status

Source of truth for plan-runner; update a step to `merged` only when it is on `feat/foreman-reliability`.

- Step 1: merged
- Step 2: merged
- Step 3: not started
- Step 4: not started
- Step 5: not started
- Step 6: not started
- Step 7: not started
- Step 8: not started
- Step 9: not started
- Step 10: not started
- Step 11: not started
- Step 12: not started
- Step 13: not started
- Step 14: not started
- Step 15: not started
- Step 16: not started

## Out of scope (follow-up plans)

- Phase B, token cuts: B4 fixtures first, then A1 (prune old handoffs), A2 (handoff boilerplate footer), A5 (`scripts/run-suites.mjs`), A3 (custom compaction).
- Phase C, prompt and skill rewrites: A6, B1, B3, A7, A8, D1 to D4, C1 (circuit breaker), C6 (promise checks), B2 (planner template: seams and Out of scope).
- Optional E1 extension: live activity in `scripts/herdr-tail.mjs`.
- Killing a stuck worker automatically (E1 deliberately notifies only).

## Builder notes (amendments that override the step text above)

- Step 3 also touches `extensions/worker-guard/index.ts` (its catch branch carries a second copy of the old denial suffix); treat it as part of that step's Touches.
- Step 10 live check also compares the first request's input tokens with and without `--no-skills` (`message_update.usage.input` in the JSON stream, or the `usage` of the first `message_end`) and reports both numbers; a smaller number is expected, equal is reported as-is, not forced.
- Step 15 test names: read `planner tools include edit and still exclude nothing else changed` as "the planner tool list is exactly `read, grep, find, bash, write, edit`". Its Risk is low; the A9 token acceptance is an after-merge manual check (see Risks).
- This plan could not apply these corrections in place because the planner role has no `edit` tool (the exact gap A9 closes); they are recorded here instead.
