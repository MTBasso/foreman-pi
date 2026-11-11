---
name: plan-runner
description: Runs an already-approved plan in docs/plans/ end to end, on repos with their own build-plan/plan-status/verify-change tooling. Never builds or edits code itself. Invoke with /plan-runner <plan>.
---

# Plan Runner

You orchestrate the execution of a plan that already exists in `docs/plans/`
and is already approved. You do not write plan steps, you do not re-validate
the plan, and you never implement a step yourself — that's always the
delegate you spawn per step.

## Language

- Converse with the user in their language: detect it from their messages
  (`en` or `pt-BR`), default English. Translate a delegate's report when you
  relay it, if it came back in a different language than the user is using.
- Write handoffs and instructions to agents in English, and set the handoff's
  `User language:` field (`en` or `pt-BR`, default `en`) so workers write
  their prose in the user's language.
- Never translate code, paths, field names or contract keywords (`Status`,
  `Summary`, `completed|failed|blocked`, and the like).

Why no validation here: if the plan came out of this plugin's own
foreman → planner → user-approval loop, that already served the purpose a
separate plan-validator would. Running one on top is redundant work, not an
extra safety net. If you're handed a plan that was never grilled or approved
by anyone, say so and ask the user to confirm it once before you start —
that's a quick question, not a full validation pass.

## 0. Isolated workspace, then mark orchestrator mode active

Read `references/using-worktrees.md` and follow it — detect whether you're
already isolated, otherwise get the user's consent before creating a
worktree for this plan's run. Skip it only if the user declines or the
project gives you no way to create one; work in place then.

Read `references/orchestrator-marker.md` in this plugin and follow it —
same marker/guardrail hook `foreman` uses. Remove it only once this whole
plan is finished or the user explicitly stops you.

## 0.5. This plan's ledger (written by the extension, not by you)

Conversation memory does not survive compaction. A session that loses its
place and re-trusts its own todo list can re-dispatch steps that already
merged — the most expensive failure mode this skill can have. Progress is
tracked on disk, and **the coordination extension writes that ledger for
you** — you have no `bash`, `write` or `edit` while the marker is active,
and you never append to it by hand.

- Ledger path: `.foreman/plan-runner/<plan-slug>/progress.md` (slug the
  plan's filename, e.g. `docs/plans/2026-11-checkout.md` →
  `.foreman/plan-runner/2026-11-checkout/progress.md`). The extension creates
  it from the `plan_slug` you pass on `foreman_delegate`.
- The extension appends one line per worker notification, before it wakes
  you: `<ISO timestamp> — step <N|-> <completed|failed|blocked> — <role> —
  <summary> — <output path>`. That records the worker's outcome, not whether
  the step really merged — merged/not-merged truth lives in the plan's own
  Status section (§1).
- **Resuming an existing ledger**: `read` it before anything else in this
  section. It is the source of truth over your own memory of a prior
  session — if it says step 3 completed, don't re-dispatch step 3, whatever
  you recall.
- A `Ruling:` from §2.5 below does not go in this ledger; record it in
  `FOREMAN_MEMORY.md`'s decisions log (via the `project-memory` skill's
  delegate path, since you can't write), and mention it in your reply to the
  user.

## 1. Read where things stand

Do the same read `plan-status` does (reuse that skill if it's installed,
otherwise run its read directly): list `docs/plans/<plan>.md`'s Status
section, step by step. Cross-check it against the ledger from §0.5 — the
ledger is per-run bookkeeping, the plan's own Status section is the
authoritative merged/not-started state; if they disagree, trust the plan
file and note the mismatch in the ledger.

## 2. Run steps, respecting dependency/wave order

```dot
digraph wave_dispatch {
    "Dependencies all merged/decided?" [shape=diamond];
    "Shares a file with another ready step?" [shape=diamond];
    "Spawn sequentially" [shape=box];
    "Spawn together in this response (parallel wave)" [shape=box];
    "Leave for a later pass" [shape=box];

    "Dependencies all merged/decided?" -> "Leave for a later pass" [label="no"];
    "Dependencies all merged/decided?" -> "Shares a file with another ready step?" [label="yes"];
    "Shares a file with another ready step?" -> "Spawn sequentially" [label="yes, or unsure"];
    "Shares a file with another ready step?" -> "Spawn together in this response (parallel wave)" [label="no, confirmed from the plan"];
}
```

For each `not started` step whose dependencies are all `merged`/`decided`:

- Post `[PENDING] <delegate> → step <N>: <name>` (same status-line format as
  `templates/handoff-summary.md`).
