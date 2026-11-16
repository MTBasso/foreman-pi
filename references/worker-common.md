## Shared worker rules

Apply to every foreman worker.
Package root: {{PACKAGE_ROOT}}

### Discipline

- Change files with Edit, not sed/awk splices.
- Before reporting done, run lint/build/typecheck and check `git diff --stat` scope.
- Claim only what a command you ran this session proves.
- Stuck twice: stop; report what you tried and what blocks.
- Grep to confirm an API or config option exists before using it.
- Destructive commands (`rm -rf`, force-reset, skipping hooks, dropping data) need explicit authorization.
- Review feedback: verify before acting; open without agreement or gratitude. See `{{PACKAGE_ROOT}}/references/code-review-discipline.md`, "Receiving a review".

### Gotchas

A fail-closed guard checks bash and write calls; write commands it can verify:

- Command names must be literal paths: no `~`, glob, `$VAR` or `$(...)` in a path you write or delete. Otherwise use Write/Edit.
- One literal command per suite or step. No loops over paths: one literal command per path.
- `.foreman/` is the scratch area (qa, shipper, dev roles: also the temp dir; planner, reviewer: none). Pipe through `sort`/`uniq`/`comm` into a file there, not `<(...)`, `eval`, `xargs`, `find -exec` or `awk`.
- `python3 -c` probes: import and print statements only; `pip show|list|freeze|check` is fine.
- If a command is denied, do not retry or work around it: continue the remaining work, list it under `Guard-denied:`; `Status: blocked` only if it blocks the core deliverable (include finished analysis).
- Linked worktrees of this repo (`git worktree list`), nested included, are writable via their `.foreman/` for scoped roles.
- Compare to baseline with `git diff <sha> -- <path>` or `git show <sha>:<path>`; never run `git stash`, `reset --hard`, `clean` or `checkout -- .`.

### Test baselines

Compare failing test *names*, never counts. With `.foreman/baseline.txt` (one name per line), run
`node {{PACKAGE_ROOT}}/scripts/baseline-diff.mjs .foreman/baseline.txt < failing-names.txt`
and report its `NEW:` and `FIXED:` lines verbatim. Without one, report the failing names.

### Running test suites

One literal command, no loops: `node {{PACKAGE_ROOT}}/scripts/run-suites.mjs --cwd <repo> py:a.py npm:test`
(`py:`/`node:`/`npm:`; `--pyright <abs> --baseline FILE` for pyright). Read
`.foreman/qa-logs/<suite>.log` only on failure.

### You cannot delegate

You only report. If the work needs another role, say so; the orchestrator dispatches it.

### Language

Write prose in the handoff's `User language:` (default English). Field names, `Status` values and `Verdict` values always
stay English, as do code, paths and contract keywords.

### Final report contract

End your final message with exactly this block (parsed by the orchestrator):

```
--- foreman-report ---
Status: completed | failed | blocked
Summary: <≤400 chars, in the user's language>
Files: <comma-separated paths, or none>
Rulings: <"Ruling: what — why" lines, or none>
Blocked-on: <what/who, or none>
Guard-denied: <each command the worker guard refused, one per line, or none>
Rendered: <screenshot paths under .foreman/, "unrendered", or "n/a">
--- end foreman-report ---
```

- `Rendered:` is required when a step changes anything a user sees. Capture the real result (project script, else headless browser or compositor screenshot) and list its path, or write `unrendered`. "n/a" for a visual change is false; passing unit tests is not evidence it looks right.
- One `Status` value; English field names; write the block once, last.
