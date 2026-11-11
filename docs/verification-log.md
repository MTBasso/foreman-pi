# Verification log (historical)

> **Historical document.** This is the live-verification record of the 0.1.x
> port, moved here from the README in 0.2.0. It describes the
> `.orchestrator-active` marker mechanism and the vendored `subagent-dispatch`
> extension, **both removed in 0.2.0**: orchestrator mode is now session state
> (see `references/orchestrator-mode.md`) and delegation goes through
> `foreman_delegate`. Read it for the history of what was found and fixed, not
> as a description of how the package works today.

## Live verification (2026-11-11)

With `pi` 1.5.2 actually available, this was the first pass that ran these
extensions inside real `pi --no-session -p --mode json` sessions instead of
just the faked-API smoke tests. Summary (details inline in PLAN.md's "Fases
— status"):

- **Guardrail**: confirmed blocking `write`/`edit`/bash-redirect/`sed -i` in
  a real session with `.orchestrator-active` present, end to end. Found and
  fixed a real bypass (`.txt`/`.out` redirect targets wrongly treated as safe).
- **Subagent dispatch**: confirmed spawning a real child `pi` process for
  both `planner` (produced an actual structured plan from the real directory
  state) and `frontend-dev` (actually edited a file on disk).
- **Integration**: confirmed the full cycle — orchestrator's own `edit`/`bash`
  attempts blocked, delegates via `subagent`, the child process makes the
  real edit. Found and fixed a real cross-contamination bug (next section).

### Subagent exemption bug (found + fixed)

The architecture doc (PLAN.md §1) assumed the guardrail never needs to tell
orchestrator from subagent apart, because they're different `pi` processes
and the subagent "never carries this restriction in the first place." That
assumption breaks under this repo's actual, intended install path: once
`foreman-pi` is registered as a package (`~/.pi/agent/settings.json`), Pi's
default extension discovery loads `orchestrator-guardrail` into *every* `pi`
invocation on the machine — including the child processes
`subagent-dispatch` spawns. The child shares the orchestrator's cwd, so it
saw the same `.orchestrator-active` marker and had its own `edit` tool
removed mid-task (confirmed live: a `frontend-dev` subagent reported "the
edit tool was taken away after I read greet.js").

`--no-extensions` on the child isn't a general fix: none of the 8 ported
agents pin their own `model:`, so they all inherit the orchestrator's model —
on this install, that's the `model-fallback` extension's virtual
`foreman/hybrid` model, which doesn't exist without that extension loaded.

The actual fix: `subagent-dispatch` now sets `FOREMAN_PI_SUBAGENT=1` on every
child it spawns (`extensions/subagent-dispatch/index.ts`'s `spawn()` call),
and `orchestrator-guardrail` treats that env var as "never active," marker or
no marker (`extensions/orchestrator-guardrail/index.ts`'s `isOrchestratorActive`).
Verified live afterward: a `frontend-dev` subagent successfully edited a file
on disk while `.orchestrator-active` was present in the shared cwd the whole
time.

Separately, a live test also caught the *model itself* (not the guardrail)
pausing to ask "should I delete this marker?" instead of just acting, when
given an ambiguous task that didn't say the marker was irrelevant to it —
`templates/handoff-prompt.md` now has a line telling a delegated subagent
this explicitly, so it never has to guess.

### Still not run

- `pi install ./foreman-pi` as an explicit local-path install command (this
  machine already had the package registered from before this session, so
  the install flow itself, as opposed to its *effect*, wasn't exercised here).
- `extensions/session-reminder/` and `extensions/model-fallback/` live
  (both still only have the faked-API smoke tests passing).
- The slash-command equivalents (Fase 4) — not started at all yet.
- A single orchestrator session doing "try the edit myself, get blocked, then
  delegate" as one uninterrupted flow: the session that was asked to do this
  (guardrail confirmed blocking `edit`/`write` mid-session, per its own
  `toolsRemoved` event) stalled for 14+ minutes after that and had to be
  killed, never producing a `subagent` tool call. This is the documented
  `pi-claude-cli` instability with long sequential tool-use chains (see the
  root `CLAUDE.md`'s "~/.pi (Pi coding agent config)" gotchas), not a bug in
  either extension — both halves of the flow are independently confirmed
  working above. Worth keeping in mind for real orchestrator usage: prefer
  short, decisive turns over "try it yourself first" framing.

## Coordination and context-filter live runs (0.1.x)

**Live-run evidence.** `extensions/coordination/live-rpc.ts` was run 3 times
against a real `pi --mode rpc` session. The first run failed because of an
over-strict script check (since fixed): the notification arrived as a mid-run
`followUp` (the orchestrator was still busy) rather than as a fresh run, and the
script only accepted the latter. The script was fixed to accept both delivery
paths; runs 2 and 3 then passed. Observed event order on the idle-wake path: the
`foreman_delegate` tool result returned ~2.7s before the worker finished, then
`agent_settled`, then a new `agent_start` triggered by the
`foreman-task-notification` message.

**Phase 3 live evidence** (`npm run test:live:phase3`, real `pi --mode rpc` in a
temp dir with the marker, plus a probe extension command since rpc has no tool-list
command): active tools = `[read, foreman_delegate]` (grep/find/ls are not in pi's
default active set, so they are not re-added); `subagent` exists in
`getAllTools()` but is not active; asked to call `subagent`, the model tried and
got `Tool subagent not found`. The `tool_call` block itself is only covered by the
smoke test (the tool is never active live), so that layer is not live-verified.

**Live-run evidence.** `npm run test:live:context-filter` (real `pi --mode rpc`, two
sequential real planner delegations, a test-only probe extension logging the final
context and provider payload) passed: the LLM call following notification 2 showed
the older planner result replaced by `[pruned: 1 older planner results — recover:
.foreman/runs/<run>/t1-planner.md]` (debug log: `before=12 after=12 pruned-or-rebuilt=1`),
the older notification text was gone from every notification message, and the turn
completed with no provider error. The pruned line sits between two assistant
messages, so pruning created no adjacent user-role messages (the only adjacent pair
in the context, user → session-reminder, predates the filter and the provider accepts
it). Not yet exercised: a provider that rejects adjacency (plan fallback: replace with
stubs instead of removing). An assistant message that echoed the old result's content
is deliberately left alone.
