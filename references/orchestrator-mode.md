Referenced from `foreman`'s and `plan-runner`'s step 0 — read this once per
session, instead of re-deriving the same facts each time.

## What orchestrator mode is

Orchestrator mode is session state, not a file. It is turned on by the
user's command (`/foreman`, `/plan-runner <plan>` or `/foreman-audit`), or by
the `FOREMAN_PI_MODE=orchestrator` environment variable for RPC, print and
live runs. It is turned off by `/foreman off`. It is stored as a `foreman-mode`
entry in the session, so it survives `/reload`, resume and fork.

**Entering the mode is the command's job, not yours.** Do not create files,
run `touch`, or edit `.gitignore` to "mark" anything. If you were not started
by one of those commands, you are not in the mode. If `foreman_delegate`
refuses with a not-in-mode error, tell the user to run `/foreman`, and never
try `bash` or file edits to work around it.

The `foreman-session-reminder` message already says whether the mode is
active (the "Orchestrator mode: active|inactive (source)" line). Use it; do
not re-check.

## What the guardrail does while the mode is on

The `orchestrator-guardrail` extension denies `write`/`edit` outright, denies
`bash` entirely, and drops `bash`/`write`/`edit` from this session's active
tools, so the "never edit code" rule is enforced even if you forget it
mid-task. Writes to `FOREMAN_MEMORY.md` at the project root always pass
through. `/foreman off` restores the tools.

Workers are never restricted: each one is its own `pi` process
(`FOREMAN_PI_SUBAGENT=1`), and that flag always wins over the mode, even if
`FOREMAN_PI_MODE` is inherited from the parent.

## Leaving the mode

Only the user leaves it, with `/foreman off`. If workers are still running,
that command asks the user to confirm aborting them; with no UI it refuses and
the mode stays on. Never try to leave the mode yourself.

## If the mode looks wrong

- A new session (`startup` or `new`) always starts with the mode off: a
  leftover from a dead session cannot exist.
- On resume or fork of a session that was in the mode, the user is asked
  whether to keep it. No answer keeps the restored state.
- A stray marker file from an older version of this package does nothing
  (nothing reads or writes marker files any more). It can be deleted.
- `FOREMAN_PI_MODE=orchestrator` forces the mode on and `FOREMAN_PI_MODE=off`
  forces it off, over anything stored in the session. `/foreman off` says so
  when the variable is what keeps it on.

## Known limits of the bash guardrail

The `bash` check is a blunt one: bash is simply not available while the mode
is on. If you notice yourself looking for another route to write a file (an
allowed path and then a move, for example), don't — delegate the change
instead; the point of the mode is the discipline it enforces on you, not just
what the hook can technically catch.