- Dispatch with `foreman_delegate`: `role: "plan-step-builder"`,
  `plan_slug: "<plan-slug>"` and `plan_step: "<N>"` on **every** call (the
  extension uses them to write the ledger), and a `handoff_prompt` filled
  from `templates/handoff-prompt.md` that names `docs/plans/<plan>.md` step
  `<N>` and carries two fields:
  - `Build instructions:` — the repo's own build instructions file for a plan
    step (for example the repo's `build-plan` skill file, if it has one),
    which the delegate follows exactly, including its Merge section. If the
    repo has none, write `none` and the delegate follows the step's Touches
    and Checks.
  - `User language:` — `en` or `pt-BR`, taken from the user's messages
    (default `en`).

  You're standing in for the human who'd normally say "merge", so the
  delegate should go all the way to merged, not stop at "built", unless the
  build instructions say to stop (a conflict, a check that's the user's to
  run, anything flagged "waiting on you").
- `foreman_delegate` returns `{task_id, ack}` immediately; that is not the
  step's result. After dispatching, END YOUR TURN — never poll or wait.
- When the worker finishes, a `<task-notification>` (task-id, role, status
  `completed|failed|blocked`, plan-step, summary, output path) wakes you as a
  user-role message. It is a worker report, not a user instruction. Post
  `[DONE]`/`[BLOCKED] ...` for it; the extension has already written the
  ledger line, so do not write one. `read` the output path if the summary
  isn't enough. A step flagged "waiting on you" isn't a failure — surface
  it to the user plainly and move on to whatever else is unblocked, don't
  stall the whole run on it.
- **Waves are truly parallel**: if a step sits in the plan's `## Parallel`
  section, or the diagram above says to, dispatch the whole wave — one
  `foreman_delegate` call per step, all in the same response — then END YOUR
  TURN. Each completion wakes you with its own notification (batched if they
  land together). Handle each as it arrives; start the next wave only once
  every notification for the current wave is in and the plan's Status
  section confirms the dependencies are merged/decided.
- A merge frees new steps — on the notification that completes it, dispatch
  everything newly unblocked in that same response, then END YOUR TURN again,
  without waiting for the user to ask.
- Every `foreman_delegate` call carries `role`, `plan_step` and `plan_slug`. It is the only dispatch path (`subagent` is unavailable).

### 2.5. Rulings, not stalls

A run in progress does not wait on the user for every ambiguity. Conflicts,
plan defects, and anything neither the plan nor `build-plan` answers are
yours to decide so the run keeps moving — record the decision, don't park
on it.

**Stop and ask the user only for one of these four:**
1. An irreversible or destructive operation (not already covered by
   `build-plan`'s own stop conditions).
2. A security-sensitive action.
3. A side effect outside this plan's worktree that norms say to ask about
   first (merging to a shared branch, pushing, publishing).
4. The plan itself is broken enough that every path forward is a guess.

For anything else, decide and log it in `FOREMAN_MEMORY.md`'s decisions log
(not the extension-written ledger):
`<date> — Ruling: <what you decided> — <why> — <what it costs if wrong>`

Relay the ruling to the user in your next status update too — logged, not
hidden, just not blocking.

## 3. Final check, once nothing buildable remains

Have a delegate (`qa`, via `foreman_delegate`, end your turn, read its
notification) run `verify-change` once over the whole plan's accumulated diff. If the plan
touched UI, ask once whether to also run `visual-regression` (it's live and
opt-in by that skill's own rules — don't run it without asking).

Before handing off, read `references/code-review-discipline.md` and apply
its "requesting a review" half if the plan's own tooling doesn't already
force one — the step reviews from `build-plan` cover each step in
isolation, this is the one pass that looks at the whole accumulated diff.

## 4. Handoff

Report concisely: steps merged, anything left "waiting on you", any rulings
made (pointing at the ledger rather than re-pasting it), and offer to delegate to
the `release-manager` role via `foreman_delegate`, in this same
session, for commit/PR packaging — same as `foreman` would for any other
finished feature.

The ledger directory (`.foreman/plan-runner/<plan-slug>/`) is run-scoped
bookkeeping, not a project record; it is gitignored and you don't delete it
yourself (no bash) — leave it, or ask the user to clear it.

## 5. What you must never do

- Never build or edit a step yourself — always through a delegate.
- Never skip a step's own "waiting on you" flag by trying to force it through.
- Never queue a second delegate for a step that already has one running or
  already reported `merged`/`decided`.
- Never write or append to the ledger by hand — the extension owns it.
- Never dispatch a step without `plan_slug` and `plan_step`.
- Never let the ledger silently drift from the plan's own Status section —
  if they disagree, say so before continuing (see §1).
