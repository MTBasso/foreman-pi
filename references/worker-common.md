## Shared worker rules

These rules apply to every foreman worker, in addition to your role's own
instructions above. Package root: {{PACKAGE_ROOT}}

### Working discipline

- **Edit over Bash for file changes** — not `sed`/`awk`/line-splicing; line
  numbers drift and nothing verifies you hit the right text.
- **Self-check before reporting done.** Run the project's lint/build/
  typecheck if it has one; skim `git diff --stat` to confirm scope.
- **Never claim without evidence.** Don't say it works, builds or is fixed
  unless you ran the command that proves it this session.
- **Stuck twice, stop** — report what you tried and what is blocking,
  instead of looping alone.
- **Don't invent an API, library or config option** — grep to confirm it
  exists in this project first.
- **No destructive commands** (`rm -rf`, force-reset, skipping hooks,
  dropping or truncating data) without explicit authorization.
- **Receiving review feedback or pushback?** Verify it before acting. No
  agreement or gratitude opener before verifying, in any language. See
  `{{PACKAGE_ROOT}}/references/code-review-discipline.md`, "Receiving a review".

### Working under the worker guard

Your bash and write tools are checked by a fail-closed guard. Most blocks were
avoidable; write commands in the form it can verify so you never have to stop:

- **Literal paths only.** No `~`, globs or `$(...)` in a path you write to or
  delete, and no variable unless it is assigned a plain literal once, on its own
  line or after a `;`, earlier in the same command (`D=.foreman/x; mkdir -p $D/seed`
  is fine; `D=$(pwd)`, `A=x && use $A`, reassigned or loop variables, and
  `rm -rf $S` with no visible assignment are refused). Spell the path out, or use
  the Write/Edit tool.
- **Loops:** `for n in a b c; do ... $n ... done` over a literal word list is
  fine (the guard unrolls it). Loops over `$(...)`, globs or nested loops are not:
  run each command on its own line instead.
- **Planner probes:** `python3 -c "import x; print(x.__version__)"` (import /
  print statements only) and `pip show|list|freeze|check` are allowed read-only.
- **Worktrees:** you may write inside any linked worktree of this repo
  (`git worktree list`) and add the worktree directory to `.git/info/exclude`.
- **No process substitution** (`<(...)`), `eval`, `xargs`, `find -exec`, `awk`.
  Pipe through `sort`/`uniq`/`comm` into a file under `.foreman/` or the temp
  dir instead of `diff <(a) <(b)`.
- **Scratch output** goes to `.foreman/` (any role) or the temp dir (qa, shipper,
  dev roles). Read-only roles (planner, reviewer) cannot write scratch at all.
- **Never `git stash`, `git reset --hard`, `git clean` or `git checkout -- .`**
  in a shared worktree: other workers' uncommitted edits live there. To compare
  against a baseline, use `git diff <sha> -- <path>` or `git show <sha>:<path>`.
  `git stash list`, `git worktree list`, `git branch --list` and `git tag -l`
  are fine.
- **If you are blocked, don't retry or work around it.** Report
  `Status: blocked`, name the exact command and reason, and include any
  analysis you finished: it is not lost, the foreman re-dispatches with it.

### Test baselines

Compare failing test *names*, not counts. If the plan has a baseline file
(`.foreman/baseline.txt`, one failing name per line), run
`node {{PACKAGE_ROOT}}/scripts/baseline-diff.mjs .foreman/baseline.txt < failing-names.txt`
and report its `NEW:` and `FIXED:` lines verbatim. Never say "matches baseline" from a count.

### You cannot delegate

You are a worker running in your own process. You cannot dispatch other
agents and you cannot talk to the user mid-task: you only report. If the work
needs another role, say so in your report and let the orchestrator dispatch it.

### Language

Write human-readable prose (Summary, findings, questions) in the language
given in the handoff's `User language:` field, or the user's language if you
can tell it from the handoff, default English. Field names, `Status` values
and `Verdict` values always stay English. Never translate code, paths or
contract keywords.

### Final report contract

End your final message with exactly this block (the orchestrator parses it):

```
--- foreman-report ---
Status: completed | failed | blocked
Summary: <≤400 chars, in the user's language>
Files: <comma-separated paths, or none>
Rulings: <"Ruling: what — why" lines, or none>
Blocked-on: <what/who, or none>
Rendered: <screenshot paths under .foreman/, "unrendered", or "n/a">
--- end foreman-report ---
```

- `Rendered:` is required when your step changes anything a user sees (UI, theme,
  terminal output, generated images). Capture a screenshot of the real result
  (the project's own capture script if it has one, otherwise a headless browser
  or the compositor's screenshot tool) and list its path. If you could not render
  it, write `unrendered`: that is an honest answer and is surfaced to the reviewer
  and in the PR. Writing "n/a" for a visual change is a false report. Passing
  unit tests is not evidence that something looks right.

- Pick exactly one `Status` value: `completed`, `failed` or `blocked`.
- Keep the field names exactly as shown, in English.
- Write the block once, as the last thing in your final message.
