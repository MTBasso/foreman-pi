# Implementation Plan: foreman-pi 0.2.0 — hardening, bilingual workflow, markerless orchestrator mode

Status: APPROVED by user. Branch: feat/foreman-pi-hardening, one commit per phase, each independently mergeable. No push or PR without the user's word.

## User decisions (approved)

- Worker report delimiter: `--- foreman-report ---`.
- Model tiers are named (`strong|mid|cheap`) with no hardcoded model ids.
- Reviewer = strong tier, shipper = mid tier.
- `/foreman off` aborts running workers only after an explicit confirm; with no UI it refuses.
- `release-manager` is dropped, with no alias.
- `plan-step-builder` gets a lighter worker-guard profile.
- Author `Matheus Basso <matheusbasso@proton.me>`, version `0.2.0`, plus a `CHANGELOG.md`.
- Bilingual: English + pt-BR.
- The `.orchestrator-active` marker is removed entirely.
- **HARD CONSTRAINT:** never touch `extensions/model-fallback/` (including comments) or `AGENTS.md`.

## Overview

foreman-pi 0.2.0 ships in 10 phases on branch `feat/foreman-pi-hardening`, one commit per phase, each independently mergeable. The phases cover:
- a shared `lib/` and removal of the vendored dispatcher;
- packaging and CI;
- a worker report contract and prompt cleanup;
- model tiers;
- a small `lib/i18n.ts` (English and Brazilian Portuguese);
- session-state orchestrator mode with slash commands, status bar and widget, **with the `.orchestrator-active` marker removed entirely**;
- `reviewer` and `shipper` roles;
- a path-scoped worker write guard;
- docs and release (README, README.pt-BR, CHANGELOG, version 0.2.0).

Executing this plan does not require deleting a leftover `.orchestrator-active` file. Workers spawned with `FOREMAN_PI_SUBAGENT=1` are exempt from the guardrail.

## Hard constraint (unchanged, overrides everything)

- **Frozen files:** nothing under `extensions/model-fallback/` is touched, including comments, and neither is `AGENTS.md`.
- **`test:fallback`:** the script string stays byte-identical in `package.json`, and `npm run test:fallback` stays in the `npm test` chain.
- **Comment removal:** `model-fallback/index.ts` line 9 cites PLAN.md's "Model fallback (false-positive testing)" section and line 33 cites README.md. Removing those comments is **not planned**. It is listed under "Open decisions" as an optional step that needs the user to lift the constraint explicitly.
- **What stays valid because of that:**
  - **PLAN.md** stays at its path. Its `## Fora do escopo original: fallback de modelo…` section (line 321) is not edited.
  - **README** keeps its `## Model fallback (false-positive testing, not a refusal bypass)` section (README lines 28–57) byte-identical. Phase 10 adds a diff check that compares it to `git show main:README.md`.
- **Hybrid model:** agents still inherit the session model, which may be `foreman/hybrid`, unless an env override is set. An explicit `--model` bypasses the virtual model's fallback layer. This is documented only; no fallback code changes.

## Verified by opening versus assumed

**Verified by opening or running (previous run plus this one):**
- **Previous run:**
  - All `extensions/*`, `agents/*`, `skills/*`, `references/*`, `templates/*`, `docs/plans/*`, PLAN.md, README.md, `package.json` and `tsconfig.json` were read.
  - The coordinator parses only a `[BLOCKED]` first line today, so the report contract is built from scratch.
  - Pi 1.5.2 APIs were confirmed from the docs: `registerCommand`, `ctx.ui.confirm/select/notify/setStatus/setWidget`, `ctx.hasUI`, `appendEntry`, `pi.events`, `sendUserMessage` (on `pi`, not `ctx`), `ctx.sessionManager.getBranch()`, and `session_start` reasons `startup|reload|new|resume|fork`.
- **This run, grep and read:**
  - **Marker references.**
    - Code and tests: `orchestrator-guardrail/{index,smoke-test}.ts`, `coordination/{index,coordinator,spawn-worker,smoke-test,live-rpc,live-phase3}.ts`, `session-reminder/index.ts`, `context-filter/live-rpc.ts`.
    - Docs: `.gitignore` (line 2), `skills/foreman/SKILL.md` §0 plus lines 274, 323 and 353, `skills/plan-runner/SKILL.md` §0 and line 41, `references/{orchestrator-marker,guardrail-troubleshooting,diagnosing-a-run,using-worktrees}.md`, `templates/handoff-prompt.md` ("About `.orchestrator-active`"), `agents/release-manager.md:45`, README, PLAN.md, and the historical `docs/plans/foreman-pi-event-driven-coordinator.md`.
    - `extensions/model-fallback/` has **no** marker reference.
  - **Guardrail behaviour.** `turn_start` filters active tools down to `read, grep, find, ls, foreman_delegate`, and it **deliberately never restores them** when the marker disappears. With no marker, that restore behaviour becomes a real requirement (Phase 7).
  - **Locale.** Pi has no locale or language setting, because grep of the docs and README found only unrelated hits. So locale must come from the environment. Here `LANG=en_US.UTF-8`.
  - **Stray Portuguese in English prompts:** `agents/qa-bugfix.md:21`, `references/code-review-discipline.md:39` and `references/using-worktrees.md:32–33,57`. No other agent or skill file matched.
  - **README sections.** Heading line numbers show the Model fallback section is lines 28–57. The marker-heavy "Live verification" text is lines 58–126, outside it.
  - **PLAN.md headings** are all Portuguese.
  - **Author email.** `git log` shows `matheusbasso@protonmail.com`. The user's decision says `matheusbasso@proton.me`. The plan follows the decision and flags the mismatch below.
  - **Missing directories.** `lib/` and `scripts/` do not exist yet, and `package.json` has `"author": ""`.

**Assumed, to be proven in the named phase:**
- RPC `get_commands` works with no login (Phase 2).
- npm `files` honors `!negation` (Phase 2).
- `node-version-file: package.json` reads `engines.node` (Phase 3).
- `pi.events` delivery semantics: ordering, and sync versus async handlers. Phase 7 starts with a spike on this.
- Restoring tools after `/foreman off` works after `/reload`. The saved tool list is in memory, so the fallback is "union of current active and the built-in defaults present in `getAllTools()`". Proven in Phase 7.
- `pi.changelogPath` is honored (docs read in the previous run; re-grep in Phase 10).

