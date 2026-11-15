# Implementation Plan: foreman-pi reliability audit, Phase C (prompt/skill rewrites and remaining guardrails)

Branch: `feat/foreman-reliability`, cut after Phase B is merged (`docs/plans/reliability-phase-b.md`, steps 1 to 11; optional step 12 may or may not have landed). Source of truth for each item's gap and task: `PLAN.md`, section "Architecture & Token Efficiency Audit Improvements" (items A6, B1, B3, A7, A8, D1 to D4, C1, C6, B2 and "Suggested order" Phase C). This plan adds files, tests and acceptance; it does not restate that prose. Phase A deferred minors that change behaviour are folded in (steps 1 to 5).

## Overview

Phase C cuts orchestrator prompt size and closes the last guardrail gaps. Steps 1 to 5 fix Phase A follow-ups (back-off pool decay and per-burst halving, kill cancels back-off sleep, role-aware resume preamble, nested-worktree guard rule, `expandForLoop` `printf -v` check, behavioural `spawnWorker` test). Steps 6 to 12 are code: plan parsers, circuit breaker (C1), report size hint (A8), coordinator-side `Checks` verification (C6), plan-runner preflight, `/foreman resume` (D3), one-time session reminder (D4). Steps 13 to 20 are prompt text: split of the foreman skill (A6), grilling reuse (B3), plan-runner Status/baseline rules (D1, D2), planner template (B2), reviewer QA coverage (C6), worker-facing rewrite (B1), user-invoked skills (A7). Step 21 closes out. 21 steps, strictly sequential, each ends green on `npm test` and is independently mergeable (steps 9, 13 and 20 are the droppable or revertable ones, see Risks).

## Conventions

- Step line format `N. **Title** (Touches: ...)` is what `lib/plan-steps.ts` parses; no other numbered bold lines appear here. There is no `## Parallel` section: steps 5, 7, 8, 9 edit `extensions/coordination/{coordinator,spawn-worker}.ts`; steps 13 to 15 and 20 edit `skills/foreman/SKILL.md` (and 15, 20 `skills/plan-runner/SKILL.md`); `package.json` and both READMEs are shared. Do not reorder.
- `Checks` are exact npm scripts plus named tests the step adds. Every step also runs `npm run typecheck` (part of `npm test`). Every new `*-test.ts` gets an npm script and joins the `test` chain in `package.json`.
- Do not touch `extensions/model-fallback/`, `AGENTS.md`, or the pinned "Model fallback" section of the READMEs (`lib/readme-test.ts` pins its sha256). New env vars go in the env tables of `README.md` and `README.pt-BR.md`. `scripts/check-package.ts` asserts version 0.3.4: no version bump.
- Token proxy: `tokens = ceil(chars / 4)` (the PLAN.md convention).
- Worker commands stay guard-friendly: one literal command per suite, scratch under `.foreman/`.
- Files edited by Phase B (SKILL.md files, `worker-common.md`, templates, `spawn-worker.ts`, `coordinator.ts`, `instructions-test.ts`) have moved: every builder re-reads the file before editing and treats the line numbers below as hints.

## Pre-flight (builder of step 1 records the output in its report)

