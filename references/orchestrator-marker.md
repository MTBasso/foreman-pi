Referenced from `foreman`'s and `plan-runner`'s step 0 — read this once per
session before marking orchestrator mode active, instead of re-deriving the
same steps each time.

## Create the marker

Create an empty file at `.orchestrator-active` in the project root (`touch
.orchestrator-active`) if it doesn't already exist. The
`orchestrator-guardrail` extension denies `write`/`edit` outright, denies any
`bash` call that looks like it writes a file (redirection, `sed -i`, `tee`,
`patch`, `dd`), and drops `write`/`edit` from this session's own active tools
on every turn, all while this marker exists — so the "never edit code" rule
is enforced even if you forget it mid-task.

## Keep it out of git

Make sure `.orchestrator-active` is listed in the project's `.gitignore`
(append it, creating the file if needed, if it isn't there already). It's
session-local bookkeeping, not something that should ever be committed or
carried between clones/machines.

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