## Final ordering and parallelism

```
P1 lib/ ──► P2 packaging ──► P3 CI
   ├──► P4 contract+prompts ──► P5 tiers ──► P7 mode(no marker) ──► P8 reviewer/shipper ──► P9 worker guard ──► P10 docs/release
   └──► P6 i18n (new files only) ─────────────►P7
```

- **P1 first.** It creates `lib/agents.ts` and `lib/spawn.ts`.
- **P6 is parallel-safe.** It touches only new files plus `package.json` scripts. It must land before P7.
- **P2 and P3** touch `package.json`, `scripts/` and `.github/`, and can run beside P4–P6.
- **Serialize** everything that edits `coordinator.ts`, `spawn-worker.ts` and the skills: P4 → P5 → P7 → P8 → P9.
- **Expected-list updates.** Each phase that adds an extension, command or role also updates the lists in `scripts/check-package.ts`.
- **Language and marker edits to docs** are done in the phase that owns the behaviour. P10 only rewrites the README and carries the model-fallback section over unchanged.

---

## Phase 1 — Shared `lib/`, delete the vendored dispatcher

Status: done

1. **`lib/agents.ts`** — move `extensions/subagent-dispatch/agents.ts`.
   - Keep `discoverAgents(cwd, scope)` with package agents at lowest precedence.
   - Resolve the agents dir with `fileURLToPath(new URL("../agents", import.meta.url))`.
   - Rewrite the header comment, since it is no longer an adaptation.
   - Risk: low.
2. **`lib/spawn.ts`** — extract `getPiInvocation`, the oversized-prompt-to-file logic, and `runPiJson(args, {cwd, env, invocation?})` returning `{done, kill}`.
   - `kill` sends SIGTERM, then SIGKILL after 5s.
   - The invocation is injectable so tests can spawn `node -e`.
   - Risk: medium (moves working code; pinned by the new test).
3. **`extensions/coordination/spawn-worker.ts`** — slim it to delegate to `lib/spawn.ts`. Keep exporting `spawnWorker` and `MAX_INLINE_PROMPT_BYTES`, and fix its header. Requires steps 1–2.
4. **Delete `extensions/subagent-dispatch/`.**
   - First re-grep for imports. Only `spawn-worker.ts` has one.
   - Fix the stale comment in `coordination/live-phase3.ts`.
   - Leave the guardrail's `subagent` tool-name block (P7 rewrites that file).
5. **`tsconfig.json`** — `include: extensions/**, lib/**, scripts/**`, and drop `exclude`. If `tsc` then fails on typebox, investigate with `--traceResolution` before re-adding an exclusion.
6. **Tests** — add `lib/agents-test.ts` and `lib/spawn-test.ts`.
   - `agents-test`: the old 8-agent discovery assertions plus frontmatter edge cases (`tools` as string or array, missing `name`, user agent overriding a package agent via a temp `PI_CODING_AGENT_DIR`).
   - `spawn-test`: fake child emitting `message_end`, nonzero exit, spawn error, kill escalation, oversized-prompt pointer file.
   - Point `test:agents` at `lib/agents-test.ts` and add `test:spawn`.
7. **Docs** — minimal README Layout fix, and replace the "Why adopt the example…" section with two lines. Do not touch lines 28–57.

- **Tests:** `npm test` is green with no `tsc` exclusion. `grep -rn subagent-dispatch .` shows only historical prose.
- **Success:**
  - [ ] The directory is gone and `tsconfig.json` has no `exclude`.
  - [ ] `git diff --stat` shows nothing under `extensions/model-fallback/`.

## Phase 2 — Packaging manifest, author, real install check

Status: done

1. **`package.json`**
   - Add `pi: {extensions:["./extensions/*/index.ts"], skills:["./skills"]}`.
   - Add `engines.node >=22.19.0`.
   - **Author:** `"author": "Matheus Basso <matheusbasso@proton.me>"`.
   - Add the keywords `foreman` and `orchestrator` alongside `pi-package`.
   - Add `files` with `extensions, lib, agents, skills, references, templates, README.md, README.pt-BR.md, CHANGELOG.md, LICENSE`. Negate `**/smoke-test.ts`, `**/*-test.ts`, `**/live-*.ts` and `agents/models.json`.
   - Add `peerDependencies` at `"*"` for `pi-ai`, `pi-agent-core`, `pi-tui` and `typebox`, matching the Pi docs. Do not tighten them.
   - The version bump and CHANGELOG are Phase 10.
   - Risk: low.
