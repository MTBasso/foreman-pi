<!--
The foreman skill (or plan-runner) fills this in once the build and QA waves
for a feature or plan are done, and dispatches the reviewer role with it via
foreman_delegate. The reviewer is read-only and shares no context with the
implementers, so paste everything it needs; do not tell it to go find it.
-->

# Review handoff: <feature/change title>

## What was built
<one or two lines>

## Plan / requirements it should meet
<paste the relevant plan section or grilled requirements verbatim>

## Range
- Base branch: <branch>
- BASE_SHA: <sha, or "resolve from the base branch">
- HEAD_SHA: <sha, or "current HEAD">

## Known loose ends
<anything flagged BLOCKED, deferred or out of scope, so the reviewer does not flag it as a surprise>

## Checks to run
<none, or the read-only checks to run (tests, typecheck)>

## User language
User language: <en | pt-BR — taken from the user's messages, default en>.
