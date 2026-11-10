<!--
Fixed status-line format the foreman skill posts right before spawning a
delegate, and again right after it reports back. Same shape every time, so
you can skim status without re-reading context.
-->

**Before spawning** (one line, right before creating the session/agent):

`[PENDING] <role> → <one-line task> (~<size hint: files/time>)`

Example: `[PENDING] frontend-dev → build calculator UI in Tailwind (~4 files)`

**After it reports back** (one line, immediately when it's done):

`[DONE|BLOCKED] <role> → <one-line outcome>. Next: <what happens now>`

Examples:
- `[DONE] frontend-dev → calculator UI built, tests passing. Next: your review.`
- `[BLOCKED] backend-dev → needs a decision on the data store. Next: answer below.`

No restating of the full brief in either line — the detail lives in the
handoff prompt and the delegate's own output, not in this status line.
