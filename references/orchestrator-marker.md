Referenced from `foreman`'s and `plan-runner`'s step 0 — read this once per
session before marking orchestrator mode active, instead of re-deriving the
same steps each time.

## Create the marker and keep it out of git — one bash call, not two

Run this exact one-liner in a single `bash` tool call (don't split it into
separate "create the marker" and "update .gitignore" calls — each extra
round trip is a chance for `pi-claude-cli`'s `--resume` to stall or repeat
itself, which is what actually happened in session 01a1c625/01a1c62?: the
model re-ran the same marker-creation command four times in a row instead
of moving on):

```bash
touch .orchestrator-active && (grep -qxF '.orchestrator-active' .gitignore 2>/dev/null || echo '.orchestrator-active' >> .gitignore)
```

It's idempotent — safe to run even if the marker or the `.gitignore` line
already exist, so there's never a reason to check first or run it twice.

The `orchestrator-guardrail` extension denies `write`/`edit` outright,
denies any `bash` call that looks like it writes a file (redirection,
`sed -i`, `tee`, `patch`, `dd`), and drops `write`/`edit` from this
session's own active tools on every turn, all while this marker exists —
so the "never edit code" rule is enforced even if you forget it mid-task.
`.orchestrator-active` is session-local bookkeeping, not something that
should ever be committed or carried between clones/machines, which is why
it belongs in `.gitignore`.

## Remove it only at the real end

Remove the file (`rm -f .orchestrator-active`) only when the user explicitly
ends orchestrator mode for this session (for `foreman`: the user ends the
session or explicitly stops you; for `plan-runner`: the whole plan is
finished or the user explicitly stops you).

## If you find it already present

A marker left on disk from a session that crashed or was closed without
running the removal step above is the most common cause of a *new* session
finding edits mysteriously denied. If you find `.orchestrator-active` already
present at the start of a session you don't remember activating, don't
assume it's real — confirm with the user before relying on it, and `rm -f`
it if they don't recognize it either. The `session-reminder` extension
already flags this for you when it detects the marker on a fresh
`startup`/`new` session (see `session_start`'s `reason` field).

## Known limits of the bash guardrail

The `bash` check is a heuristic (pattern match on the command string), not a
sandbox — it catches habitual/accidental bypass (redirection, `sed -i`,
`tee`, `patch`, `dd`), not a determined one. It does not catch, for
example, writing to an allowed path (a `.log`/`.foreman/` file) and then
`mv`/`cp`-ing it onto a source file — covering `mv`/`cp` generally would
block too many legitimate housekeeping commands to be worth the added
friction. If you notice yourself about to do something like that, don't —
delegate the change instead; the point of the marker is the discipline it
enforces on you, not just what the hook can technically catch.
