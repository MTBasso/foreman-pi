# Foreman: audit paths

Read this when the project is an existing codebase you are about to grill or plan for (first section), or when the user's request is an audit/review (second section). Paths below resolve against the package root, like every `references/`, `agents/` and `templates/` path.

## Existing codebase: audit before proposing anything, but only if it needs it

If this is a non-empty, pre-existing codebase (not a fresh/empty project), do a
quick read first: clear module boundaries, reasonably sized/testable units,
and some form of agent-legible docs (an `AGENTS.md`/`CLAUDE.md`, or READMEs
that actually explain the "why" of each area) already in place?

- **If it's lacking on either front**, this is mandatory, not optional, before
  you grill or propose any feature: invoke `improve-codebase-architecture` and
  `writing-for-agents` (both from Matt Pocock's `mattpocock/skills` plugin) to
  do the audit properly. Both write their own markdown files into the repo —
  treat those the same way you treat `FOREMAN_MEMORY.md`: read them before
  grilling or planning, and let their findings shape what you ask about next.
- **If the codebase already looks solid on both fronts**, skip calling them —
  running a full audit on code that doesn't need one is wasted work, not
  thoroughness. Say briefly that you checked and it looked fine, then move on.
- If either skill isn't listed among your available skills, mention it once
  (see `references/optional-dependencies.md` for how the user can add it) and
  fall back to your own judgment for that check instead of blocking on it.

## Audit request: a different, shorter path

If what the user wants is a review/audit/recommendations on existing UI or
older code — not a new feature or a bug to fix — don't run this through
grilling/planning/building at all. Delegate to the `codebase-auditor` role
with `foreman_delegate`, pointed at whatever scope the user named (or the
whole project if they didn't). It is dispatched like every other delegation
(§4): the call returns at once with a `task_id` and an ack, and the result
arrives later as a `<task-notification>`.

1. Fill in `templates/handoff-prompt.md` with the scope the user named (or
   "the whole project"). You don't need to paste the agent's own prompt —
   the extension launches the worker with `agents/codebase-auditor.md`.
2. Post `[PENDING] codebase-auditor → <scope>`, then call `foreman_delegate`
   with `role: "codebase-auditor"` and that `handoff_prompt`.
3. The return value (`task_id`, `ack`) is not the audit result, only
   confirmation the worker started. **Do not write `[DONE]` and do not
   fabricate a result.** Tell the user the audit is running, then END YOUR
   TURN. Do not poll, do not wait, do not re-check. When the audit finishes
   a `<task-notification>` wakes you; only then post `[DONE]`/`[BLOCKED]`.
4. `foreman_delegate` is the only dispatch path.

The auditor writes `FOREMAN_AUDIT.md` and reports back a short summary (the
notification's `summary`, with the full report at its `output` path); relay
that to the user. If they then want something from the report acted on, that's a
normal feature/bug request — go back to the grilling step (SKILL.md §2) for it, don't build anything
directly off the audit yourself.
