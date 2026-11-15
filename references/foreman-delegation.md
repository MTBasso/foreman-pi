# Foreman: delegation details

Read this once, when you are about to plan, build, test or ship. It holds the rules that sit around the delegate loop in `SKILL.md` §4: preview files, splitting, parallel and dependent steps, spot-checks, review, and what each phase delegates.

**Surface preview files, don't just mention them.** `frontend-dev` and `qa`
run as separate worker processes, and so does `codebase-auditor` (see `references/foreman-audit.md`) —
when any of them name a `.foreman/previews/*.html`
path in their report, read it yourself and tell the user exactly how to
open it (or open it directly if this session has
a way to), rather than leaving them to go find the file themselves.

**Multi-item requests get split, not bundled.** If what the user described
is really several distinct pieces of work (e.g. "fix this bug, then move
that element"), delegate each one as its own `foreman_delegate` call with its own
`[PENDING]`/`[DONE]` pair rather than handing all of them to one agent that
only reports back once everything is done. A worker can't message you
mid-task — this is how you still get visible progress per item (one
notification each) instead of silence until the whole batch finishes. Only bundle items into one
delegation when they're genuinely one unit of work (e.g. a handful of
one-line tweaks to the same component).

**Parallel delegation needs an overlap check first, a conflict check after.**
Independent items (confirmed against the plan's file scope — no two touch
the same file) are dispatched in parallel: several `foreman_delegate` calls
in one response, then END YOUR TURN. If any
two might touch the same file, or you can't tell from the plan, dispatch them
sequentially instead — don't guess. Once the notifications for every
delegate in the wave have arrived, have a read-only delegate (`qa`) run `git diff --stat` over the combined changes (you have no Bash) and
check for a file more than one of them claimed to own. A real overlap is a
conflict to resolve before this wave counts as done, not something to wave
through because each agent individually reported green.

**Dependent steps are sequential, never parallel.** If step B needs step A to
have succeeded (push a branch, *then* open a PR; commit, then push; build, then
deploy), they must not be issued together — not as parallel `foreman_delegate`
calls, not as two calls in one turn, not as `a & b` in one command. Delegate A,
end your turn, and when A's `<task-notification>` arrives confirm it actually
succeeded (see its `[DONE]`/evidence), and only
then delegate B. If A fails, stop and report; never fire B anyway. Example of
what is forbidden: a single turn that dispatches both `git push` and
`gh pr create`. Only steps with no data or ordering dependency may go in
parallel (and only after the overlap check above). When handing a feature to
`shipper`, one agent runs these in order; do not split push and PR
creation across concurrent delegates.

**Spot-check claims, don't just relay them.** Before relaying a `[DONE]`
report to the user, or handing a feature off to `shipper`,
independently have at least one check the delegate claimed re-run (its test,
build, or lint command) by a *different* worker such as `qa` — rather than
trusting the report's word alone. While orchestrator mode is on you
have no `bash`, `write` or `edit` tool (the guardrail strips and blocks them, see
`extensions/orchestrator-guardrail/`); inspect with `read`/`grep`/`find`/`ls` and
delegate every command via `foreman_delegate` (e.g. role `qa`), then read its
notification when it wakes you.
A completed plan-step notification with `verified: yes` already is that independent re-run of the step's declared Checks; `verified: no` is not green, and `n/a` or no line means spot-check as above.
The spot-check is itself a delegation: dispatch it, end your turn, and relay
the delegate's `[DONE]` only after the check's own notification comes back green. This is a spot-check, not a full
re-audit, but a self-reported
"all green" with nothing re-run by you is exactly the gap that matters when
nobody's watching the sub-agent work in real time.

**Request a real review before the release handoff, and don't rubber-stamp
its reply.** Read `references/code-review-discipline.md` once per session
(skip if you already have) and apply both halves of it: how to request a
review (the `reviewer` role: fresh context, real SHAs, no shared history with
the implementer) before handing off to `shipper`, and how to receive one without
performative agreement if the user or a delegate pushes back on your plan.

- **Planning**: once the feature is grilled and the relevant context gathered,
  delegate to the `planner` role (its own `pi` process, read-only tools —
  see `agents/planner.md`) via `foreman_delegate`. Fill in
  `templates/handoff-prompt.md` from this plugin rather than improvising the
  prompt — it forces you to paste the decided context in directly instead of
  telling the receiving agent to go re-read files itself. Bring the resulting
  plan back to the user in this conversation for approval before moving on.
- **Building**: once the user approves the plan, delegate to the appropriate
  specialized role (`frontend-dev`, `backend-dev`, or both) with the
  approved plan plus the same standardized context, again via
  `templates/handoff-prompt.md`. You do not touch the diff yourself — the
  orchestrator-guardrail extension will deny write/edit from this session
  anyway while orchestrator mode is on; the worker process has its
  own write/edit access from its `tools:` frontmatter, unaffected by your
  restriction.
- **Testing, before release**: once building is done, delegate to the `qa` role as
  its own wave to actually run UI/API tests against the build — don't go
  straight from "built" to the release handoff. If `qa` finds a problem, send
  it to `qa-bugfix` with the repro `qa` produced, then re-run `qa` once fixed.
  Only proceed once `qa` reports green (or the user explicitly accepts a
  known gap). When a worker, a reviewer or the user pushes back on your plan
  or your QA reading, verify before agreeing: no agreement or gratitude
  opener before checking, in any language (pt-BR example to avoid:
  `[pt-BR]` "Você tem toda a razão!").
- **Testing/bugs, after release**: subscribe to activity on any PR this
  produced. When CI fails or a review comment lands, delegate the
  investigation/fix to `qa-bugfix` rather than fixing it yourself. Report
  outcomes back to the user here.
- **Review, then ship**: once all waves for this feature are done
  ([DONE] or explicitly accepted [BLOCKED]), the flow is `reviewer`, then
  (if changes are requested) `qa-bugfix` and a re-review, then `shipper`:
  1. Fill in `templates/review-handoff-prompt.md` and dispatch the `reviewer`
     role via `foreman_delegate` over the whole accumulated diff. Post
     `[PENDING] reviewer → full diff review` first. END YOUR TURN.
     Fill its `## Unrendered visual steps` from the `rendered:` lines in the
     worker notifications (`unrendered`, or a visual step with no screenshot);
     if a visual step lacks one, consider a `qa` pass that captures it before review.
  2. On its notification read the `Verdict:` token in the summary.
     `Verdict: changes-requested`: delegate the fixes to `qa-bugfix` with the
     findings, then dispatch the `reviewer` again over the new range. Repeat
     until `Verdict: approve` or the user explicitly accepts the open findings.
  3. On `Verdict: approve`, fill in `templates/release-handoff-prompt.md` —
     reusing the status lines you already posted and the relevant
     `FOREMAN_MEMORY.md` entries — including its `## Review` section (reviewer
     task id, reviewed `BASE_SHA..HEAD_SHA`, verdict); the footer carries the
     language.
     Dispatch the `shipper` role via `foreman_delegate` with it — no new
     session, no copy-paste. Post `[PENDING] shipper → packaging and shipping`
     first. The shipper does not push or open a PR unless the handoff's
     instructions say so, and that only when the user explicitly asked.
  4. When it reports back ([DONE]/[BLOCKED]), relay that to the user. You are
     done once this handoff is sent — packaging commits (and the PR, if asked)
     is the shipper's job, not yours.
