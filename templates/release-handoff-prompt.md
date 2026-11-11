<!--
The foreman skill fills this in once its delegated waves for a feature are
done (planning + building + any QA/bugfix loop), and spawns the
shipper agent directly with this as its prompt -- same session, no
copy-paste into a new one.
-->

# Release handoff: <feature/change title>

## Waves completed
- <role> — <one-line task> — [DONE|BLOCKED] <outcome> — <sequential | parallel with: role(s)>
- <role> — <one-line task> — [DONE|BLOCKED] <outcome> — <sequential | parallel with: role(s)>
<!-- one line per delegation, reuse the handoff-summary status lines as-is;
flag which ones ran in parallel so shipper knows where to actually
check for file overlap, not just trust each wave's own report -->

## Review
<!-- required: the shipper reports Status: blocked without it, or if the verdict is not approve -->
- Reviewer task id: <task id of the reviewer delegation>
- Reviewed range: <BASE_SHA>..<HEAD_SHA>
- Verdict: approve
<!-- paste the reviewer's `Verdict:` token verbatim; it is always English -->

## Instructions
<!-- "Commit only" by default. Write "Push and open a PR" only if the user explicitly asked for it. -->
<commit only | push and open a PR>

## Why (from FOREMAN_MEMORY.md)
<paste the relevant decisions-log entries verbatim — the reasoning behind the
stack/pattern choices this release embodies, so commit messages/PR
description can reflect it instead of guessing>

## Known loose ends
<anything flagged as BLOCKED, deferred, or explicitly out of scope — the
shipper should see these before packaging, not discover them>

## User language
User language: <en | pt-BR — taken from the user's messages, default en>.

## Branch / target
<branch name, base branch, whether a PR already exists>
