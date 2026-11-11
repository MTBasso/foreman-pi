# foreman-pi

🇧🇷 Português: [README.pt-BR.md](README.pt-BR.md)

A [Pi](https://github.com/earendil-works/pi) package
(`@earendil-works/pi-coding-agent`) that ports
[`foreman`](https://github.com/MTBasso/foreman), a Claude Code plugin: one
orchestrator session that grills, plans, builds, tests and ships, always
delegating to dedicated worker agents and never editing code itself.

Version 0.2.0. See [CHANGELOG.md](CHANGELOG.md) for what changed. Design
background and the original viability research are in [PLAN.md](https://github.com/MTBasso/foreman-pi/blob/main/PLAN.md)
(Portuguese); the 0.2.0 implementation plan is
[docs/plans/foreman-pi-pi-native-improvements.md](https://github.com/MTBasso/foreman-pi/blob/main/docs/plans/foreman-pi-pi-native-improvements.md).
(These two files live in the repository and are not part of the published package.)

## Install

```bash
pi install git:github.com/MTBasso/foreman-pi   # from git
pi install ./foreman-pi                         # or from a local checkout
```

The `pi` manifest in `package.json` registers the extensions in
`extensions/*/index.ts` and the skills in `skills/`. Agents (`agents/*.md`),
references and templates are found relative to the installed package.
`npm run test:package` packs the tarball and installs it into a throwaway
sandbox (never your real `~/.pi`) to prove the published layout loads.

## Quick start

1. Start `pi` in your project and run `/foreman`. This turns on orchestrator
   mode and starts the foreman workflow: it grills you about the task, plans,
   and delegates the work.
2. In orchestrator mode the session itself cannot edit: `write`, `edit` and
   `bash` are removed and denied. The only action tool is `foreman_delegate`.
3. Workers run as separate `pi` processes in the background. When they finish
   you are woken with a `foreman-task-notification` message.
4. `/foreman-status` shows the mode and the workers; `/foreman off` leaves the
   mode.

For an already-approved plan under `docs/plans/`, use `/plan-runner <plan>`.

| Command | What it does |
|---|---|
| `/foreman [task]` | Enter orchestrator mode and start the foreman workflow. |
| `/foreman off` | Leave the mode and restore tools. If workers are running it asks for confirmation before aborting them; with no UI it refuses. |
| `/foreman-status` | Show mode and worker status (no model call). |
| `/foreman-audit` | Enter orchestrator mode and run a read-only codebase audit. |
| `/foreman-diagnose` | Diagnose why a foreman or plan-runner run went wrong. Does not change the mode. |
| `/plan-runner <plan>` | Enter orchestrator mode and run an approved plan from `docs/plans/`. |

## Architecture

| Piece | Role |
|---|---|
| `extensions/foreman-mode/` | The slash commands, the status bar entry and the worker widget. Owns the persisted mode entry. |
| `extensions/orchestrator-guardrail/` | While the mode is on: drops `bash`/`write`/`edit` from the active tools and denies them in `tool_call`. Writes to the project-root `FOREMAN_MEMORY.md` pass. |
| `extensions/coordination/` | The `foreman_delegate` tool and the event-driven coordinator: spawns workers, queues, batches completions, writes the ledger, parses the report contract. `/foreman-status` lives here. |
| `extensions/context-filter/` | Prunes stale `foreman-task-notification` messages before each LLM call. |
| `extensions/session-reminder/` | One-shot session reminder (mode state, `foreman_delegate` availability, project memory) and the resume/fork "keep orchestrator mode?" prompt. |
| `extensions/worker-guard/` | Per-role write/bash policy inside worker processes. |
| `extensions/model-fallback/` | The virtual `foreman/hybrid` model. See "Model fallback" below. |
| `lib/` | Shared modules: `roles.ts`, `agents.ts` (discovery), `spawn.ts` (child `pi`), `model-policy.ts`, `mode.ts`, `i18n.ts`, `workers.ts`, `ui.ts`. |
| `agents/`, `skills/`, `references/`, `templates/` | Worker definitions, the orchestrator skills, supporting docs and the handoff template. |

Delegation is non-blocking. `foreman_delegate` returns at once with
`{task_id, run_id, state: running|queued, ack}`, the orchestrator ends its
turn, and the coordinator wakes it when workers finish. Completions are
debounced into one message holding N blocks:

```
<task-notification>
task-id: t1-planner
role: planner
status: completed        # completed | failed | blocked
plan-step: 2             # or -
summary: <first ~400 chars of the worker's report>
output: .foreman/runs/<run-id>/t1-planner.md
</task-notification>
```

The ledger is written by the extension, not the model:
`.foreman/runs/<run-id>/ledger.log` (plus `.foreman/plan-runner/<slug>/progress.md`
when a `plan_slug` is given) gets one line per task, appended *before* the
notification is delivered. `--print` mode cannot host wake-ups (the process
exits once the agent settles); use `--mode rpc` or the interactive TUI.

`foreman_delegate` parameters:

| Param | Type | Notes |
|---|---|---|
| `role` | enum | `planner`, `frontend-dev`, `backend-dev`, `qa`, `qa-bugfix`, `plan-step-builder`, `codebase-auditor`, `reviewer`, `shipper` |
| `handoff_prompt` | string | Complete, self-contained prompt for the worker. |
| `plan_step` | number, optional | Plan step this task belongs to (ledger). |
| `plan_slug` | string, optional | `docs/plans/<slug>.md`; the first non-empty value is latched for the run. |

## Roles

Defined once in `lib/roles.ts`. The `agents/` directory holds one file per role: `planner`, `frontend-dev`, `backend-dev`, `qa`, `qa-bugfix`, `plan-step-builder`, `codebase-auditor`, `reviewer`, `shipper`.

| Role | Tier | What it does |
|---|---|---|
| `planner` | strong | Reads the project and produces a structured plan. Read-only. |
| `frontend-dev` | mid | Implements UI work. |
| `backend-dev` | mid | Implements backend work. |
| `qa` | cheap | Tests and verifies; writes only under `.foreman/`. |
| `qa-bugfix` | mid | Fixes bugs found by QA. |
| `plan-step-builder` | mid | Builds one step of an approved plan (lighter worker-guard profile). |
| `codebase-auditor` | cheap | Read-only audit; writes only `.foreman/` and `FOREMAN_AUDIT.md`. |
| `reviewer` | strong | Reviews changes. Read-only. |
| `shipper` | mid | Commits, pushes and opens PRs; writes only under `.foreman/`. |

The 0.1.x release role was replaced by `shipper`, with no alias for the old
name.

## Model tiers and environment variables

Agents declare `tier: strong|mid|cheap` and
`thinking: off|minimal|low|medium|high|xhigh|max` in their frontmatter. No
model ids ship; invalid values are ignored. `lib/model-policy.ts` resolves
them when a worker is spawned and records the choice as `model`/`thinking` in
the per-task meta JSON.

- Model: `FOREMAN_MODEL_<ROLE>` > frontmatter `model:` > `FOREMAN_MODEL_<TIER>` >
  inherit the session model (so `foreman/hybrid` passes through unchanged).
- Thinking: `FOREMAN_THINKING_<ROLE>` > frontmatter `thinking:` > the session
  thinking level.

`<ROLE>` is the agent name upper-cased with `_` (`plan-step-builder` becomes
`PLAN_STEP_BUILDER`); `<TIER>` is `STRONG`, `MID` or `CHEAP`. Example:
`FOREMAN_MODEL_STRONG=anthropic/claude-opus-4` affects only strong-tier roles.
An explicit model bypasses the `foreman/hybrid` fallback layer.

| Variable | Default | Meaning |
|---|---|---|
| `FOREMAN_LANG` | from `LC_ALL`/`LC_MESSAGES`/`LANG` | UI language: `en` or `pt-BR`. See "Language". |
| `FOREMAN_PI_MODE` | unset | `orchestrator` forces the mode on, `off` forces it off (RPC, print, live runs). |
| `FOREMAN_MODEL_<ROLE>` / `FOREMAN_MODEL_<TIER>` | unset | Model override per role or tier. |
| `FOREMAN_THINKING_<ROLE>` | unset | Thinking-level override per role. |
| `FOREMAN_MAX_WORKERS` | 4 | Concurrent workers; extra delegations queue. |
| `FOREMAN_BATCH_MS` | 300 | Debounce window for batching completions. |
| `FOREMAN_WORKER_TIMEOUT_MS` | 1800000 (30 min) | Per-worker timeout (0 disables). |
| `FOREMAN_ABORT_WAIT_MS` | 7000 | How long `/foreman off` waits for workers to stop after confirming. |
| `FOREMAN_KEEP_MODE_TIMEOUT_MS` | 30000 | How long the resume/fork "keep orchestrator mode?" prompt waits. |
| `FOREMAN_CONTEXT_PRUNE` | true | `false` disables notification pruning. |
| `FOREMAN_CONTEXT_KEEP_PER_ROLE` | 1 | Completed results kept per role. |
| `FOREMAN_CONTEXT_DEBUG` | off | `1` logs before/after/pruned counts to stderr. |
| `FOREMAN_PRIMARY_MODEL` / `FOREMAN_FALLBACK_MODEL` | `claude-sonnet-4-5` / `gpt-4o-mini` | `foreman/hybrid` model ids. See "Model fallback". |
| `FOREMAN_PI_SUBAGENT`, `FOREMAN_PI_ROLE` | set by the spawner | Mark a worker process and its role. Not meant to be set by hand. |

## Worker report contract

Every worker ends its final message with this block. Only the English keywords
are parsed; the prose inside the fields can be in any language.

```
--- foreman-report ---
Status: completed|failed|blocked
Summary: ...
Files: ...
Rulings: ...
Blocked-on: ...
--- end foreman-report ---
```

The last well-formed block wins. The notification carries the parsed fields
plus a `contract` value: `ok`, `missing` (non-empty report with no block) or
`malformed` (a block was present but unusable). A legacy `[BLOCKED]` first line
still means blocked. `failed` also covers a non-zero exit, signal, timeout,
spawn error or empty output. The full report is always at the `output` path.

## Mode state

Orchestrator mode is session state, not a file. It comes from, in order:

1. `FOREMAN_PI_SUBAGENT=1`: always inactive (workers are never restricted).
2. `FOREMAN_PI_MODE`: `orchestrator` or `off` forces the state.
3. The newest persisted `foreman-mode` session entry (also announced on the
   `foreman:mode` event bus), so the mode survives `/reload`, resume and fork.
4. Default: inactive.

A new session (`startup` or `new`) always starts inactive. On resume or fork
of a session that was in the mode, the user is asked whether to keep it; no
answer keeps the restored state. See
[references/orchestrator-mode.md](references/orchestrator-mode.md).

## Worker guard

`extensions/worker-guard/` scopes what each worker may write. The spawner sets
`FOREMAN_PI_ROLE=<role>` next to `FOREMAN_PI_SUBAGENT=1`; the guard checks every
`write`, `edit` and `bash` call of a worker against its role (`qa` and
`codebase-auditor` only `.foreman/**` and `FOREMAN_AUDIT.md`, `planner` and
`reviewer` read-only, `shipper` only `.foreman/`, dev roles anywhere in the repo
except `.git/`, outside paths and real `.env` files). An unknown role fails
closed to read-only, and the guard is inactive without both env vars.

**Honest limits.** It is a heuristic, not a sandbox: it parses shell text, so
interpreters, `make`, `npm run` and scripts can still write anywhere, and a
path can change between check and write. It does not stop a model from
reporting wrong results. Full policy and limits:
[references/worker-guard.md](references/worker-guard.md).

## Language

Extension UI strings (command descriptions, notifications, status bar, widget,
`/foreman-status`) come from `lib/i18n.ts`, in English or Brazilian Portuguese.
Pi has no locale setting, so the locale is detected from the environment:
`FOREMAN_LANG`, then `LC_ALL`, `LC_MESSAGES`, `LANG` (the first non-empty one
wins; `pt*` gives `pt-BR`, `en*` and anything else give `en`). An invalid
`FOREMAN_LANG` is ignored.

The UI locale and the conversation language are separate. The UI follows the
environment locale. The agent conversation follows the language of your
messages: skills and agents tell the model to reply in your language. Prompts,
guardrail reasons, notification blocks and the report contract keywords stay in
English. If you write to the agent in Portuguese but your `LANG` is English, set
`FOREMAN_LANG=pt-BR` to get Portuguese UI strings.

## Model fallback (false-positive testing, not a refusal bypass)

`extensions/model-fallback/` retries a refused Claude response on GPT, as a
way to test whether Claude's refusal was a false positive on this project —
**not** as a way to route around a refusal in general. The distinction is
load-bearing, not cosmetic:

- The fallback target (`openai`/GPT) is an ordinary aligned provider with its
  own safety policy. If GPT also refuses, this extension stops — it does not
  escalate to a third, less-aligned model. There is deliberately no "keep
  trying providers until one says yes" loop.
- A provider marketed specifically as having no refusals was explicitly
  considered and rejected for this role (see the conversation that led to
  this extension) — that pattern is a refusal-bypass system by construction,
  regardless of how the retry is framed, and this repo will not add one.
- The refusal detector (`looksLikeRefusal` in `index.ts`) is a conservative
  heuristic (short text + an opening refusal phrase, English and
  Portuguese) specifically to avoid misfiring on a long legitimate answer
  that happens to contain "I can't" mid-paragraph. See
  `extensions/model-fallback/smoke-test.ts` scenario 5 for the check.

**Needs a real OpenAI API key with billing, not a ChatGPT subscription** —
the ChatGPT consumer app (free or Plus) does not grant API access; `pi`
talks to providers the same way it talks to Anthropic, via `OPENAI_API_KEY`
(see `docs/providers.md` in the installed package). Model ids
(`FOREMAN_PRIMARY_MODEL`/`FOREMAN_FALLBACK_MODEL` env vars, defaulting to
`claude-sonnet-4-5`/`gpt-4o-mini`) are unverified guesses — confirm the
exact catalog ids with `/models` inside `pi` or https://pi.dev/models before
relying on the defaults.

## Context filter

`extensions/context-filter/` hooks the `context` event (pi hands it a clone,
so the stored transcript is untouched) and trims old
`foreman-task-notification` messages so long orchestrations do not accumulate
every worker report. Only those messages are in scope. It keeps the latest
`FOREMAN_CONTEXT_KEEP_PER_ROLE` completed results per role plus every block of
the last notification; `failed` and `blocked` blocks are never pruned; pruned
blocks collapse into one line per role
(`[pruned: K older <role> results — recover: <output paths>]`).

## Tests and CI

```bash
npm install
npm test               # typecheck + every smoke/lint test (live-* scripts are separate)
npm run test:package   # pack, install into a sandbox, check discovery
```

`npm test` includes `test:readme`, which checks that the Model fallback
section of this README is byte-identical to the one on `main`, that the role
and command lists in both READMEs match the code, and that no stale references
(the removed release role, the removed vendored dispatcher, the removed marker file) remain outside
historical docs. The `test:live:*` scripts drive a real `pi` and are run by
hand. CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, `npm test` and
the package check on every push and pull request.

Before releasing, run the load check from a scratch directory:

```bash
cd /tmp && mkdir -p pi-verify && cd pi-verify
timeout 20 pi --no-session --print --verbose "hi" 2>&1 | grep -iE "error|failed to load"
```

No output means the extensions loaded cleanly. Historical live-run notes from
the 0.1.x port are kept in [docs/verification-log.md](https://github.com/MTBasso/foreman-pi/blob/main/docs/verification-log.md).

## Layout

```
PLAN.md                  design notes and phase status (Portuguese)
CHANGELOG.md             release notes
extensions/              foreman-mode, orchestrator-guardrail, coordination,
                         context-filter, session-reminder, worker-guard, model-fallback
lib/                     shared modules and their tests
agents/                  the 9 worker definitions
skills/                  foreman, plan-runner, project-memory, design-preview
references/              supporting docs the skills point to
templates/               handoff prompt template
scripts/                 check-package.ts
docs/                    plans/ and verification-log.md
```

## License

MIT, matching the original [`foreman`](https://github.com/MTBasso/foreman).
