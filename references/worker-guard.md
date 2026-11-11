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

Details worth knowing:

- `VAR=$(cmd)` and ``VAR=`cmd` `` assignments are allowed; the inner command is
  parsed and judged like any other. A dynamic command *name* (`$(echo rm) x`,
  `$CMD x`) stays denied.
- Wrappers are unwrapped with their options, so `time -p rm -rf x`,
  `exec -a name rm ...`, `env -u V`, `nice -n 5`, `timeout -k 5 10`, `nohup`,
  `command` and `builtin` judge the real command. `env -S` is denied (its
  string is a command line the guard cannot see).
- Read-only roles: `sed` is parsed as sed (addresses, `s` delimiter and flags,
  `-e`/`--expression`/attached forms). Any `w`, `W`, `e` command or `s///w`,
  `s///e` flag, `-i`/`--in-place` and `-f` is denied, as is a script built from
  a variable. `xxd` is not on the allowlist (it can write its second operand).
  The reviewer never runs tests (`npm`, `node`, `tsx` are not allowed); `qa` does.
- `find`: scoped roles (`qa`, `codebase-auditor`, `shipper`) may not use
  `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint*` or `-fls`. Dev and
  builder roles may use `-delete` only with literal start paths inside the repo
  (not the repo root, not `.git`) or inside the temp dir; `-exec`/`-execdir`/
  `-ok`/`-okdir` run the given command through this same policy as if typed
  directly (`{}` counts as unresolvable), and `-execdir` commands may not use
  `..`. When the exec'd command could write (anything but a plain read-only
  command) and uses `{}`, the start paths must obey the same rule as `-delete`
  (so `find / -exec rm {} +` and `find . -exec rm {} +` are denied, and
  `find src -exec rm {} +` is allowed). `-fprint*`/`-fls` targets are path-checked.
  `find . -name '*.pyc' -delete` at the repo root stays denied (fail closed).
- `cd` is tracked within a command string: later relative paths resolve against
  the new directory, so `cd .foreman && echo x > f` is allowed for `qa` and
  `cd src && echo x > f` is not. `( ... )`, `$( ... )`, a pipeline and a
  background `cd x &` are scoped (they do not change the parent's directory).
  A `cd` to something unresolvable (`$VAR`, `~`, a glob, no argument, `cd -`,
  `pushd`/`popd`), a `cd` that is conditional (`a && cd x; ...`, inside
  `if`/`while`/`case`) or one whose target does not exist yet, followed by a
  command outside its `&&` chain, makes the directory unknown, and every later
  relative path is denied. A `cd` after `||` or negated with `!` also makes the
  directory unknown (a following `&&` runs only when it failed). `env -C DIR` /
  `--chdir=DIR` is a cd for the wrapped command only (unresolvable means unknown).
  Absolute paths still resolve.

## Honest limits

This is a heuristic guard, not a sandbox.

- Interpreters and build tools write anywhere: `node script.js`,
  `python x.py`, `make`, `npm run ...`, `git` hooks, `awk`, `tar`, `curl -o`.
  Only commands the parser can see are judged.
- Shell functions, `source`d files and scripts are not followed. A `cd` inside a
  function body is not modelled either (`case`/`select`/`function` heads and
  `name() { ... }` definitions make later `cd`s fail closed); `CDPATH` is ignored, and a `cd` into a
  directory the worker cannot enter is assumed to succeed.
- `sed` in dev roles is only checked for `-i`; its `w` commands are not
  path-checked there. Scoped roles (`qa`, `codebase-auditor`, `shipper`) get the
  read-only sed rules, so any `w`/`e` is denied.
- Dev roles' non-`rm` mutating commands (`cp`, `mv`, ...) are checked only when
  the argument is literal; `rm -r` and redirects fail closed on unresolvable ones.
- A path can change between the check and the write (time-of-check/time-of-use).
- Some safe commands are blocked (for example `cp` from `src/` for `qa`, or
  `chmod`-style numeric operands of mutating commands); the worker reports
  blocked and the orchestrator decides.
- It does not stop a model from simply reporting wrong results.

If a block is a false positive, change the policy in
`extensions/worker-guard/policy.ts` and add a case to `smoke-test.ts`.
