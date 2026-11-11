# Worker guard: what it enforces and what it cannot

The `worker-guard` extension (`extensions/worker-guard/`) is a path-scoped
write policy for foreman workers. Read this when a worker reports
`Status: blocked` because of it, or before trusting it as a safety boundary.

## What it does

Each worker is a child `pi` spawned with `FOREMAN_PI_SUBAGENT=1` and
`FOREMAN_PI_ROLE=<role>`. The guard is active only when both are set; in any
other `pi` process (including the orchestrator session) it does nothing. An
unknown role fails closed to read-only. Every `write`, `edit` and `bash` tool
call is checked in a `tool_call` handler; a denial carries an English reason
telling the worker to end its report with `Status: blocked`.

| Role | May write |
| --- | --- |
| `qa`, `codebase-auditor` | only `.foreman/**` and `FOREMAN_AUDIT.md` |
| `shipper` | only `.foreman/**` (git and `gh` allowed, minus force-push, `--no-verify`, `reset --hard`, `clean`) |
| `planner`, `reviewer` | nothing; bash is a strict read-only allowlist |
| `frontend-dev`, `backend-dev`, `qa-bugfix` | anywhere in the repo except `.git/`, paths outside the repo, and real `.env`/`.env.*` (examples and templates are fine); recursive `rm` only on build-artifact dirs or temp |
| `plan-step-builder` | same, but may `rm -rf` any path inside the repo (never the root, an ancestor, `.git`, outside, or an unresolvable path) |

Paths are resolved against the working directory with `..` and symlinks
followed (the real path of the nearest existing ancestor). There is no
allowance by file extension: `echo x > existing.txt` is judged by where
`existing.txt` resolves, not by its name.

Bash is parsed quote-aware: it splits on `; && || | &` and newlines, tracks
redirects, skips heredoc bodies, and recurses into `$(...)`, backticks and
`sh -c '...'`. It denies `eval`, process substitution, unbalanced quotes,
`sudo`, and any redirect or path argument built from `$VAR`, a glob or `~`.

## Honest limits

This is a heuristic guard, not a sandbox.

- Interpreters and build tools write anywhere: `node script.js`,
  `python x.py`, `make`, `npm run ...`, `git` hooks, `awk`, `tar`, `curl -o`.
  Only commands the parser can see are judged.
- Shell functions, `source`d files and scripts are not followed.
- Dev roles' non-`rm` mutating commands (`cp`, `mv`, ...) are checked only when
  the argument is literal; `rm -r` and redirects fail closed on unresolvable ones.
- A path can change between the check and the write (time-of-check/time-of-use).
- Some safe commands are blocked (for example `cp` from `src/` for `qa`, or
  `chmod`-style numeric operands of mutating commands); the worker reports
  blocked and the orchestrator decides.
- It does not stop a model from simply reporting wrong results.

If a block is a false positive, change the policy in
`extensions/worker-guard/policy.ts` and add a case to `smoke-test.ts`.