- `git branch --show-current` is the plan branch; `git status --short` clean apart from `.foreman/`; `npm test` green on the untouched tree. If anything fails, record failing names in `.foreman/baseline.txt` and diff later with `node scripts/baseline-diff.mjs .foreman/baseline.txt` (shared worker rule).
- Phase B end state exists: `ls scripts/run-suites.mjs scripts/trace-report.mjs lib/handoff-footer.ts lib/usage.ts extensions/context-filter/compaction.ts`; `grep -n "Step 1[01]: merged" docs/plans/reliability-phase-b.md`. If `scripts/run-suites.mjs` is missing, only step 9 is blocked (report `Status: blocked` for it and continue); every other step is independent of it.
- Record whether Phase B optional step 12 landed: `grep -n "printf" extensions/worker-guard/smoke-test.ts` (step 4 extends or creates that case) and `grep -n "workdir-fallback" extensions/coordination/coordinator.ts`.
- `pi` is on PATH (step 20's load check); `node --version` >= 22.19.
- Verified while planning (read, not assumed): `lib/retry.ts` (`runWithRetry` awaits `sleep` and checks `killed` only afterwards, so a kill during back-off waits out the sleep; `resumePreamble(n)` is role-agnostic and has one call site, `extensions/coordination/spawn-worker.ts:96`, via `composeTaskArg`); `lib/backoff.ts` (`noteRateLimit` halves on every call; `limit()` restores only through `noteCleanFinish`; `lib/backoff-test.ts:23-31` asserts "halves again"); `extensions/worker-guard/policy.ts` (`siblingWorktrees`, `.find(w => inside(w, abs))` at two call sites takes the first match, and the `.foreman` allowance for sibling worktrees only runs when `rel === null`, so a worktree nested inside the root is denied); `extensions/worker-guard/vars.ts` (`expandForLoop` body checks reject `NAME=` and `read/unset/break/continue` but not `printf -v NAME`, `declare`, `mapfile`, `getopts` on the loop variable); `extensions/coordination/coordinator.ts` (`delegate`, `finishTask`, `recover`, `persist`, `formatBlock`, `checkIdle`, `Notification`); `extensions/foreman-mode/{index,prompts}.ts`; `extensions/session-reminder/index.ts` (orientation only for `startup`/`new` already; `BASE_REMINDER` is re-sent on every `resume`/`fork`/`reload`); `lib/plan-steps.ts` (no `Status` or `Checks` parser); `skills/*/SKILL.md`; `agents/planner.md` (template says `(File: ...)`, the parser reads `(Touches: ...)`); `references/worker-common.md` (5,634 chars before Phase B step 8); pi `docs/skills.md` (`disable-model-invocation` documented, lines 53 and 79).

## Architecture changes

- `lib/backoff.ts`, `lib/retry.ts`: pool decay and per-burst halving, kill-aware back-off, role-aware resume preamble (steps 1, 2).
- `extensions/worker-guard/{policy,vars}.ts`: innermost-worktree match, loop-variable rebinding check (steps 3, 4).
- `extensions/coordination/spawn-worker.ts`: injectable deps seam plus new `spawn-worker-test.ts` (step 5).
- `lib/plan-steps.ts`: `parseStatusSection`, `parseStepChecks`, `parseRendersYes`, `readPlanText` (step 6).
- `extensions/coordination/coordinator.ts`: attempt history (C1), `report:` line (A8), `verified:` line from new `lib/verify-checks.ts` (C6) (steps 7, 8, 9).
- New `lib/plan-preflight.ts`, `lib/resume-state.ts`; `extensions/foreman-mode/{index,prompts}.ts`; `extensions/session-reminder/index.ts` (steps 10 to 12).
- New `references/foreman-audit.md`, `references/foreman-delegation.md`, `references/grilling-fallback.md`; slimmer `skills/foreman/SKILL.md`; rewritten `references/worker-common.md`, `templates/*.md`, `agents/*.md` (steps 13 to 19). New `lib/skills-test.ts` (step 20).

## Steps

1. **Back-off pool: per-burst halving and time decay** (Touches: `lib/backoff.ts`, `lib/backoff-test.ts`, `README.md`, `README.pt-BR.md`)
   - Item: Phase A minor (degraded pool).
   - Action: `noteRateLimit` halves only when no pause is active (`now() >= pausedUntil` before the call); a 429 inside the current pause is the same burst: extend `pausedUntil` as today, no extra halving. `limit(max)` lazily restores one slot per `decayMs` elapsed since the last `noteRateLimit` and clears `degraded` at the ceiling. `decayMs` is an option, default from env `FOREMAN_BACKOFF_DECAY_S` x 1000 read when `sharedGate` is built (default 300; `0` disables decay = today's behaviour). `noteCleanFinish` unchanged. No timer: `pump()` already calls `gate.limit` on every finish and delegate. Add the variable to the env tables of both READMEs.
   - Why: with halving per worker 429, N parallel workers collapse concurrency to 1; and a pool whose workers all end blocked never restores.
   - Risk: low-medium (changes a documented behaviour; `lib/backoff-test.ts:25-26` and `:31` assert the old per-call halving and are rewritten deliberately, say so in the report).
   - Checks: `npm run test:backoff`, `npm run test:coordination`, `npm run test:readme`. Named tests: `second 429 inside the pause does not halve again`, `429 after the pause expired halves again`, `limit restores one slot per decay interval (fake clock)`, `decay 0 disables restoration by time`, `clean finish still restores one slot`, `pause still extends to the longest retry-after`, `README documents FOREMAN_BACKOFF_DECAY_S in both languages`.
   - Renders: no

2. **Retry: kill cancels back-off; role-aware resume preamble** (Touches: `lib/retry.ts`, `lib/retry-test.ts`)
   - Item: Phase A minors (sleep not cancelled by kill; role-agnostic preamble).
   - Action: in `runWithRetry`, race every back-off wait against a promise that `kill()` resolves, so `done` settles at once and no wait outlives the kill (keep the default sleep's `unref` and clear its timer). `resumePreamble(n, role?)`: `role` optional so the current call compiles until step 5. A `RESUME_MODE` map keyed by role string: `reviewer`, `qa`, `codebase-auditor` = restart (nothing of yours to preserve; start again from the handoff; write the foreman-report; no commit text); `planner` = plan (check whether the plan file named in the handoff exists under `docs/plans/`; continue it with `edit`, else start; no commit text); `shipper` = git-state (`git status`, `git log -3`, `git branch -vv`; do not repeat a commit or push already there); `frontend-dev`, `backend-dev`, `qa-bugfix`, `plan-step-builder` and `undefined` = today's text. A role string not in the map restarts (no commit instruction for an unknown role).
   - Why: `kill()` is documented to cancel a pending back-off but does not; "commit only your own paths" is wrong for read-only roles.
   - Risk: low.
   - Checks: `npm run test:retry`. Named tests: `kill during a never-resolving back-off resolves done immediately`, `kill before the first back-off still stops retries`, `reviewer preamble says restart and never mentions commit`, `writer roles keep git status, git log, commit only your own paths, foreman-report`, `planner preamble names docs/plans and edit`, `shipper preamble forbids repeating a commit or push`, `every ROLES entry has an explicit mode (imports lib/roles.ts)`, `unknown role restarts`, `existing retry cases unchanged`.
   - Renders: no

3. **Guard: nested worktrees, innermost match** (Touches: `extensions/worker-guard/policy.ts`, `extensions/worker-guard/smoke-test.ts`)
   - Item: Phase A minor (guard sibling-worktree rule for nested worktrees).
   - Action: add `owningWorktree(root, abs)` returning the innermost (longest path) entry of `siblingWorktrees(root)` that contains `abs`; use it at both existing call sites in `pathProblem` and also when `rel !== null`: for `scoped`/`shipper` roles a path under a nested linked worktree (for example `<root>/.worktrees/x/.foreman/...`) is allowed only when its first segment below that worktree is `.foreman`; everything else under it keeps today's verdict. `abs` is already resolved, so `.foreman/../src` cannot match. Dev kinds keep `.git` and real-`.env` denials inside nested worktrees. No change to denial texts.
   - Why: with root = a plan worktree nested in `<main>/.worktrees/`, the main checkout contains every sibling, `find` picks it first and denies a sibling's `.foreman`.
   - Risk: medium (security-relevant; fail closed on any doubt).
   - Checks: `npm run test:worker-guard`. Named tests (real `git worktree add` fixtures like smoke-test.ts:830): `qa may write <root>/.worktrees/a/.foreman/x from the main root`, `qa may not write <root>/.worktrees/a/src/x`, `from root a, qa may write ../b/.foreman/x when b is nested under main (innermost wins)`, `shipper same as qa`, `nested worktree .git and .env still denied for dev roles`, `.foreman/../src through a nested worktree denied`, `existing sibling-worktree cases (smoke-test.ts:830-869) unchanged`.
   - Renders: no

4. **Guard: loop variable rebinding (`printf -v`)** (Touches: `extensions/worker-guard/vars.ts`, `extensions/worker-guard/smoke-test.ts`)
   - Item: verify the `expandForLoop` `printf -v` suspicion with a reproduction.
   - Action: first add the reproduction through the public entry `checkBash`: `for s in x y; do printf -v s '../src/%s' "$s"; echo hi > .foreman/$s; done` for role `qa`. Read from the code: the guard sees `echo hi > .foreman/x` (allowed) while the shell writes `.foreman/../src/x`. Run it and record the verdict. If it is allowed (hole confirmed), fix in `expandForLoop`: return the command unchanged (so the `$VAR` path stays denied) when the loop variable appears as a bare word in the body (the same bare-word rule `resolveLiteralVars` already applies), which covers `printf -v`, `declare`, `typeset`, `local`, `readonly`, `mapfile`, `readarray`, `getopts`. If it is already denied, keep the test as a regression and say so; do not change `vars.ts`. If Phase B step 12(c) landed a case with the same name, extend it rather than duplicate.
   - Why: the guard is the only boundary for worker writes; the repro was not run while planning (see Risks).
   - Risk: low-medium (a loop variable whose name equals a literal body word now falls back to deny: documented false positive, acceptable).
   - Checks: `npm run test:worker-guard`. Named tests: `for-loop with printf -v on the loop variable is denied or judged on the runtime path`, `declare, mapfile and getopts on the loop variable denied`, `plain literal for-loop still unrolled (C5 cases unchanged)`, `loop var named like a literal body word falls back to deny`.
   - Dependencies: requires step 3.
   - Renders: no

5. **spawnWorker: deps seam, role-aware resume wiring, behavioural test** (Touches: `extensions/coordination/spawn-worker.ts`, `extensions/coordination/spawn-worker-test.ts`, `package.json`)
   - Item: Phase A minor (behavioural test for `spawnWorker` wiring) plus step 2 wiring.
   - Action: `spawnWorker(req, deps?: Partial<{ runPiJson; gate; retry: Pick<RetryOptions,"sleep"|"baseMs"> }>)`, defaults are today's imports, so `coordination/index.ts` and `CoordinatorDeps.spawn` are unchanged. Pass `agent.name` to `resumePreamble(resume.n, agent.name)` at the `composeTaskArg` call. New test drives `spawnWorker` with a scripted fake `runPiJson` (no `pi` process), real package agents, `FOREMAN_ISOLATE=never` (one case `always` on a temp git repo), herdr env cleared, fake `sleep`.
   - Why: the spawn path (argv, env, footer, resume, gate, isolation) is only covered by prompt-level tests today.
   - Dependencies: requires step 2.
   - Risk: medium (module-level `activeWriters`; tests release it by awaiting `done`).
   - Checks: `npm run test:spawn-worker` (new), `npm run test:coordination`. Named tests: `argv carries --tools from the agent frontmatter and --append-system-prompt with the contract`, `Task arg is handoff plus footer naming the worker cwd`, `env has FOREMAN_PI_SUBAGENT=1 and FOREMAN_PI_ROLE`, `FOREMAN_WORKTREE only when isolated`, `transient failure after output resumes with the role-aware preamble first (reviewer restart, builder commit-only-your-paths)`, `transient failure with no output re-runs the original Task without preamble`, `rate limit calls gate.noteRateLimit with the back-off`, `onAttempt fires for attempts >= 1 and onEvent is forwarded`, `unknown role returns a spawnError handle`, `oversized handoff becomes a pointer and still gets the footer`, `kill reaches the running attempt and releases the writer slot`.
   - Renders: no

6. **Plan parsers: Status section, Checks, Renders** (Touches: `lib/plan-steps.ts`, `lib/plan-steps-test.ts`)
   - Item: shared base of D1 and C6.
   - Action: add, in the file's best-effort style (never throw): `parseStatusSection(md)` returning a map step to `{state, note?}` for lines `- Step N: <state>` under `## Status`, or `undefined` when the heading is missing; `parseStepChecks(md, step)` reading the step's block (from its `N. **` line to the next numbered bold line or `## `) and returning `{ npmScripts, other }` from the backticked spans of its `- Checks:` bullet (`npm run <name>` gives `<name>`, `npm test` gives `test`; anything else goes to `other`); `parseRendersYes(md)` returning the steps whose block says `Renders: yes`; `readPlanText(root, slug)` with the slug validation `readStepTitle` already uses.
   - Risk: low.
   - Checks: `npm run test:plan-steps`. Named tests: `status section parsed with states and notes`, `missing Status heading returns undefined`, `checks bullet yields npm scripts and others`, `Checks of one step do not leak into the next`, `Renders: yes steps listed`, `unsafe slug returns undefined`, `parsers run on docs/plans/reliability-phase-b.md and find its 12 steps and Status lines`.
   - Renders: no

7. **C1: circuit breaker for repeated identical failures** (Touches: `extensions/coordination/coordinator.ts`, `extensions/coordination/smoke-test.ts`)
   - Item: C1.
   - Action: keep `attempts: Map<"<slug|->#<step>", Array<{state, reason}>>`. Record in `finishTask` for `completed|failed|blocked` (reason = contract `blockedOn`, else the error, else the summary; collapsed, at most 100 chars); `aborted` is ignored; a `completed` outcome clears the key. `persist` at finish also stores `blockedOn`; `recover()` seeds the map from every entry with a terminal state, so a resumed session keeps the history. In `delegate()` (only when `plan_step` is set): attempt `n` = recorded outcomes + 1; when `n >= 3` and the last two outcomes are `blocked`/`failed`, append to `ack`: ` Attempt N for step S; previous attempts ended: <state (reason)>, ... Do not re-dispatch with reworded text: rule on it (skip, degrade, change approach) or ask the user.` plus `The last two reasons are identical.` when they match. The dispatch still happens: the breaker is advisory (ruling, see Risks). D2's baseline-step degrade is skill text (step 15), not code.
   - Dependencies: requires step 5 (sequential on `coordinator.ts` neighbours).
   - Risk: low-medium.
   - Checks: `npm run test:coordination`. Named tests: `attempts 1 and 2 of a blocked step carry no warning`, `3rd dispatch after two blocked outcomes warns with both reasons`, `failed plus blocked counts`, `a completed attempt resets the count`, `different plan steps are tracked separately`, `no plan_step never warns`, `identical reasons are flagged`, `aborted outcomes are ignored`, `recover() seeds history so a resumed session warns on its first re-dispatch`.
   - Renders: no

8. **A8: report size hint in notifications** (Touches: `extensions/coordination/coordinator.ts`, `extensions/coordination/smoke-test.ts`, `README.md`, `README.pt-BR.md`)
   - Item: A8 (code half).
   - Action: `Notification.reportLines?: number`, set in `finishTask` from the body written to the output file (failed bodies included) and in `recover()` from an existing non-stub report. `formatBlock` prints `report: <N> lines` right after `output:`; absent when unknown. Update the notification example block in both READMEs. Confirm `context-filter` (`BLOCK_RE`) and its smoke test do not pin exact block lines.
   - Risk: low.
   - Checks: `npm run test:coordination`, `npm run test:context-filter`, `npm run test:readme`. Named tests: `completed notification has report: N lines equal to the output file`, `failed body is counted`, `recovered notification counts an existing report, none for a stub or missing file`, `formatBlock omits the line when unknown`, `context pruning unaffected by the new line`.
   - Dependencies: requires step 7.
   - Renders: no

9. **C6: coordinator verifies the step's declared Checks** (Touches: `lib/verify-checks.ts`, `lib/verify-checks-test.ts`, `extensions/coordination/coordinator.ts`, `extensions/coordination/smoke-test.ts`, `README.md`, `README.pt-BR.md`, `package.json`)
   - Item: C6 (post-step check, annotation `verified: yes|no|n/a`).
   - Action: `lib/verify-checks.ts`: `verifyChecks({cwd, planText, step, runSuites, timeoutMs, exec?})` runs `node <PACKAGE_ROOT>/scripts/run-suites.mjs --cwd <cwd> npm:<script>...` with `execFile` (no shell) for the npm scripts from `parseStepChecks` that exist in `<cwd>/package.json` `scripts`; free-text `Checks` are never executed. Returns `verified: yes` (exit 0), `no` (exit 1, note = first `FAIL` line and the `.foreman/qa-logs/` path), or `n/a` with a reason (no parsable scripts, script missing, spawn error, timeout, `run-suites.mjs` missing). In `finishTask`, only for a `completed` `plan-step-builder` with `plan_slug` and `plan_step`, `FOREMAN_VERIFY_CHECKS` not `off`, and no other writer running: cwd is `t.workdir ?? deps.root` (where the merge landed, not the removed isolated path). While verifying, the notification is held (a `verifying` counter joins `checkIdle`, `shutdown` kills the child); any error yields `n/a` and the notification still goes out. A `no` never changes `status`: the orchestrator decides. `formatBlock` prints `verified: yes|no|n/a` (+ note). Env: `FOREMAN_VERIFY_CHECKS` (default on; `off` disables), `FOREMAN_VERIFY_TIMEOUT_S` (default 600), both README tables.
   - Why: two "all green" worker claims were wrong and only a later QA pass caught them; the plan's own Checks are the cheapest independent re-run.
   - Dependencies: requires steps 6 and 8, and Phase B step 7 (`scripts/run-suites.mjs`).
   - Risk: high (async work in `finishTask`, delays the notification by the suite duration, tests run in the shared plan checkout). If it cannot be made safe the foreman may drop this step; nothing later depends on it except one clause in step 15's skill text, which is conditional.
   - Checks: `npm run test:verify-checks` (new), `npm run test:coordination`, `npm run test:readme`. Named tests: `only npm scripts present in package.json are run`, `free-text checks are never executed`, `exit 0 gives yes`, `exit 1 gives no with the first FAIL line`, `timeout gives n/a and kills the child`, `missing run-suites.mjs gives n/a`, `concurrent writer running gives n/a`, `other roles and non-completed statuses are not verified`, `notification waits for verification and idle waiters wait too`, `shutdown during verification kills the child and sends nothing`, `FOREMAN_VERIFY_CHECKS=off skips`, `verified: line appears in formatBlock`.
   - Renders: no

10. **C6: plan-runner preflight block** (Touches: `lib/plan-preflight.ts`, `lib/plan-preflight-test.ts`, `extensions/foreman-mode/prompts.ts`, `extensions/foreman-mode/index.ts`, `extensions/foreman-mode/smoke-test.ts`, `package.json`)
   - Item: C6 (orchestrator probes promises once and tells the user up front); D1 input.
   - Action: `planPreflight({planText, roots, exists, onPath})` returns one short block: `## Status` present or missing (with counts by state), steps with `Renders: yes` and whether a render tool is available (`node_modules/.bin/playwright`, `.venv/bin/playwright` under each root; `playwright`, `chromium`, `chromium-browser`, `google-chrome` on PATH), npm scripts named in `Checks` that are absent from `package.json`. Pure and filesystem/PATH only: no subprocess, no `npx` (it would download). Roots: the orchestrator cwd and the plan's own repo root (two levels above `docs/plans/`). `buildPlanRunnerPrompt(planPath, exists, root, preflight?)` appends it as `--- preflight (gathered by the extension; do not re-run) ---`; the `/plan-runner` handler computes it inside try/catch (failure: no block, never a failed command).
   - Why: the orchestrator has no shell; this is the "gather it yourself, hand it over pre-assembled" pattern from `~/CLAUDE.md`.
   - Dependencies: requires step 6.
   - Risk: low.
   - Checks: `npm run test:plan-preflight` (new), `npm run test:foreman-mode`. Named tests: `Renders: yes steps with no render tool are listed`, `render tool found under node_modules/.bin counts`, `missing npm script is listed`, `missing Status heading is reported`, `no problems prints a one-line all-clear`, `unreadable plan yields no block, command still sends the prompt`, `prompt without preflight is byte-identical to today's`.
   - Renders: no

11. **D3: `/foreman resume`** (Touches: `lib/resume-state.ts`, `lib/resume-state-test.ts`, `extensions/foreman-mode/index.ts`, `extensions/foreman-mode/prompts.ts`, `extensions/foreman-mode/smoke-test.ts`, `lib/i18n/en.ts`, `lib/i18n/pt-BR.ts`, `README.md`, `README.pt-BR.md`, `package.json`)
   - Item: D3.
   - Action: `gatherResumeState(root)`: newest run dir under `.foreman/runs/` with a `run.json` (its `plan_slug`), the last 20 lines of `.foreman/plan-runner/<slug>/progress.md`, the plan's Status table (`readPlanText` + `parseStatusSection`), orphans = task jsons of the newest two runs whose state is `running|queued|aborted`, each with the last action from `<task>.status.json` and the latest task's `workdir`; `undefined` when there is no run dir. `buildResumePrompt(state, {includeSkill})`: the pre-assembled state, the rule "re-dispatch what is unfinished in one response; never a step that is `merged` or `decided`; read an orphan's report path before re-dispatching it", then the plan-runner skill body (slug found) or the foreman skill body. The skill body is omitted when `ctx.sessionManager.getBranch()` still holds the marker line (`--- plan-runner skill ---` / `--- foreman skill ---`) of an earlier embed. Handler: exactly `/foreman resume` (arg equals `resume`, case-insensitive; any other text is a normal request), `enter(ctx)`, no state: `say(t("cmd.resume.none"), "warning")` and nothing sent. Add `resume` to `getArgumentCompletions` and the command description; en and pt-BR catalogs and both READMEs' command tables.
   - Why: the user typed `resume` six times in the directAds run; the extension already owns every fact needed.
   - Dependencies: requires step 10 (same two files).
   - Risk: medium (skill-presence heuristic; if it errs toward including the skill the cost is tokens, never correctness).
   - Checks: `npm run test:resume-state` (new), `npm run test:foreman-mode`, `npm run test:i18n`, `npm run test:readme`. Named tests: `no .foreman/runs returns undefined`, `state lists Status table, ledger tail and orphans`, `workdir comes from the newest task json`, `/foreman resume enters the mode and sends the state`, `/foreman resume with no state warns and sends nothing`, `/foreman resumed the migration is a normal request`, `skill body omitted when the branch already has it, included otherwise`, `plan slug selects the plan-runner skill`, `en and pt-BR catalogs have the same keys`.
   - Renders: no

12. **D4: session reminder once per session** (Touches: `extensions/session-reminder/index.ts`, `extensions/session-reminder/smoke-test.ts`)
   - Item: D4.
   - Action: on `resume`, `fork` or `reload`, when `ctx.sessionManager.getBranch()` already holds a `custom_message` with `customType: "foreman-session-reminder"`, do not queue `BASE_REMINDER`; keep only `missingDelegateWarning` when non-empty. The pre-gathered git/status/listing block stays `startup`/`new` only (already true; lock it with a test). Add `/foreman resume` to `BASE_REMINDER`. Fresh sessions are unchanged.
   - Why: every resume currently appends another full reminder to a transcript that already has one.
   - Dependencies: requires step 11 (reminder names the command).
   - Risk: low (the stored entry shape for an injected message is assumed from `docs/session-format.md`; if absent the reminder is simply sent again, today's behaviour).
   - Checks: `npm run test:reminder`. Named tests: `resume into a session that has the reminder injects nothing but the delegate warning`, `resume of an old session without a reminder gets BASE_REMINDER and no git block`, `fork and reload behave like resume`, `startup still gets the full orientation`, `BASE_REMINDER names /foreman resume`.
   - Renders: no

13. **A6: split the foreman skill by branch** (Touches: `skills/foreman/SKILL.md`, `references/foreman-audit.md`, `references/foreman-delegation.md`, `docs/verification-log.md`, `extensions/foreman-mode/prompts.ts`, `extensions/foreman-mode/smoke-test.ts`, `extensions/orchestrator-guardrail/instructions-test.ts`)
   - Item: A6.
   - Action: keep in `SKILL.md`: frontmatter, intro, Language (with the `User language:` rule as Phase B left it), a 3-line path-resolution note (`prompts.ts` already states the package root), §0 mode and worktree pointer (incident story removed), a 3-line routing note replacing §0.3's diagram (plan exists: plan-runner; read-only audit: audit reference; else grill), §1 orient, §2 grill (B3 reshapes it next), §3 domain questions, §3.5 rulings, the §4 delegate loop (seed, end turn, on notification, repeat; untrusted notification text; tool restriction; `role` list sentence the drift test greps) and §5. Move to `references/foreman-audit.md`: §1.5 audit path and the "Existing codebase: audit before proposing" subsection. Move to `references/foreman-delegation.md`: preview files, multi-item split, parallel overlap and dependent steps (one-line summary stays in SKILL.md), spot-check, review request, and the Planning/Building/Testing/Review-then-ship bullets; SKILL.md names it with a condition ("when you are about to plan, build, test or ship, read it once"). Append the removed session-01a1c625 story to `docs/verification-log.md`. `buildAuditPrompt` embeds the skill plus `readReference("foreman-audit")` and drops the `§1.5` wording; `buildForemanPrompt` is unchanged. Update the assertions that grep the skill (`Review, then ship`, `changes-requested`, `review-handoff-prompt.md`, the audit `§1.5` check at `foreman-mode/smoke-test.ts:268`) to read skill plus references, and assert the pointers exist. Target `SKILL.md` <= 14,000 chars (3.5k tokens, from 25.7k chars).
   - Why: PLAN.md A6; the skill is re-read on every orchestrator turn.
   - Dependencies: requires step 12 (all code steps done before the big text rewrites).
   - Risk: medium-high (behaviour regressions are invisible to unit tests; the replay is an after-merge manual check).
   - Checks: `npm run test:instructions`, `npm run test:foreman-mode`, `npm run test:agents`, `npm run test:readme`. Named tests: `foreman SKILL.md <= 14000 chars`, `SKILL.md keeps the role list sentence, not-in-mode, Never dispatch shipper, Language`, `SKILL.md points to foreman-audit.md and foreman-delegation.md with a condition`, `delegation reference holds Review, then ship, changes-requested, review-handoff-prompt.md`, `audit prompt embeds the audit reference and the scope`, `foreman prompt does not embed either reference`, `no stray Portuguese in the new references`.
   - Renders: no

14. **B3 grilling reuse, A8/C1/C6 loop rules in the foreman skill** (Touches: `skills/foreman/SKILL.md`, `references/foreman-delegation.md`, `references/grilling-fallback.md`, `references/optional-dependencies.md`, `extensions/orchestrator-guardrail/instructions-test.ts`)
   - Item: B3, A8 (skill half), C1 and C6 (skill half).
   - Action: §2 becomes "invoke the `grilling` skill (or `grill-me`); if neither is in your skills list, read `references/grilling-fallback.md`" with the old fallback interview moved there verbatim; `optional-dependencies.md` lists `grilling` and `grill-me` accordingly. §4 loop step 3 gets: read `output` only when status is not `completed` or the summary leaves a question, with `limit`, using `report: N lines` to decide; an ack that says `Attempt N` is a stop sign (§3.5: rule or ask, never reword and re-dispatch); a `verified: yes` completed notification counts as the independent re-run for the step's declared Checks (spot-check rule in the delegation reference), `verified: no` is not green.
   - Dependencies: requires step 13.
   - Risk: low.
   - Checks: `npm run test:instructions`, `npm run test:agents`. Named tests: `skill §2 names grilling and the fallback reference`, `grilling-fallback.md exists and has the interview prompts`, `skill loop mentions report:, Attempt and verified:`, `optional-dependencies lists grilling`.
   - Renders: no

15. **D1, D2, C1, C6, A8: plan-runner skill and builder agent** (Touches: `skills/plan-runner/SKILL.md`, `agents/plan-step-builder.md`, `extensions/orchestrator-guardrail/instructions-test.ts`, `lib/agents-test.ts`)
   - Item: D1, D2, C1 (skill half), C6 (step 0), A8 (skill half).
   - Action: `plan-runner/SKILL.md`: §0 reads the preflight block and tells the user once what it found (screenshots that cannot render, missing Check commands), then continues and keeps the affected steps for the reviewer handoff; §1 makes the plan's `## Status` the source of truth: when the preflight says it is missing, dispatch one `plan-step-builder` with `plan_step: 0` and a three-line handoff that adds `## Status` (`- Step N: not started` per step) and commits only the plan file; §2 adds the D2 rule (a step whose job is recording the test baseline gets one attempt; on `blocked`/`failed` record a ruling "baseline unavailable", mark it `decided` in Status, tell the user, continue; later steps report failing names without a baseline file), the C1 rule (an `Attempt N` ack means rule or ask), the A8 read rule and the `verified:` meaning. `agents/plan-step-builder.md`: when the build instructions are `none` or silent on status, set the step's line in `## Status` to `merged` as the last commit and say so; baseline step: run the suite once, and if it cannot complete report `completed` with Summary `baseline unavailable: <reason>` and write no baseline file.
   - Dependencies: requires step 14.
   - Risk: medium (the `plan_step: 0` bootstrap is new; if rejected the skill falls back to asking the user to add the section).
   - Checks: `npm run test:instructions`, `npm run test:agents`. Named tests: `plan-runner names ## Status, preflight, baseline unavailable, Attempt, report:, verified:`, `plan-runner still has Build instructions and Language`, `builder agent mentions Status merged and baseline unavailable`, `never lists unchanged`.
   - Renders: no

16. **B2 planner template: Seams, Out of scope, Status, preflight** (Touches: `agents/planner.md`, `lib/agents-test.ts`, `extensions/orchestrator-guardrail/instructions-test.ts`)
   - Item: B2, plus the C6 planner pre-flight and the D1 Status heading.
   - Action: in the plan format, add under Testing strategy "Seams: prefer existing seams, the highest possible, ideally one", add `## Out of scope`, and add `## Status` (`- Step N: not started`) as a standard section. Align the step line with what the code parses: `N. **Title** (Touches: ...)` plus `- Checks:` and `- Renders:` bullets (today the template says `(File: ...)`, which `findParallelOverlaps` and step 9 never read). Add a pre-flight rule to "Planning evidence": for each `Renders: yes` step name the capture tool and confirm it exists (`command -v`, `ls node_modules/.bin`); for each `Checks` entry confirm the runner exists; list gaps under Risks. Keep `Touches`/`Checks`/`Renders` otherwise as they are. `lib/plan-steps.ts` needs no change.
   - Dependencies: requires step 15.
   - Risk: low (ruling on the `File:` to `Touches:` alignment, see Risks).
   - Checks: `npm run test:agents`, `npm run test:instructions`, `npm run test:plan-steps`. Named tests: `planner.md has Seams, Out of scope and Status in its format`, `planner step line uses Touches and Checks`, `a plan following the template parses: title, touches, status, checks (fixture in lib/plan-steps-test.ts)`, `planner frontmatter unchanged`.
   - Renders: no

17. **C6: reviewer QA coverage** (Touches: `agents/reviewer.md`, `templates/review-handoff-prompt.md`, `skills/plan-runner/SKILL.md`, `references/foreman-delegation.md`, `extensions/orchestrator-guardrail/instructions-test.ts`)
   - Item: C6 (reviewer asks for a `qa` pass on any range changed after the last QA).
   - Action: the review template's "QA results to cite" gains `QA covered up to: <sha or none>`. The reviewer compares it with `HEAD_SHA`; if they differ (or `none`) and `git diff --stat <QA_SHA>..HEAD` touches non-doc paths, it reports a finding `qa-needed: <QA_SHA>..<HEAD_SHA>` and, with no code defects, `Verdict: changes-requested`. The plan-runner skill and the delegation reference say: a verdict whose only finding is `qa-needed` means dispatch `qa` over that range, then ship if it is green (no second review unless `qa` finds problems).
   - Dependencies: requires step 16.
   - Risk: low-medium (one extra round trip when code changed after QA; deliberate).
   - Checks: `npm run test:instructions`, `npm run test:agents`. Named tests: `review template has QA covered up to`, `reviewer.md names qa-needed and the diff --stat rule`, `skills and delegation reference route qa-needed to qa`, `reviewer stays read-only (tools line unchanged)`.
   - Renders: no

18. **B1: worker-common and worker-guard docs** (Touches: `references/worker-common.md`, `references/worker-guard.md`, `docs/verification-log.md`, `lib/agents-test.ts`, `extensions/orchestrator-guardrail/instructions-test.ts`, `extensions/coordination/smoke-test.ts`)
   - Item: B1 tasks (1) to (4) for the two shared references.
   - Action: rewrite `worker-common.md` as: Discipline (positive-first bullets), `## Gotchas` (command names must be literal paths; one command per suite; `.foreman/` is the scratch area; `python3 -c` probes limited to imports and prints; a denied command goes under `Guard-denied:` and the worker continues; nested linked worktrees are writable via their `.foreman/` for scoped roles; `git show <sha>:<path>` for baselines instead of stash), the Phase B run-suites block unchanged in substance, baselines (names, never counts; no baseline file means report failing names), no-delegation, language, report contract (unchanged field names). Each rule is stated once there; `worker-guard.md` keeps the policy table, parser notes and honest limits and points to `worker-common.md` for worker-facing rules; add the nested-worktree and loop-rebinding notes from steps 3 and 4. Do not change guard denial wording in `policy.ts`. Move any history to `docs/verification-log.md`. Target `worker-common.md` <= 900 tokens (`ceil(chars/4)` <= 900); if it cannot be reached without dropping a rule, report the real number and the rules that would go, do not force it.
   - Dependencies: requires step 17.
   - Risk: medium (appended to every worker prompt; wording regressions show up as guard denials in live runs).
   - Checks: `npm run test:agents`, `npm run test:instructions`, `npm run test:coordination` (compose test reads the file). Named tests: `worker-common <= 900 tokens`, `worker-common has ## Gotchas with the five listed items`, `at most 3 negation-led bullets in worker-common (hard guardrails only)`, `report contract block and Guard-denied unchanged`, `run-suites command still literal`, `no rule text duplicated between worker-common and worker-guard (spot list of 6 phrases)`, `Package root line and {{PACKAGE_ROOT}} substitution intact`.
   - Renders: no

19. **B1: templates and agent files** (Touches: `templates/handoff-prompt.md`, `templates/handoff-summary.md`, `templates/review-handoff-prompt.md`, `templates/release-handoff-prompt.md`, `agents/backend-dev.md`, `agents/frontend-dev.md`, `agents/qa.md`, `agents/qa-bugfix.md`, `agents/plan-step-builder.md`, `agents/codebase-auditor.md`, `agents/reviewer.md`, `agents/shipper.md`, `agents/planner.md`, `lib/agents-test.ts`)
   - Item: B1 tasks (3) and (4) for templates and agents.
   - Action: per file, delete rule text that `worker-common.md` already carries (point to it instead), delete history, and turn each prohibition that has a positive alternative into the positive form; keep hard guardrails verbatim in meaning (no secrets on disk, no push or PR unless asked, no force-push, reviewer writes nothing, `Verdict:` tokens). Worklist by negation count before the change (`never|don't|do not|must not`): shipper 12, codebase-auditor 10, qa 9, reviewer 6, planner 5, qa-bugfix 5, frontend-dev 4, builder 3, templates 9 together, backend-dev 1. Frontmatter (`tools`, `tier`, `thinking`, `description`) is not touched: `git diff -U0 agents | grep -E '^[-+](tools|tier|thinking|description):'` prints nothing. Report the before/after negation counts.
   - Dependencies: requires step 18.
   - Risk: medium (many files; each rewrite must keep the contract strings the tests grep).
   - Checks: `npm run test:agents`, `npm run test:instructions`, `npm run test:coordination`. Named tests: `negation-led lines per agent file do not increase and total drops (reported, test asserts <= recorded counts)`, `agent frontmatter equals the recorded snapshot`, `contract strings still present (Verdict tokens, Blocked-on: review reference, no push without instruction)`, `no copied Working discipline block`.
   - Renders: no

20. **A7: user-invoked foreman and plan-runner skills, with the load check** (Touches: `skills/foreman/SKILL.md`, `skills/plan-runner/SKILL.md`, `extensions/session-reminder/index.ts`, `extensions/session-reminder/smoke-test.ts`, `lib/skills-test.ts`, `package.json`)
   - Item: A7.
   - Action: add `disable-model-invocation: true` to the frontmatter of both skills (field documented in pi `docs/skills.md`); keep `design-preview` and `project-memory` model-invoked. Descriptions stay (they still list the commands). Reword `BASE_REMINDER`: the model cannot load these skills any more, so for a feature, bug or approved plan it tells the user to run `/foreman` or `/plan-runner <plan>`. New `lib/skills-test.ts` parses all four frontmatters and checks the flags, and that `stripFrontmatter` still yields the body `/foreman` embeds. Step check, run by the builder in the real environment: `cd /tmp && mkdir -p pi-verify && cd pi-verify && timeout 20 pi --no-session --print --verbose "hi" 2>&1 | grep -iE "error|failed to load"`; no output is a pass. Fallback: if it prints anything that names the skills or the flag, revert the two frontmatter lines and the reminder wording, keep the test asserting the flag is absent with a comment, and report `Status: blocked` for this step with the output; step 21 proceeds.
   - Why: `pi-claude-cli` resolves skills through the real `claude` CLI (see `~/CLAUDE.md`), so unit tests cannot prove the provider tolerates the flag.
   - Dependencies: requires step 19.
   - Risk: medium (provider interaction; revertable in one commit).
   - Checks: `npm run test:skills` (new), `npm run test:reminder`, `npm run test:foreman-mode`, `npm run test:instructions`, plus the live load check above. Named tests: `foreman and plan-runner have disable-model-invocation: true`, `design-preview and project-memory do not`, `/foreman prompt still embeds the skill body without frontmatter`, `reminder tells the user to run /foreman and /plan-runner`.
   - Renders: no

21. **Close-out: changelog, READMEs, package check** (Touches: `CHANGELOG.md`, `README.md`, `README.pt-BR.md`, `scripts/check-package.ts`, `package.json`)
   - Action: CHANGELOG "Reliability Phase C" under Unreleased (Added: `/foreman resume`, `verified:` and `report:` notification lines, attempt warnings, plan preflight, `FOREMAN_BACKOFF_DECAY_S`, `FOREMAN_VERIFY_CHECKS`, `FOREMAN_VERIFY_TIMEOUT_S`; Changed: foreman skill split, worker-facing text rewrite, user-invoked skills, one-time reminder, planner template; Fixed: kill cancels back-off, role-aware resume, nested worktree guard rule, loop rebinding). Confirm both READMEs list every new env var and command and the new references in their layout section; add the new `references/*.md` files to `REQUIRED_FILES` in `scripts/check-package.ts`; confirm `package.json` `files` already covers `references` and `lib`. No version bump.
   - Dependencies: requires step 20.
   - Risk: low.
   - Checks: `npm test`, `npm run test:package` (needs `pi`; if absent report skipped, not passed).
   - Renders: no

## Testing strategy

- Per step: the named tests fail first, then pass; `npm test` green at every step (typecheck included). Guard steps use real `git worktree` fixtures; spawn and coordinator steps use fakes (no `pi` process, no network).
- Error and partial states are tests: kill during back-off, unknown role, rate limit with and without output (1, 2, 5); denied and allowed nested paths (3, 4); unparsable or missing Status/Checks, unsafe slug (6); aborted and absent outcomes, resumed-session seeding (7); stub or missing report (8); timeout, spawn error, missing `run-suites.mjs`, concurrent writer, shutdown mid-verification (9); unreadable plan, no render tool (10); no run state, mode forced off (11); old session without reminder (12).
- There is no UI; `Renders: no` throughout. The widget, `/foreman-status` and notification renderers are untouched except the two new block lines (steps 8, 9), covered by `formatBlock` tests.
- After-merge manual checks, not gates: (a) replay two grilling sessions and one `/foreman-audit` and compare behaviour with Phase B's build (A6); (b) one real `/plan-runner` on a scratch plan to see the preflight block, a bootstrapped Status section and a `verified:` line; (c) kill `pi` mid-run, start it again and run `/foreman resume`; (d) a real resumed session shows no second reminder (D4); (e) `/foreman` and `/skill:foreman` both still start the workflow with A7 in place; (f) measure the orchestrator system-prompt and skill-body size with `scripts/trace-report.mjs` before/after steps 13 and 20.

## Risks & open questions

- **A6 behaviour is not unit-testable.** Tests prove pointers, size and contract strings, not that the model still follows the moved rules. Mitigation: step 13 is its own mergeable commit, the delegation reference is read once at the first dispatch, and the replay in (a) is the acceptance. Revert path: restore the single-file skill.
- **C6 verification (step 9) is the riskiest code.** It runs project scripts from the coordinator, holds notifications, and the shared checkout may be touched by another worker. Mitigations: npm scripts present in `package.json` only, never free text; `n/a` when another writer runs; `FOREMAN_VERIFY_CHECKS=off`; any error degrades to `n/a`. If review judges it too invasive, drop step 9; step 15's `verified:` clause is conditional text and can be trimmed.
- **C1 is advisory, not a refusal (ruling).** PLAN.md C1 words the behaviour as text in the delegate result. A hard refusal needs an override parameter (schema tokens on every request) so it is left out; the ack fires from the 3rd dispatch and the skill text makes it a stop sign. Revisit if a replay shows it ignored.
- **`File:` to `Touches:` alignment in the planner template (ruling, step 16).** B2 says leave `Touches` as it is, but `agents/planner.md` does not mention it; without the alignment `findParallelOverlaps` and step 9 never fire on planner-made plans.
- **`qa-needed` rule adds a round trip (step 17).** Chosen over a soft note because only `Verdict: changes-requested` triggers orchestrator action; kept to one `qa` pass without a second review.
- **`printf -v` hole is derived from reading `vars.ts`, not run.** The planning guard denied the `timeout` wrapper for a probe and the probe was not retried or worked around. Step 4 starts with the reproduction and only changes code if it confirms.
- **Nested-worktree behaviour assumes `git worktree list --porcelain` reports nested worktrees as normal entries** (standard git; step 3 tests with real worktrees).
- **A7 depends on the provider.** Fallback is defined in step 20; the rest of the plan does not depend on it.
- **D4 assumes the injected reminder is stored as a `custom_message` entry** (shape per pi `docs/session-format.md`, not exercised here). Wrong assumption means the reminder is resent as today.
- **D3's skill-presence check is a heuristic** over `getBranch()`; after a compaction the embed may be summarised away and the skill is then included again (token cost only).
- **B1's 900-token target may be unreachable** once Phase B's run-suites block and the Gotchas section are in; step 18 reports the real number rather than dropping rules.
- **Phase B drift.** At planning time HEAD already had Phase B steps 5 and 6 merged and step 7 in progress; this plan assumes the Phase B end state. Builders re-read files and treat cited line numbers as hints; `instructions-test.ts` is edited by Phase B step 6 and by steps 13 to 19 here.
- **Notification size.** `report:` and `verified:` add about 20 tokens per notification; A8's read discipline is meant to save far more. Measure with trace-report after the merge.
- **Unverified by running while planning:** `npm test` baseline, the load check, the `printf -v` repro and every claim about runtime behaviour of pi 1.5.2 beyond the cited docs.

## Success criteria

- [ ] A burst of rate limits halves concurrency once, and a degraded pool recovers by time as well as by clean finishes (step 1)
- [ ] `kill()` during back-off returns at once; reviewer, qa, auditor, planner and shipper resume with their own preamble, writers unchanged (steps 2, 5)
- [ ] A nested linked worktree's `.foreman` is writable for scoped roles and the innermost worktree decides; the `printf -v` case has a reproduction test and is denied (steps 3, 4)
- [ ] `spawnWorker` has a behavioural test covering argv, env, footer, resume, gate and isolation (step 5)
- [ ] The 3rd dispatch of a step after two blocked or failed outcomes carries an attempt warning with reasons, also after a session resume (step 7)
- [ ] Notifications carry `report: N lines` and, for plan-step builders with parsable Checks, `verified: yes|no|n/a` (steps 8, 9)
- [ ] `/plan-runner` hands the orchestrator a preflight block and `/foreman resume` rebuilds the run state without the user typing it (steps 10, 11); a resumed session does not get a second reminder (step 12)
- [ ] `skills/foreman/SKILL.md` is <= 14,000 chars with audit and delegation detail behind conditional pointers; grilling reuses `grilling` (steps 13, 14)
- [ ] plan-runner enforces a plan `## Status`, the baseline-unavailable rule and the attempt rule; the planner template has Seams, Out of scope, Status and aligned `Touches`/`Checks`; the reviewer reports `qa-needed` (steps 15 to 17)
- [ ] `worker-common.md` <= 900 tokens (or the real number reported) with a Gotchas section; agent and template negation counts drop with frontmatter untouched (steps 18, 19)
- [ ] `foreman` and `plan-runner` are user-invoked and the load check prints nothing, or step 20 is reported blocked with its revert applied (step 20)
- [ ] `npm test` and `npm run test:package` pass; CHANGELOG, READMEs and `check-package` updated (step 21)

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
- Step 13: not started
- Step 14: not started
- Step 15: not started
- Step 16: not started
- Step 17: not started
- Step 18: not started
- Step 19: not started
- Step 20: not started
- Step 21: not started

## Out of scope

- Phase A and B items not named here: E1 follow-ups, `scripts/herdr-tail.mjs` live activity, `handoff_file` for `foreman_delegate`, LLM-assisted compaction, writing the user's `settings.json`, `ctx.getContextUsage()` nudging.
- Phase B optional step 12 items (a) and (b) (comment move, `workdir-fallback:` line); only the `printf -v` case is picked up here (step 4).
- A hard-refusal circuit breaker and any new `foreman_delegate` parameter (C1 stays advisory).
- Sharing the Status parser with `extensions/context-filter/compaction.ts` (a Phase B file with its own parser); a later refactor.
- Auto-installing Playwright or any render tool; `npx` probing; running free-text `Checks`.
- Multi-plan `/foreman resume`, resuming from a ledger other than the newest run.
- Changing guard denial wording in `policy.ts`, `extensions/model-fallback/`, `AGENTS.md`, the pinned Model fallback README section, and the package version.
- Behavioural replays of A6/A7 as automated gates (after-merge manual checks only).