2. **`scripts/check-package.ts`** (`npm run test:package`):
   1. Hash the real `~/.pi/agent/settings.json`.
   2. `npm pack`, extract, and assert the contents.
   3. Sandbox env: `PI_CODING_AGENT_DIR`, `HOME`, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`.
   4. `pi install <extracted dir>`, then assert `pi list` shows it.
   5. `pi --mode rpc --no-session` plus `get_commands`, asserting the skills and commands with `origin:"package"` and no load errors.
   6. `pi --list-models` still lists `foreman hybrid`, which proves `model-fallback` loads untouched.
   7. Import `lib/agents.ts` from the extracted copy and assert the package agents are found.
   8. Re-hash the real settings and assert no change.
   - Cleanup in `finally`. Risk: medium.
   - Fallback if RPC needs a login: `pi list` plus the SDK loader.
   - Each later phase extends the expected command, extension and role lists.
3. **README** — add a short Install paragraph (Phase 10 does the full rewrite).

- **Tests:** run twice for repeatability, and run once with a deliberately broken `files` entry to prove it fails.
- **Success:**
  - [ ] `test:package` passes without a login and the real settings hash is unchanged.
  - [ ] The `test:fallback` script string is unchanged in the diff.

## Phase 3 — CI

Status: done

1. **`.github/workflows/ci.yml`**
   - Triggers: push and PR.
   - Steps: checkout, setup-node (`node-version-file: package.json`, `cache: npm`), `npm ci`, typecheck, `npm test`, `npm run test:package`.
   - Job-level env: `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`.
   - Live scripts never run in CI.
2. **Fallback:** if `test:package` can't run in CI, make it a separate non-required job.

- **Tests:** open a draft PR. A forced `tsc` error turns the run red.
- **Success:**
  - [ ] CI is green on a fresh clone.
  - [ ] CI fails on a deliberately broken test.

## Phase 4 — Report contract, prompt cleanup, package-root injection (language-agnostic)

Status: done

**Contract** (approved), appended to every worker prompt by the spawner:

```
--- foreman-report ---
Status: completed | failed | blocked
Summary: <≤400 chars, in the user's language>
Files: <comma-separated paths, or none>
Rulings: <"Ruling: what — why" lines, or none>
Blocked-on: <what/who, or none>
--- end foreman-report ---
```

1. **`extensions/coordination/coordinator.ts`** — add a pure `parseFinalBlock(report)` returning `{status, summary, files, rulings, blockedOn, contract}`, and wire it into `finishTask` and `recover`.
   - **Language-agnostic parsing:**
     - Field names and status values are matched case-insensitively against the **English** keywords only, so Portuguese prose in `Summary`, `Rulings` or `Blocked-on` never affects parsing.
     - A block with localized keys (for example `Estado: concluído`) is `contract: "malformed"`, not misparsed.
     - Unicode, accents and CRLF are handled.
     - `Summary:` runs to the next known English field label or the end marker, so a Portuguese `Resumo:` line stays inside the summary.
   - **Fallback chain:**
     1. Last well-formed block wins.
     2. A legacy `[BLOCKED]` first line means blocked.
     3. A non-empty report means completed with `contract: missing`.
     4. An invalid `Status:` means `contract: malformed`, then falls to 2 or 3.
   - **Process failures** (nonzero exit, signal, timeout, spawn error, error or aborted `stopReason`, empty output) keep precedence as today.
   - **Block format:** keep `formatBlock`'s leading lines byte-compatible, because the smoke-test regex and `context-filter`'s `BLOCK_RE` depend on them. Append `report-contract: missing|malformed` only when the contract is not met. Put `files`, `rulings` and `blockedOn` in `details.notifications` and the per-task meta JSON.
   - Risk: medium.
2. **`references/worker-common.md`** (new) holds:
   - the shared discipline bullets (edit over bash, self-check, never claim without evidence, stuck twice then stop, don't invent an API);
   - the contract;
   - "workers cannot delegate, only report";
   - a `Package root: {{PACKAGE_ROOT}}` line;
   - **Language rule:** "Write human-readable prose (Summary, findings, questions) in the language given in the handoff's `User language:` field, or the user's language if you can tell it from the handoff, default English. Field names, `Status` values and `Verdict` values always stay English."
3. **`lib/agents.ts` and `spawn-worker.ts`** — compose the prompt as the agent body plus `worker-common.md`. Substitute `{{PACKAGE_ROOT}}` (derived from `import.meta.url`) in both. Requires step 2.
4. **`agents/*.md`**
   - Remove the copy-pasted Working-discipline blocks.
   - Reword descriptions to "dispatched via `foreman_delegate`".
   - **qa:** no "hand off to qa-bugfix"; report the repro and end with `Status: failed`.
   - **frontend-dev, qa, codebase-auditor:** `impeccable` becomes an optional skill ("if listed, use it, otherwise skip").
   - **release-manager:** drop the `npm install -g` auto-install (the role itself is replaced in Phase 8).
   - **plan-step-builder:** replace the hard-coded `.claude/skills/build-plan/SKILL.md` with "read the `Build instructions:` file named in the handoff; if none, follow the step's Touches and Checks".
   - **qa-bugfix:** remove the Portuguese phrase (see the discipline rule below).
5. **`skills/plan-runner/SKILL.md` §2 and `templates/handoff-prompt.md`** — add `Build instructions:` and a **`User language:`** field. The orchestrator fills the second from the user's messages (`en` or `pt-BR`, default `en`).
6. **Claude-Code leftovers.**
   - **`claude plugin install …`:** reword in `references/optional-dependencies.md` and `skills/foreman/SKILL.md` §0.5, §1 and §2.
   - **`references/diagnosing-a-run.md`:** make the header and the transcript line Pi-neutral.
   - **Performative-agreement discipline in both languages.** `references/code-review-discipline.md` states the principle language-independently ("no agreement or gratitude opener before verifying, in any language"). It lists English and pt-BR examples side by side, each pt-BR example line tagged `[pt-BR]`. The same principle goes in `agents/qa.md`, `agents/qa-bugfix.md` and the foreman skill's QA text, with one `[pt-BR]` example each.
   - **`references/using-worktrees.md`:** the Portuguese quoted prompts become "ask the user, in their language".
7. **Language guidance in skills.** Add a short "Language" section to `skills/foreman/SKILL.md` and `skills/plan-runner/SKILL.md`: converse in the user's language (detect from their messages, default English), write handoffs and agents' instructions in English with the `User language:` field, and never translate code, paths, field names or contract keywords.

- **Tests** (in `coordination/smoke-test.ts`):
  - Parser cases: all three statuses; `[BLOCKED]` plus a block; missing block; `Status: done`; two blocks (last wins); a block inside a code fence; CRLF; multi-line `Summary`; empty `Files`; a process failure beating a `completed` block.
  - **Bilingual parser cases:** a Portuguese `Summary` with accents and a `Resumo:` line parses to the right status and summary; a localized-key block gives `contract: malformed`; `Status: COMPLETED` upper case is accepted.
  - Compose test: the prompt for every role contains the contract marker and the language rule, with no raw `{{PACKAGE_ROOT}}`, and the path exists.
  - **`instructions-test.ts`:**
    - No agent file contains `hand off to`, `claude plugin`, `npm install -g` or `.claude/skills`.
    - A **stray-Portuguese lint** scans `agents/`, `skills/`, `references/` and `templates/` for pt-BR diacritics or stopwords. It ignores lines tagged `[pt-BR]`, so the intentional discipline examples pass and any other Portuguese fails.
    - Keep every existing regex assertion green.
- **Success:**
  - [ ] A well-formed block, a missing block and a malformed block each produce the right outcome.
  - [ ] The lint passes, and Portuguese appears only on `[pt-BR]`-tagged lines.

## Phase 5 — Per-agent model tier and thinking

Status: done

Today `agents.ts` parses `model:` only. `spawn-worker.ts` passes `--thinking` only when the agent has no `model`.

1. **`lib/agents.ts`** — add `tier: strong|mid|cheap` and `thinking` (validated against `off|minimal|low|medium|high|xhigh|max`; invalid values are ignored with a note). A literal `model:` is still honored.
2. **`lib/model-policy.ts`** (pure), `resolveModel(agent, env)`:
   - model precedence: `FOREMAN_MODEL_<ROLE>` > frontmatter `model:` > `FOREMAN_MODEL_<TIER>` > unset (inherit the session model);
   - thinking precedence: `FOREMAN_THINKING_<ROLE>` > frontmatter `thinking:` > the session thinking level.
3. **`spawn-worker.ts`** — apply the result and record the chosen model and thinking in the per-task meta JSON.
4. **`agents/*.md`** — no model ids ship, and shipped thinking is at most `high` (the hybrid model offers `off|low|medium|high`).

| Role | Tier | Thinking |
|---|---|---|
| planner | strong | high |
| reviewer (P8) | strong | high |
| shipper (P8) | mid | low |
| frontend-dev, backend-dev, qa-bugfix, plan-step-builder | mid | medium |
| qa, codebase-auditor | cheap | low |

- **Tests:** table tests for precedence, invalid thinking, the inherit case (`foreman/hybrid` passes through unchanged, nothing hard-coded), and arg-building. Live runs stay manual.
- **Success:**
  - [ ] With no env vars, workers inherit the session model and get the frontmatter thinking.
  - [ ] `FOREMAN_MODEL_STRONG` changes only strong-tier roles.

## Phase 6 — `lib/i18n.ts` (parallel-safe)

Status: done

**Design:**
- **Locale selection.** `detectLocale(env)` checks `FOREMAN_LANG`, then `LC_ALL`, `LC_MESSAGES`, `LANG`, and falls back to `en`.
  - `pt`, `pt_*`, `pt-*` map to `pt-BR`.
  - Anything else, including `C` and `POSIX`, maps to `en`.
  - An invalid `FOREMAN_LANG` falls through to the next variable.
  - Pi has no locale setting (verified), so this is the whole mechanism.
- **Catalog API.** `t(key, params?)` resolves the locale per call, so tests can switch env.
  - Catalogs live in `lib/i18n/en.ts` and `lib/i18n/pt-BR.ts`. The pt-BR file is typed `Record<keyof typeof en, string>`, so missing keys are a compile error.
  - A missing key at runtime falls back to `en`, then to the key itself. `{name}` placeholders are interpolated.
- **What gets localized.** Strings a human reads in the UI:
  - command descriptions and notifications;
  - `/foreman-status` labels;
  - status-bar and widget labels;
  - confirm and select prompts and their option labels.
- **What stays English.** Strings the model or machines read:
  - skills, agent prompts and the session-reminder text;
  - guardrail and worker-guard block reasons;
  - coordinator notification blocks, the ledger, and contract keywords.
  - The reminder and skills instead carry the language rule from Phase 4, so the model relays the content in the user's language.

1. Create `lib/i18n.ts` and the two catalogs. Keys are added by P7 and P9 when they introduce strings (a key-registry test fails if a `t("…")` call uses an unknown key).
2. Create `lib/i18n-test.ts` and add `test:i18n` to the chain.

- **Tests:**
  - **Key parity:** identical key sets between `en` and `pt-BR`, and identical placeholder sets per key.
  - **Detection table:** `FOREMAN_LANG` beats `LANG`; `pt_BR.UTF-8`, `pt_PT`, `en_US.UTF-8`, `C`, empty and garbage values.
  - **Fallback:** a missing key falls back to `en`, then to the key.
  - **Interpolation:** placeholders are replaced, and no `{}` leaks into output.
  - Command-string tests in both languages are added in P7.
- **Success:**
  - [ ] `npm test` passes with the parity test.
  - [ ] Removing a pt-BR key fails both `tsc` and the test.

## Phase 7 — Session-state orchestrator mode, commands, status/widget (marker removed)

Status: done

**Step 0 spike result (Ruling, measured on pi 1.5.2's real `createEventBus`, kept as regression tests in `lib/mode-test.ts`):**
- `emit` is synchronous: handlers start in registration order before `emit` returns.
- A handler's return value is ignored and its promise is not awaited; a throwing or rejecting handler is logged and isolated.
- Consequences adopted: mode state handlers are synchronous (so `isActive()` is right after an emit); the `foreman:workers` snapshot is a cache pushed on every change; the abort reply is a callback (`ack`) in the payload plus a bounded wait (7s, longer than the 5s SIGKILL grace; `FOREMAN_ABORT_WAIT_MS` in tests), never an awaited return value. No poll was needed because delivery is synchronous.
- Resume/fork "No" is a request (`foreman:mode:set`) to foreman-mode, which stays the single writer.

### Marker removal: design and consequences

- **Removed entirely.** The marker file is not written, read, gitignored or removed on quit. That covers `MARKER_NAME` in guardrail, coordination and session-reminder, the `.gitignore` line, the `touch` one-liner, and the stale-marker prompt.
- **Mode state lives in three places:**
  1. The persisted custom session entry `foreman-mode`, appended by `pi.appendEntry` and restored from `ctx.sessionManager.getBranch()`.
  2. The `foreman:mode` event on `pi.events`.
  3. The `FOREMAN_PI_MODE=orchestrator` env override for RPC, print and live runs. `off` forces inactive.
- **Precedence:** `FOREMAN_PI_SUBAGENT=1` always means inactive; then the env override; then entry/event state; default inactive.
- **Replaces stale-marker detection:**
  - A fresh `startup` or `new` session has no entry, so it is never locked. A leftover from a dead session cannot exist.
  - On `resume` or `fork`, if the restored entry says active and `ctx.hasUI`, ask `ctx.ui.confirm("Keep orchestrator mode?")`. Yes keeps it. No appends an off entry. A timeout or an unavailable UI keeps the restored state, with no destructive default. The reminder states the mode so the model and user see it.
  - `reload` restores silently.
- **Benefits:**
  - Plain `pi` in a project is never locked by leftovers.
  - Two concurrent pi sessions in the same cwd no longer interfere.
- **Cross-process:** children are exempt via `FOREMAN_PI_SUBAGENT=1`, checked first. A parent's `FOREMAN_PI_MODE` inherited by a child cannot override that (tested). The spawner passes nothing extra.
- **Behaviour changes to document:**
  - Entering the mode needs `/foreman`, `/plan-runner`, `/foreman-audit` or the env var.
  - "Act as my foreman" typed alone, or a bare `/skill:foreman`, does not enter the mode. Skill §0 says: if `foreman_delegate` refuses with a not-in-mode error, tell the user to run `/foreman`, and never try bash or touch files.
- **The old behaviour of never restoring tools becomes a requirement.** With no file to delete, `/foreman off` must restore tools.
- **Leftover file in this repo:** the `.gitignore` line is removed, so the existing untracked `.orchestrator-active` will show up in `git status` until the user deletes it by hand. No code reads or deletes it. This is a consequence of the decision, flagged below.
- **A live session running the old guardrail** keeps blocking until Phase 7 merges and reloads. Workers are exempt, and removing the file is optional.

### Steps

0. **Spike:** read the `pi.events` docs and write a throwaway fake-bus test for delivery order and sync versus async handlers. Everything below that assumes shared-bus semantics follows from it. `FOREMAN_PI_SUBAGENT` is checked before anything else.
1. **`lib/mode.ts`** (new) holds `MODE_ENTRY_TYPE`, `MODE_EVENT` and `createModeTracker(pi)`.
   - `isActive()` follows the precedence above.
   - `restore(ctx, reason)` reads the latest entry from `getBranch()`.
   - It registers its own `pi.events` listener, because extensions may not share a module singleton.
   - Risk: medium.
2. **`extensions/foreman-mode/index.ts`** (new) is the single writer of mode state. It is a no-op when `FOREMAN_PI_SUBAGENT=1`.
   - **`/foreman [request]`:** turn the mode on, append the entry, broadcast the event, set the status line, and `pi.sendUserMessage(embedded skill + request)` (`deliverAs:"followUp"` if busy). The user's request is passed through verbatim in whatever language it was typed.
   - **`/foreman off`:**
     - If workers are running, it reads the cached `foreman:workers` snapshot published by coordination. If `FOREMAN_PI_MODE` forces the mode, it says to unset the env var.
     - **With UI:** `ctx.ui.confirm` with no timeout ("abort N running workers and leave orchestrator mode?"). Yes emits `foreman:workers:abort`, waits for the ack, then turns the mode off. No leaves the mode on and notifies "staying in orchestrator mode".
     - **Without UI:** refuse, say why ("N workers running; run interactively or let them finish"), and stay in the mode. The message goes through `ctx.ui.notify`, with a stderr fallback when there is no UI.
     - With zero workers it just turns the mode off.
   - **`/foreman-audit [scope]`:** enable the mode if needed and embed the foreman skill with an instruction to go straight to §1.5.
   - **`/foreman-diagnose`:** does not enable the mode; it embeds `references/diagnosing-a-run.md`.
   - **`/plan-runner <plan>`:** enable the mode and embed the plan-runner skill plus the path, expanding a leading `~/` itself.
   - **`prompts.ts`:** read the skill, strip the frontmatter, add `Package root:` (embedding rather than `/skill:name`, per the CLAUDE.md gotcha).
   - **All user-visible strings** go through `t()` (`en` and `pt-BR` catalogs updated here).
   - Handlers work with `hasUI` false.
   - Dependencies: steps 0–1 and P6.
3. **`extensions/orchestrator-guardrail/index.ts`**
   - Replace the marker check with `tracker.isActive()`, keeping the subagent exemption first. Remove `MARKER_NAME`, `existsSync` and the marker wording.
   - Reason strings still say "orchestrator mode is on; use `/foreman off` or delegate" (English, model-facing).
   - Rewrite the header comment (drop the marker and `subagent-dispatch` text).
   - **Restore on off:** save the pre-restriction active tools the first time `turn_start` restricts them. On the off event, restore them. If there is no saved list (a reload), union the current tools with the built-in defaults present in `getAllTools()`.
   - Risk: medium.
4. **`extensions/coordination/coordinator.ts` and `index.ts`**
   - Replace both `existsSync(marker)` uses and the error text ("not in orchestrator mode — run `/foreman`").
   - Add `snapshot()` and `onChange(cb)`.
   - Publish `foreman:workers` snapshots on the bus and handle `foreman:workers:abort` (SIGTERM, then SIGKILL after 5s).
   - Register **`/foreman-status`** (localized, needs no model).
   - Add `setStatus("foreman-workers", …)` and a `setWidget` listing running workers with elapsed time plus the last few finished ones with glyphs. Labels use `t()`.
   - Clear it when empty, gate on `hasUI`, and wrap UI calls in try/catch for stale contexts.
   - Risk: medium (widest edit).
5. **`extensions/session-reminder/index.ts`**
   - Delete `staleMarkerNote`, the marker orientation line, `MARKER_NAME`, and the header text that mentions the marker.
   - Add an "Orchestrator mode: active|inactive (source)" orientation line, computed at `before_agent_start` so load order doesn't matter.
   - The reminder text references `/foreman`, `/foreman off`, `/plan-runner` and `/foreman-diagnose`, plus a line: "Converse with the user in the language of their messages (default English)." It stays English because it is model-facing.
   - Keep `missingDelegateWarning` and its tests.
6. **Skills and references.**
   - Rewrite §0 in both skills: entering the mode is the command's job, with no `touch`. Rewrite lines 274, 323 and 353 of the foreman skill and line 41 of plan-runner.
   - Rename `references/orchestrator-marker.md` to `references/orchestrator-mode.md` and rewrite it.
   - Rewrite `references/guardrail-troubleshooting.md` for the new model.
   - Fix `diagnosing-a-run.md:68`, `using-worktrees.md:57`, `templates/handoff-prompt.md` ("About orchestrator mode: it does not apply to you") and the `agents/release-manager.md:45` leftover.
   - Update every other reference to the renamed file.
7. **Live scripts** (`coordination/live-rpc.ts`, `live-phase3.ts`, `context-filter/live-rpc.ts`): set `FOREMAN_PI_MODE=orchestrator` and drop the `writeFileSync(".orchestrator-active")` calls.
8. **`.gitignore`:** remove the `.orchestrator-active` line.
9. **Tests**
   - `orchestrator-guardrail/smoke-test.ts` and `coordination/smoke-test.ts`: drive state through a fake `pi.events` and entry instead of the marker file, with an `events` shim on the fake `ExtensionAPI`.
   - Add `foreman-mode/smoke-test.ts` and `lib/mode-test.ts`.
   - The old marker tests are rewritten, not deleted: write/edit/bash blocked while active, the memory-file exemption, and the subagent exemption.

- **Test strategy:**
  - **State matrix:**
    - The subagent flag wins over an entry, an event and env.
    - A stray `.orchestrator-active` file has no effect (inactive).
    - Entry active means active.
    - `FOREMAN_PI_MODE=off` and `=orchestrator`.
    - `resume`, `fork` and `reload` restore from the entry, with the confirm path covered for yes, no, timeout and no UI.
    - A fresh `startup` and `new` are inactive.
  - **Commands:**
    - Handlers run with `hasUI` false.
    - The embedded prompt contains the skill body and the absolute package root.
    - `~/` plan paths expand.
    - Busy sessions use `followUp`.
    - `sendUserMessage` is called on `pi`.
  - **`/foreman off`:** zero workers; running with confirm yes (workers aborted), no (mode stays) and no UI (refused with a reason); env-forced.
  - **Tools restore:** after off, `bash`, `write` and `edit` return, including after a simulated reload.
  - **Widget and status:** empty, running, finished, failed and cleared states.
  - **Bilingual:** each command's notify, confirm and select labels and the status and widget strings, run under `FOREMAN_LANG=en` and `pt-BR`. The strings must differ per locale, contain no raw placeholders, and the machine-facing strings stay English.
  - **Manual:** one real TUI pass of `/foreman`, `/foreman-status` and `/foreman off`, in both `FOREMAN_LANG` values. Run the live scripts once.
  - **Grep gate:** `grep -rn "orchestrator-active"` in code, skills, references and templates returns nothing outside PLAN.md, `docs/plans/` and CHANGELOG. Those are historical.
- **Success:**
  - [ ] `/foreman` and `/foreman off` toggle the guardrail and `foreman_delegate` in-session, the state survives `/reload` and resume, and tools return after off.
  - [ ] No code reads or writes the marker. A leftover file changes nothing.
  - [ ] Workers are never restricted and never see the mode commands.

## Phase 8 — `reviewer` and `shipper` roles

Status: done

1. **`lib/roles.ts`** (new, pure) is the single `ROLES` list, used by `coordinator.ts` and the `foreman_delegate` enum.
   - **`release-manager` is dropped with no alias.** Add `reviewer` and `shipper`. A drift test fails if the name reappears in code, agents, skills, templates or the README.
2. **`agents/reviewer.md`** (new): tier strong, thinking high, tools `read, grep, find, bash`.
   - It takes the plan or requirement, the base branch and the SHAs, and resolves the SHAs itself if only a branch is given.
   - It reads `git diff BASE..HEAD` and writes no files.
   - **Output:** findings with severity, `file:line` and why, in the user's language, plus `Verdict: approve|changes-requested` inside `Summary`. The verdict tokens stay English so the shipper can check them mechanically.
   - **Status:** `completed` when the review ran, `blocked` when the SHAs can't be resolved, `failed` on error.
3. **`agents/shipper.md`** (replaces `release-manager.md`): tier mid, thinking low.
   - It requires the review reference (reviewer task id, SHAs, verdict) in the handoff. Missing or `changes-requested` gives `Status: blocked`.
   - AgentShield is optional and never installed.
   - Dependent commands run one at a time.
   - It never pushes or opens a PR without the explicit instruction the existing text requires.
   - PR and commit prose follows the user's language, except where the repo's own convention is English (it checks `git log` style).
4. **Templates:** `templates/review-handoff-prompt.md` (new), a Review section in `release-handoff-prompt.md`, and `User language:` in both.
5. **Skills:**
   - `skills/foreman/SKILL.md` §4: the flow is reviewer, then qa-bugfix and re-review if changes are requested, then shipper.
   - `skills/plan-runner/SKILL.md` §3–4: a reviewer pass over the accumulated diff, then a shipper offer.
   - Update the role lists and enums, and the "never" list.
   - Update the requesting-review half of `references/code-review-discipline.md`.
6. **`scripts/check-package.ts`:** the expected role list is updated.

- **Tests:**
  - The `instructions-test.ts` "never `git push` / `gh pr create`" regex now reads `shipper.md`.
  - A drift lint checks that every role appears in the foreman skill's list and the README table.
  - The role enum contains `reviewer` and `shipper` and excludes `release-manager`.
  - `lib/agents-test.ts` has the updated agent set.
  - A shipper handoff without a review yields `blocked`.
  - Parser unaffected: a reviewer report with a Portuguese findings summary and an English `Verdict:` token parses correctly.
- **Success:**
  - [ ] `reviewer` and `shipper` are discoverable and delegable.
  - [ ] `release-manager` appears nowhere.

## Phase 9 — Path-scoped worker write guard

Status: done

1. **Spawner:** set `FOREMAN_PI_ROLE=<role>` next to `FOREMAN_PI_SUBAGENT=1`.
2. **`extensions/worker-guard/policy.ts`** (pure, `checkWrite` and `checkBash`) and **`index.ts`** (a `tool_call` handler).
   - **Gate:** active only when `FOREMAN_PI_SUBAGENT=1` and a role is set. An unknown role fails closed to read-only.
   - **Path resolution:** resolve against `ctx.cwd`, then realpath the nearest existing ancestor to catch `..` and symlink escapes.
   - Block reasons are English and model-facing, and tell the worker to report `Status: blocked` with the reason.
3. **Write policy by role:**
   - **qa, codebase-auditor:** only `.foreman/**` and `FOREMAN_AUDIT.md`.
   - **planner, reviewer:** no write or edit.
   - **shipper:** writes only under `.foreman/`.
   - **frontend-dev, backend-dev, qa-bugfix, plan-step-builder:** anywhere in the repo except `.git/`, outside-root paths and real `.env` / `.env.*` files (examples and templates allowed).
4. **Bash policy.** No allowance by file extension; allow only by resolved directory, and fail closed on anything unresolvable.
   - **Parser:** quote-aware split on `; && || | &` and newlines. Track redirects, skip heredoc bodies, and recurse into `$()` and backticks with a depth cap. Unbalanced quotes, `<(`/`>(` and `eval` are denied.
   - **Redirects:** `/dev/null`, `/dev/stderr` and fd dups (`2>&1`) are allowed. A target containing `$`, a glob or `~` is denied as unresolvable. Everything else must resolve into the role's allowed dirs.
   - **qa and auditor:**
     - Deny `sed -i`, `perl -i`, `patch`, `dd` and mutating git.
     - For `tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `ln`, `truncate` and `install`, every path argument, destination included, must be inside the allowed dirs.
     - Test runners and interpreters stay allowed.
   - **planner and reviewer:** a strict command allowlist.
     - `git` is limited to `log, diff, show, status, rev-parse, merge-base, ls-files, blame, branch --show-current`.
     - `gh` is limited to read-only `pr view/list/diff/checks` and `issue view`.
     - Plain read tools are allowed. `find` with `-exec/-delete/-fprint`, `xargs`, `env`, `sudo` and inline interpreters are denied. Any redirect other than `/dev/null` is denied.
   - **shipper:** git and `gh` are allowed. Deny `push --force`/`-f`, `--no-verify`, `reset --hard`, `clean` and source edits. Redirects are allowed only into `.foreman/`.
   - **Dev roles (frontend-dev, backend-dev, qa-bugfix) — strict profile:**
     - `rm` with recursive and force flags is allowed only on named build-artifact dirs inside the repo (`node_modules`, `dist`, `build`, `.next`, `coverage`, `__pycache__`) and the temp dir.
     - Always denied: any `rm -rf` on `/`, `~`, `$HOME`, `..`, `.`, `.git` or a bare glob; force-push; `reset --hard`; `clean -f*`; `checkout -- .`; `branch -D`; `--no-verify`; `chmod -R`; `mkfs`; `dd of=/dev/*`; `npm install -g`; `curl|wget … | sh`; `sudo`.
     - Redirects must land inside the repo or the temp dir.
   - **plan-step-builder — lighter profile (decided, not a question).** Its build-plan procedure sanctions `rm -rf` for removal and move steps, so it may `rm -rf` **any path that resolves inside the repo**.
     - Never allowed: the repo root or any ancestor of it, `.git`, anything outside the repo (the temp dir excepted), and unresolvable paths (`$VAR`, globs).
     - It still hits the rest of the dev-role denials: force-push, `--no-verify`, `reset --hard`, outside-repo writes, `sudo`, and so on.
5. **Honest limits** go in the docs. This is a heuristic, not a sandbox: interpreters, `make` and `npm run` can write anywhere.
6. **`scripts/check-package.ts`:** add `worker-guard` to the expected extensions.

- **Tests** (about 80 table-driven cases):
  - **Regressions:**
    - `echo hacked > existing.txt` for qa is blocked (the PLAN.md leak).
    - `.foreman/a.txt` is allowed.
    - `.foreman/../src/a.txt` is blocked.
    - A `$F` redirect is blocked.
    - A symlink escape is blocked.
    - `mv a src/b` for qa is blocked.
  - **False positives:** `grep ">" file`, `=>`, `->`, `echo "a > b"`.
  - **Gating:** no subagent flag, no role, unknown role, and orchestrator-guardrail unaffected.
  - **Per-role matrix** over all nine roles.
  - **plan-step-builder:** `rm -rf src/old` allowed; repo root, `.git`, `../x`, `$HOME` and a glob denied.
  - The child env carries `FOREMAN_PI_ROLE`.
  - **Language:** block reasons are English, and a worker prompt in Portuguese does not change the policy.
- **Success:**
  - [ ] The smoke test passes, including the `.txt` regression.
  - [ ] A qa worker cannot edit `src/**` or `package.json`, and planner and reviewer cannot write at all.

## Phase 10 — Docs and release

Status: todo

1. **`README.md`** (English). It contains install, quick start, architecture, the roles table, tiers and env vars, the report contract, mode state, the worker guard and its limits, the tests and CI, and a link to the pt-BR README at the top.
   - **Model fallback section:** byte-identical (lines 28–57). Check by diffing against `git show main:README.md`.
   - **"Live verification" (lines 58–126):** moved to `docs/verification-log.md` with a banner saying it is historical and describes the marker mechanism removed in 0.2.0. Moving it does not touch the frozen section.
2. **`README.pt-BR.md`** — a separate file, not a section in `README.md`.
   - **Why a separate file:**
     - Each file reads linearly in one language.
     - The English README keeps the frozen Model fallback section exactly as is, with no bilingual interleaving to churn it.
     - npm and GitHub render `README.md` by default, and a cross-linked second file is the common convention.
   - It is a full translation, except the Model fallback section: that gets a pointer to the English section instead of a copy, so there is no second copy of frozen text to drift.
   - Both READMEs document `FOREMAN_LANG` and how locale detection works. They also note that the extension UI strings follow the environment locale while the agent conversation follows the user's message language, so `FOREMAN_LANG=pt-BR` may be needed if `LANG` is English.
3. **PLAN.md** — keep in place, in Portuguese. Update only phase-status lines, add a short per-item design note, and add a dated note about the dispatcher removal and marker removal. Never touch the model-fallback section.
4. **`CHANGELOG.md`** (English) with a `## [0.2.0]` section covering:
   - added: contract, tiers, reviewer/shipper, commands, status/widget, worker guard, i18n, CI, manifest;
   - changed: marker-free orchestrator mode;
   - removed: `subagent-dispatch`, `release-manager`, `.orchestrator-active`;
   - upgrade note: a leftover `.orchestrator-active` file is ignored and can be deleted.
5. **`package.json`:** `version` becomes `0.2.0`, and add `pi.changelogPath` after re-grepping the docs.
6. **`AGENTS.md`:** not touched.

- **Tests:** a README test checks the Model fallback section is byte-identical to `main`, and that the README and README.pt-BR role and command lists match the code. A grep gate checks no stale references (`release-manager`, `subagent-dispatch`, marker as mechanism) outside historical docs. Run the load check from CLAUDE.md.
- **Success:**
  - [ ] `git diff main..HEAD -- extensions/model-fallback AGENTS.md` is empty.
  - [ ] Both READMEs are accurate and cross-linked.
  - [ ] The version is 0.2.0 and the changelog entry exists.

---

## Cross-phase testing strategy

- Every phase ends with `npm test` and `npm run typecheck` green, and `test:package` green from Phase 2.
- Every user-facing piece lists its states: empty, running, success, failed, blocked, partial (contract missing or malformed), no-UI (RPC and print), the child-process exemption, and both locales.
- **CLAUDE.md load check** before each merge: `cd /tmp && mkdir -p pi-verify && cd pi-verify && timeout 20 pi --no-session --print --verbose "hi" 2>&1 | grep -iE "error|failed to load"`. It does not exercise command handlers, so those rely on the unit tests above.
- Live scripts (`test:live:*`) stay manual, run after P7 and again after P9 with a real worker.
- `git diff --stat main..HEAD -- extensions/model-fallback AGENTS.md` must be empty at every phase.

## Risks and open questions

**Open decisions (genuinely open):**
- **Optional: remove the model-fallback comments pointing at PLAN.md and README.** This is the "remove the comments" request. It edits `extensions/model-fallback/index.ts` (lines 9 and 33), which the constraint forbids. It is not in this plan. If wanted, the user must explicitly lift the constraint for those two comment lines. Then it becomes one extra step (a comment-only edit, with `test:fallback` re-run). Until then PLAN.md and the README section stay in place so the comments remain valid. One detail: the comment's quoted title, "Model fallback (false-positive testing)", actually matches the README heading, not PLAN.md's Portuguese heading. Neither was changed.
- **Author email.** The decision specifies `matheusbasso@proton.me`. `git log` shows `matheusbasso@protonmail.com`. The plan uses the decision as instructed. Confirm whether the git identity is the right one.
- **Leftover `.orchestrator-active` in this repo.** After the `.gitignore` line is removed, it shows as an untracked file. Delete it by hand when convenient. The plan never reads or deletes it, and the code needs no cleanup logic.
- **Locale mismatch.** With `LANG=en_US.UTF-8`, extension UI strings would be English even if the user writes to the agent in Portuguese. Agent conversation follows the user's messages, while UI strings follow `FOREMAN_LANG` or the system locale. Is that split acceptable, or should the UI language also follow the language of the user's first message? Auto-detection from chat text is not planned.
- **Resume or fork with active mode and a confirm timeout keeps the mode.** Chosen because the entry reflects the user's last explicit choice and `/foreman off` is one command away. Say if the opposite default is wanted.

**Risks (flagged, not decided):**
- **`pi.events` semantics are unproven.** Phase 7 step 0 is a spike. If delivery is async or unordered, the worker-count cache and the abort ack need a poll or a promise-based reply.
- **Tool restoration after `/foreman off` and `/reload`** relies on a saved list or the built-in defaults from `getAllTools()`. A custom tool set the user had before would be lost across a reload.
- **Entering the mode needs a command.** "Act as my foreman", or `/skill:foreman` used directly, does not enter it. The skill text tells the model to ask for `/foreman`.
- **Worker guard is heuristic.** Interpreters and `make` can write anywhere.
- **Deleting `subagent-dispatch`** removes the standalone `subagent` tool for non-foreman use. Nothing in the repo depends on it.
- **Explicit `--model` bypasses `foreman/hybrid` fallback.** This is documented, with no code change.
- **`agents/models.json`** is excluded from the package and otherwise left in place.
- **CI and package-check assumptions** (`node-version-file` reads `engines`; RPC `get_commands` works with no login) are unproven until Phases 2–3 run.
- **pt-BR quality.** The catalogs are written by the builder. A native review of `pt-BR.ts` and `README.pt-BR.md` before release is recommended. The parity tests check structure, not wording.

## Success criteria (overall)

- [ ] All 10 phases are separate commits on `feat/foreman-pi-hardening`, with `npm test` and `npm run test:package` passing at each.
- [ ] `git diff main..HEAD -- extensions/model-fallback AGENTS.md` is empty, `test:fallback` is unchanged, and the README Model fallback section is byte-identical.
- [ ] No code, skill, reference, template or test reads or writes `.orchestrator-active`. Mode state comes only from the session entry, `pi.events` and `FOREMAN_PI_MODE`, and workers are always exempt.
- [ ] `/foreman`, `/foreman off` (with confirm, refusal without UI, and abort of running workers only after confirm), `/foreman-status`, `/foreman-audit`, `/foreman-diagnose` and `/plan-runner` work, with status bar and widget.
- [ ] The workflow runs in English and Brazilian Portuguese:
  - UI strings come from `en` and `pt-BR` catalogs with parity tests.
  - The parser and contract keywords stay English and are unaffected by Portuguese prose.
  - Skills and agents tell the model to converse in the user's language.
  - No stray Portuguese remains outside `[pt-BR]`-tagged lines.
  - The README is in English plus `README.pt-BR.md`.
- [ ] The role set is `planner, frontend-dev, backend-dev, qa, qa-bugfix, plan-step-builder, codebase-auditor, reviewer, shipper`, and `release-manager` is gone with no alias.
- [ ] Tier and thinking resolve with env overrides and still work under `foreman/hybrid`.
- [ ] The worker guard passes its regression and matrix tests, with the lighter profile for plan-step-builder.
- [ ] `pi list` in a sandbox shows the package, everything is discovered from the installed copy, and `foreman hybrid` is still listed.
- [ ] CI runs `npm ci`, typecheck, `npm test` and the package check.
- [ ] `package.json` has the author `Matheus Basso <matheusbasso@proton.me>`, version `0.2.0` and a `CHANGELOG.md` `0.2.0` section.
