# Changelog

## [0.3.3]

### Fixed

From the directAds session, where step 0 (worktree + baseline) was blocked four times in a row and the planner could not check an import:

- Writer roles (incl. `plan-step-builder`) may write inside any linked worktree of the repo (`git worktree list`), e.g. a sibling `../repo-feature`, and may append to `.git/info/exclude`. Other `.git` paths stay denied, and `.git`/real `.env` inside a linked worktree too.
- `for VAR in <literal words>; do ... done` is unrolled before checking, so `>/tmp/o_$n.txt` in a loop over literal names works; each unrolled path is still judged. Loops over `$(...)`, globs, nested loops, or bodies that assign the variable are still denied.
- planner/reviewer may probe: `python3 -c "import x; print(x.__version__)"` (import/from-import/print statements only) and `pip show|list|freeze|check`.
- The worker event log keeps only `message_end` lines (the `message_update` deltas made it huge).

## [0.3.2]

### Fixed

- herdr watch panes: workers started in the same tick all split the orchestrator (side-by-side squeeze) because pane opening raced; it is now serialised so they stack in one column. The orchestrator keeps 60% of the width (the split ratio is the share the existing pane keeps).

## [0.3.1]

### Changed

- herdr watch panes: one column to the right of the orchestrator (workers stack downward in it), so the orchestrator keeps its height; the pane's process is the tail script, which owns the lifecycle: a clean worker lingers ~8s and the pane closes itself, a blocked/failed one stays until you press Enter/q. Compact output: one line per tool call (`write …/src/b.py 300 chars`), successful tool results hidden, errors in red, a summary line (tool calls, errors, elapsed). `LINGER_S` tunes the delay.

## [0.3.0]

### Added

- Worker guard: qa/shipper may write scratch to the temp dir; read-only `git stash list|show`, `git worktree list`, `git branch --list <pattern>`, `git tag -l`; mutating `git stash` is blocked for dev roles (it swept other workers' uncommitted edits in a shared worktree).
- `references/worker-common.md`: a "Working under the worker guard" cheat-sheet and baseline-by-name rules, shown to every worker.
- `scripts/baseline-diff.mjs`: diff failing test names against a baseline file (`NEW:`/`FIXED:`), instead of comparing counts.
- Automatic retry with backoff for workers that die on a 429/5xx before producing output (`lib/retry.ts`).
- Optional herdr integration (`lib/herdr.ts`): inside a herdr pane, mirror live worker counts into the pane title and raise a notification when a worker is blocked or failed. No-op elsewhere.- Worktree isolation for parallel writers (`lib/worktree.ts`): when another writer worker is running, `frontend-dev`/`backend-dev`/`qa-bugfix`/`plan-step-builder` get a private `.foreman/worktrees/<task>` checkout on branch `foreman/<task>`; its work is committed and merged back when it finishes (serialised), and a conflicting merge turns the report into `blocked` with the branch kept. `FOREMAN_ISOLATE=always|auto|never`. Repo hooks are disabled for these git calls.- herdr watch panes: inside herdr, each worker gets a live pane (`scripts/herdr-tail.mjs`) following its event log, closed ~20s after a clean finish and kept open for blocked/failed ones. `FOREMAN_HERDR_PANES=0` disables. The worker stays a child process; the pane is a window onto it, not an attach point.- Render-or-flag gate: the report contract gains `Rendered:` (screenshot paths, `unrendered` or `n/a`), surfaced in task notifications; planner steps carry `Renders: yes|no`; review and release handoffs list unrendered visual steps, and the shipper puts them under "Not verified visually" in the PR.- Worker guard resolves variables assigned a plain literal earlier in the same command (`extensions/worker-guard/vars.ts`), conservatively: no `&&`/`||`/pipes/subshells/loops, single assignment, never inside single quotes or heredoc bodies. The planner may save `docs/plans/<name>.md` (and has the Write tool for it).

## [0.2.0]

### Added

- Worker report contract: every worker ends with a `--- foreman-report ---` block (`Status`, `Summary`, `Files`, `Rulings`, `Blocked-on`). The coordinator parses it, the notification carries the parsed fields and a `contract` value (`ok`, `missing`, `malformed`), and the keywords stay English whatever language the prose is in.
- Per-agent model tiers (`strong|mid|cheap`) and thinking levels in agent frontmatter, with `FOREMAN_MODEL_<ROLE>`, `FOREMAN_MODEL_<TIER>` and `FOREMAN_THINKING_<ROLE>` overrides. No model ids ship, and the session model (including `foreman/hybrid`) is inherited by default.
- `reviewer` (strong tier, read-only) and `shipper` (mid tier) roles.
- Slash commands: `/foreman`, `/foreman off` (confirms before aborting running workers; refuses without a UI), `/foreman-status`, `/foreman-audit`, `/foreman-diagnose`, `/plan-runner <plan>`.
- Status bar entry and worker widget for orchestrator mode.
- `extensions/worker-guard/`: a path-scoped write/bash policy per worker role (lighter profile for `plan-step-builder`), driven by `FOREMAN_PI_ROLE`. A heuristic guard, not a sandbox; see `references/worker-guard.md`.
- `lib/i18n.ts`: English and Brazilian Portuguese UI strings, selected by `FOREMAN_LANG` or the environment locale. The conversation language follows the user's messages.
- Shared `lib/` (`roles`, `agents`, `spawn`, `model-policy`, `mode`, `workers`, `ui`).
- Packaging manifest (`files`, `engines`, author, `pi.changelogPath`), `npm run test:package` (real install into a sandbox), and GitHub Actions CI.
- `README.pt-BR.md`, `docs/verification-log.md`, and `npm run test:readme` (Model fallback section byte-identical to `main`, README role/command lists match the code, stale-reference grep gate).

### Changed

- Orchestrator mode no longer uses a marker file. It is session state: a persisted `foreman-mode` session entry, the `foreman:mode` event, and the `FOREMAN_PI_MODE` environment override. Workers (`FOREMAN_PI_SUBAGENT=1`) are always exempt.
- Tools removed by the guardrail are restored when the mode is turned off.
- The README is rewritten in English; the 0.1.x live-verification notes moved to `docs/verification-log.md`.
- Stray Portuguese removed from English prompts and references.

### Removed

- The vendored `subagent-dispatch` extension (and with it the standalone `subagent` tool).
- The `release-manager` agent, with no alias; use `shipper`.
- The `.orchestrator-active` marker file and everything that read or wrote it.

### Upgrade note

A leftover `.orchestrator-active` file from 0.1.x is ignored and can be deleted. Enter orchestrator mode with `/foreman` (or set `FOREMAN_PI_MODE=orchestrator` for RPC and print runs). Replace any use of the `release-manager` role with `shipper`.
