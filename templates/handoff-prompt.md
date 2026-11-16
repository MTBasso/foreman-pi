<!--
Standard handoff template. The foreman skill fills this in and hands it
verbatim to the planner/frontend-dev/backend-dev/qa-bugfix agent it
delegates to. One shape means the receiver gets the context it needs and
the relevant FOREMAN_MEMORY.md fields pasted in directly.
The coordinator appends a footer to the prompt (User language, "orchestrator
mode does not apply to you", working directory, pointer to the shared worker
rules): omit those here. Add a `User language:` line under Constraints
only when it differs from the machine locale.
-->

# Handoff: <short task title>

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
  verbatim here.>

## Deliverable
<what exactly should come back: a plan, a diff + passing tests, a root-cause +
fix, etc. — and the done condition.>

For a revision handoff (planner): apply these decisions to the existing plan with edits, not a full rewrite.

## Constraints
<anything time/scope-boxing the work: files off limits, patterns to avoid,
performance/security notes.>
