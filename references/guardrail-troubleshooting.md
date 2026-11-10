Referenced from `foreman`'s step 6. Read this only when a write/edit call of
yours was just denied.

The `orchestrator-guardrail` extension (`extensions/orchestrator-guardrail/`)
denies `write`/`edit` and any `bash` call that looks like a file write, while
`.orchestrator-active` exists, with one built-in exception: writes to
`FOREMAN_MEMORY.md` itself always pass through, since that's orchestration
bookkeeping, not implementation. For anything else that gets denied:

- Don't fight it by trying other tools to achieve the same write — that
  defeats the point of the guardrail.
- Tell the user plainly what got blocked and why (quote the extension's
  denial reason), and ask whether this really is foreman work that should be
  delegated, or a genuine exception the extension doesn't know about yet.
- If the user confirms it's a genuine, recurring exception, that's a sign the
  extension's allowlist should grow (edit
  `extensions/orchestrator-guardrail/index.ts` in the package itself — as the
  user, not as the foreman under its own guardrail) rather than working
  around it ad hoc each time.
