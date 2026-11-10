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
| `extensions/orchestrator-guardrail/` | **Built + tested.** `tool_call` block + `setActiveTools`. 10/10 logic checks pass against the real `@earendil-works/pi-coding-agent` types. Not yet run inside a live `pi` session (no `pi` runtime available in the environment this was built in — see "What's not verified yet" below). |
| `extensions/session-reminder/` | **Built**, matching Pi's own documented `session_start`/`before_agent_start` pattern for a one-shot reminder. Not yet run live. |
| `extensions/subagent-dispatch/` | **Adopted + patched**, not written from scratch — see "Why adopt the example" below. One documented, tested change: bundled `agents/*.md` are discovered alongside user/project agents. |
| `skills/` (`foreman`, `plan-runner`, `project-memory`, `design-preview`) | **Ported.** Content carried over from the original plugin; Claude-Code-specific mentions (Artifact tool, PreToolUse, NotebookEdit, "Agent tool") were rewritten for Pi's actual primitives. |
| `agents/` (8 files: `backend-dev`, `frontend-dev`, `qa`, `qa-bugfix`, `planner`, `plan-step-builder`, `release-manager`, `codebase-auditor`) | **Ported.** Frontmatter `tools:` remapped to Pi's native tool names (`Read`→`read`, `Glob`→`find`, etc. — Pi has no `NotebookEdit`, so nothing needed dropping). Confirmed discoverable by the real dispatcher (`npm run test:agents`). Bodies not yet re-read end to end for Claude-Code-specific assumptions beyond the obvious ones. |
| `templates/`, `commands/` equivalents | **Not started.** |
| Packaging for real install (`pi install ./foreman-pi` or via npm) | **Not verified.** The directory layout follows the documented package convention (`extensions/`, `skills/`, conventional discovery, no manifest needed) but has not actually been installed into a `pi` session. |

## What's not verified yet

This was built and tested against the **real type definitions and real
example code** shipped in the `@earendil-works/pi-coding-agent@1.5.2` npm
package (installed as a devDependency here specifically to check against —
see `package.json`) — not guessed from documentation summaries. Every claim
in PLAN.md about event shapes, `tool_call` blocking, `setActiveTools`, and
the subagent frontmatter format was confirmed by reading the actual `.d.ts`
files and the actual `examples/extensions/` source in that package.

What has **not** been done, because this environment has no way to run a
live `pi` TUI/session:

- Actually loading these extensions into a running `pi` session with
  `pi --extension` and confirming the guardrail blocks a real `write` tool
  call end to end.
- Actually dispatching a subagent through `extensions/subagent-dispatch/`
  and confirming it spawns a real child `pi` process, runs one of the 8
  ported agents, and returns a result.
- Installing this directory as a package with `pi install ./foreman-pi` and
  confirming auto-discovery actually finds everything the way the
  conventional-directory docs say it should.

The smoke tests in this repo (`npm test`) exercise the actual logic
(`extensions/orchestrator-guardrail/index.ts`'s `tool_call` handler,
`extensions/subagent-dispatch/agents.ts`'s `discoverAgents`) directly against
the real types, with faked `ExtensionAPI`/`ExtensionContext` objects — they
prove the logic is correct, not that Pi's runtime will drive it the way the
fakes assume. Treat "builds and typechecks against the real API, logic
verified standalone" as the actual state, not "confirmed working in Pi."

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
