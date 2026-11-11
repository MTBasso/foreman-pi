# foreman-pi

Port in progress of [`foreman`](https://github.com/MTBasso/foreman) (a Claude
Code plugin: one orchestrator session that grills, plans, builds, tests, and
ships, always delegating to dedicated subagents and never editing code
itself) to [Pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`).

**Read [PLAN.md](PLAN.md) first.** It has the viability research, the
architecture mapping, and the open questions this port is making calls on.
This README only covers what exists in this repo right now and how to run it.

## Status

| Piece | Status |
|---|---|
| `extensions/orchestrator-guardrail/` | **Built, tested, and verified live in a real `pi` session (2026-11-11).** `tool_call` block + `setActiveTools`. 13/13 logic checks pass (`npm run test:guardrail`). Live-tested against a real `pi 1.5.2` session with a sandbox `.orchestrator-active` marker: `write`/`edit` confirmed removed from the active toolset before the model could call them, and `bash` with `sed -i` / `printf ... > file` / `echo ... > file` confirmed blocked reactively with the extension's own denial reason. **One real bug found and fixed by this testing**: `.txt`/`.out` were on the "safe spot-check redirect" allowlist, letting `echo hacked > existing.txt` overwrite a real file undetected — narrowed to `.log`/`/dev/null` only, with a regression test for the exact command that leaked through. |
| `extensions/session-reminder/` | **Built**, matching Pi's own documented `session_start`/`before_agent_start` pattern for a one-shot reminder. Not yet run live. |
| `extensions/subagent-dispatch/` | **Adopted + patched, and verified live (2026-11-11).** A real `pi --no-session -p --mode json` run dispatched the `planner` agent, confirmed (via the JSON `toolResult` event) that a genuine child `pi` process spawned, read files in its own cwd, and returned real output to the parent — both for a trivial read (`package.json`'s `name` field) and for an actual feature-planning task (a structured, multi-step plan for a `/health` endpoint, reasoning from the real state of the sandbox directory). **One real bug found and fixed**: because this repo is installed as a package, Pi's default extension discovery loaded `orchestrator-guardrail` into the dispatcher's own child processes too, so a subagent sharing the orchestrator's cwd got its `edit` tool wrongly pulled out from under it mid-task — see "Subagent exemption bug" below. |
| `skills/` (`foreman`, `plan-runner`, `project-memory`, `design-preview`) | **Ported.** Content carried over from the original plugin; Claude-Code-specific mentions (Artifact tool, PreToolUse, NotebookEdit, "Agent tool") were rewritten for Pi's actual primitives. `templates/handoff-prompt.md` now also tells a delegated subagent explicitly that `.orchestrator-active` doesn't apply to it, after a live test caught a subagent pausing to ask instead of just acting on an ambiguous marker file. |
| `agents/` (8 files: `backend-dev`, `frontend-dev`, `qa`, `qa-bugfix`, `planner`, `plan-step-builder`, `release-manager`, `codebase-auditor`) | **Ported.** Frontmatter `tools:` remapped to Pi's native tool names (`Read`→`read`, `Glob`→`find`, etc. — Pi has no `NotebookEdit`, so nothing needed dropping). Confirmed discoverable by the real dispatcher (`npm run test:agents`), and `planner`/`frontend-dev` confirmed to actually run correctly end to end in a live child process (see above). Bodies not yet re-read end to end for Claude-Code-specific assumptions beyond the obvious ones. |
| `extensions/model-fallback/` | **Built + tested.** `registerVirtualModel` ("foreman/hybrid") + `agent_end`/`agent_settled` retry trigger. 8/8 logic checks pass (`npm run test:fallback`). See "Model fallback" below — this is NOT a refusal-bypass tool, by design. Not yet run against a real model response. |
| `templates/`, `commands/` equivalents | **Not started.** |
| Packaging for real install (`pi install ./foreman-pi` or via npm) | **Verified by accident, not by design**: this repo is in fact installed as a package on the machine this verification ran on (`~/.pi/agent/settings.json` lists `https://github.com/MTBasso/foreman-pi` under `packages`), and its extensions and agents are confirmed auto-discovered in every `pi` invocation — that's exactly what surfaced the subagent-exemption bug above. `pi install ./foreman-pi` itself (the local-path install flow) has still not been run explicitly in this verification pass. |

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

## Why adopt the example instead of writing a dispatcher from scratch

PLAN.md's open question 1 asked whether to fork
`examples/extensions/subagent/` or write our own. Decision: adopt it
(`extensions/subagent-dispatch/index.ts` and `agents.ts` are copies of the
upstream example — see `UPSTREAM-README.md` in that directory for the
original docs), with exactly one functional change, documented inline in
both files: `discoverAgents` also loads `agents/*.md` bundled next to this
package (tagged `source: "package"`), so foreman-pi's own agents are found
without the user having to copy files into `~/.pi/agent/agents/` or
`.pi/agents/` by hand.

Reasoning: the upstream example is ~1,400 lines handling process spawning,
JSON-mode parsing, parallel/chain dispatch, and TUI rendering — reusing a
tested implementation and keeping the diff to one well-contained, documented
change is lower-risk than re-deriving all of that. The tradeoff (also in
PLAN.md): this is example code, not a core-maintained API, so a future Pi
release could change its shape without the same compatibility guarantees as
`ExtensionAPI` itself.

## Layout

```
PLAN.md                          — read this first
extensions/
  orchestrator-guardrail/        — tool_call block + setActiveTools (foreman's guardrail)
  session-reminder/               — session_start + before_agent_start reminder
  subagent-dispatch/              — adopted+patched upstream subagent example
  model-fallback/                 — Claude→GPT retry on a detected refusal (false-positive testing only)
agents/                           — the 8 ported foreman subagent definitions
skills/                           — the 4 ported foreman skills
references/                       — supporting docs the skills point to
```

## Running the checks

```bash
npm install
npm test          # typecheck + both smoke tests
```

## License

MIT, matching the original [`foreman`](https://github.com/MTBasso/foreman).
