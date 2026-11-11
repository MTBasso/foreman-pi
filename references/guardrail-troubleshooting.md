Referenced from `foreman`'s step 6. Read this only when a write/edit/bash call
of yours was just denied.

The `orchestrator-guardrail` extension (`extensions/orchestrator-guardrail/`)
denies `write`/`edit`, and `bash` entirely, while orchestrator mode is on
(entered with `/foreman`, left with `/foreman off`; see
`references/orchestrator-mode.md`), with one built-in exception: writes to
`FOREMAN_MEMORY.md` at the project root always pass through, since that's
orchestration bookkeeping, not implementation. For anything else that gets
denied:

- Don't fight it by trying other tools to achieve the same write — that
  defeats the point of the guardrail.
- Tell the user plainly what got blocked and why (quote the extension's
  denial reason), and ask whether this really is foreman work that should be
  delegated, or a genuine exception the extension doesn't know about yet.
- Only the user can leave the mode (`/foreman off`). Suggest it if the task is
  not orchestration work; do not try to turn it off yourself.
- If the tools seem to be missing while you are *not* in the mode (for
  example right after `/foreman off` or `/reload`), say so: the guardrail
  restores the previous tool list when the mode turns off, and `/reload`
  falls back to Pi's built-in defaults.
- If the user confirms it's a genuine, recurring exception, that's a sign the
  extension's allowlist should grow (edit
  `extensions/orchestrator-guardrail/index.ts` in the package itself — as the
  user, not as the foreman under its own guardrail) rather than working
  around it ad hoc each time.
