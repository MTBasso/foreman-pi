# Plan: herdr worktrees per worker, worker panes, render gate

Origin: analysis of the ibm-carbon-theme session (44 workers). Phase 1 shipped in
Unreleased (guard loosening, worker cheat-sheet, baseline-diff, 429 retry, herdr
title/notifications). Remaining phases, in order:

## Phase 2: worktree per parallel worker (fixes the shared-tree stash incident)
- `foreman_delegate` takes optional `isolate: true` (default true when another
  dev worker is running). Before spawn: `herdr worktree create` (or `git worktree add
  .foreman/worktrees/<task>`) from the plan branch tip; worker cwd = that tree.
- On completion the coordinator rebases/cherry-picks the worker branch back; conflicts
  turn the notification into `blocked` with the conflicting paths.
- Skip repo hooks that touch the live desktop: set `FOREMAN_WORKTREE=1` in the
  environment and document that `post-checkout` hooks should honour it.
- Tests: spawn-test with a temp repo, two parallel workers editing the same file.

## Phase 3: workers in herdr panes
- When `herdr` is active, spawn the worker via `herdr pane split` + `herdr pane run`
  (visible, attachable) instead of a hidden child; completion via `herdr agent wait`,
  report still read from the JSON event stream or the report file.
- Keep `pi --mode json` as the default and fallback outside herdr.

## Phase 4: render-or-flag gate for UI steps
- Plan template gets a `Renders:` field per step. A step with `Renders: yes` must end
  with a screenshot path under `.foreman/` or `Unrendered: true` in its report.
- Reviewer and shipper templates surface `Unrendered` steps in the PR body.

## Phase 5: smarter worker-guard
- Resolve `$VAR` when assigned from a literal earlier in the same command.
- Planner may write `docs/plans/<slug>.md` directly.
