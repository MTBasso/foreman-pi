<!--
Standard handoff template. The foreman skill fills this in and hands it
verbatim to the planner/frontend-dev/backend-dev/qa-bugfix agent or session it
delegates to, instead of improvising the prompt each time. Keeping one shape
means the receiving agent never has to re-derive context it was already given,
and never has to go re-read FOREMAN_MEMORY.md itself for things already
decided — paste the relevant fields in directly.
-->

# Handoff: <short task title>

## Role
You are the <planner | frontend-dev | backend-dev | qa | qa-bugfix | plan-step-builder> agent. <one line
on what you must and must not do, e.g. "produce a plan only, no code".>

## User language
User language: <en | pt-BR — taken from the user's messages, default en>.
Write your prose (Summary, findings, questions) in that language; field names,
`Status` values and code stay English.

## Build instructions
Build instructions: <path to a file with the repo's own build steps for this
task, or `none`. If a path is given, read it and follow it exactly; if
`none`, follow the step's Touches and Checks.>

## Grilled requirement
<the feature/bug/change, already grilled — problem, who it's for, scope
boundaries, explicit non-goals.>

## Decided context (do not re-ask these)
- Stack / library: <...>
- UI pattern / architecture pattern: <...>
- Other standing conventions: <paste the relevant FOREMAN_MEMORY.md section
  verbatim here — don't just point at the file.>

## Deliverable
<what exactly should come back: a plan, a diff + passing tests, a root-cause +
fix, etc. — and the done condition.>

## Constraints
<anything time/scope-boxing the work: files not to touch, patterns not to
introduce, performance/security notes.>

## About `.orchestrator-active`
If you notice that marker file in this project, it does not apply to you —
you are running as your own `pi` process with your own `write`/`edit` access
from your `tools:` frontmatter, not the orchestrator session. Proceed with
your task normally; don't ask whether to delete it or pause to confirm. (A
live test caught a subagent stalling on exactly this question instead of
just doing the edit — this line exists so you never have to guess.)
