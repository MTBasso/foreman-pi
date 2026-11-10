Referenced from `commands/foreman-diagnose.md`. Use this when the user wants
to know why a `foreman`- or `plan-runner`-orchestrated run went wrong:
repeated work, a plan that got ignored, a step that stalled, "why did this
take so long/cost so much", or they want a clear account before deciding
what to fix in the plugin itself.

**You report what happened; you do not redesign the plugin here.** If the
evidence points at a real gap in `foreman`/`plan-runner`, say so plainly and
let the user decide whether to act on it — this skill produces a diagnosis,
not a patch.

**Every finding cites evidence** — a ledger line, a commit SHA, a status
line, a `FOREMAN_MEMORY.md` entry, or a transcript quote with a timestamp.
No citation, no finding. "It felt slow" is not a finding.

## 1. Problem intake

Ask one question at a time until you can write a one-paragraph problem
statement: which run (which plan, or which feature/bug if it was plain
`foreman` mode), roughly when, what the user expected, what happened
instead, and the observable they actually care about (wall-clock, a
specific repeated action, a step that never finished, cost). "Demorou
muito" is a complaint, not a problem statement — ask what "muito" means
here (compared to what).

## 2. Gather the evidence that already exists

Orchestrated runs through this plugin leave their own trail — check these
before reaching for anything else:

- **The ledger**, if this was a `plan-runner` run:
  `.foreman/plan-runner/<plan-slug>/progress.md`. This is the single best
  source for "was a step re-dispatched" and "what rulings were made and
  when" — read it in full, in order.
- **`FOREMAN_MEMORY.md`**'s decisions log, for `foreman`-mode runs and for
  any ruling logged there (see the "Rulings, not stalls" sections in
  `foreman`/`plan-runner`).
- **Git history** for the run's window: `git log --oneline --since=<...>`
  across the branch/worktree the run used. Commit authorship/messages from
  delegates (frontend-dev, backend-dev, plan-step-builder, etc.) show what
  was actually built, independent of what any status line claimed.
- **Status lines** (`[PENDING]`/`[DONE]`/`[BLOCKED]`) visible in this
  conversation, if diagnosing the current or a recent session in the same
  transcript.
- **The conversation transcript itself**, if this harness exposes one
  (e.g. Claude Code stores session transcripts you may be able to locate
  via the environment, or the user can point you at an export). Don't
  assume a path — confirm it against session id, working directory, and
  timestamps before trusting it; recency alone doesn't confirm identity.
  If you can't locate or access it, say so explicitly and work from the
  evidence in the three bullets above instead of guessing at its contents.

## 3. Check each dimension the evidence supports

Only check dimensions the gathered evidence can actually speak to — don't
pad the report with "no evidence either way" for things you never looked at.

- **Repeated work**: did a step/delegate get dispatched more than once for
  work the ledger or git log shows already done? Cite both dispatches
  (ledger lines or status-line timestamps) and the commit that already did
  it.
- **Plan/ruling adherence**: did execution diverge from the approved plan
  or a logged ruling without a new ruling recorded? Cite the plan section
  and the diverging commit/action.
- **Stalls**: did the run stop and wait on the user for something that
  "Rulings, not stalls" (§2.5/§3.5 in `plan-runner`/`foreman`) says should
  have been decided and logged instead? Cite the stop point.
- **Guardrail friction**: did `.orchestrator-active` block something it
  shouldn't have (see `references/guardrail-troubleshooting.md`)? Cite the
  denial.
- **Cost/time**: if the complaint is about cost or duration, count actual
  delegations (status lines or ledger entries) and flag any that look
  avoidable in hindsight (duplicate scope, a wave that could've been
  parallel but ran sequentially, etc.) — cite each one, don't estimate.

## 4. Report

Plain prose, not a template dump: what happened, in order, each claim with
its citation. End with:
- A one-line verdict per dimension checked (fine / problem found, with the
  citation).
- If a real plugin gap surfaced (not just a one-off mistake this run made),
  name the specific file/section of `foreman`/`plan-runner`/an agent that
  should change, and let the user decide whether to act on it now.
