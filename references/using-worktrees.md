Referenced from `foreman`'s and `plan-runner`'s step 0. Read this before
marking orchestrator mode active, so any delegate work this session spawns
happens in an isolated workspace instead of on whatever branch the user
already had checked out.

## Step 1: Detect existing isolation

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
```

**Submodule guard:** `GIT_DIR != GIT_COMMON` is also true inside a git
submodule. Before concluding "already in a worktree," check:

```bash
git rev-parse --show-superproject-working-tree 2>/dev/null
```

If that prints a path, you're in a submodule, not a worktree — treat this
as a normal repo checkout and continue to Step 2.

If `GIT_DIR != GIT_COMMON` and you're not in a submodule: you're already in
an isolated linked worktree. Skip Step 2 entirely — don't create a second
one on top of it.

## Step 2: Ask consent, then create one

If you're in a normal repo checkout (not already isolated), ask the user
once before creating a worktree for this run:

Ask, in the user's language: "Do you want me to create an isolated worktree
for this run? It protects your current branch from changes."

Honor a preference the user already stated for this session (worktree
yes/no) without asking again. If they decline, work in place — proceed
without a worktree.

If they agree:

1. **Native tool first.** If this session has a dedicated worktree tool
   (a tool literally named something like `EnterWorktree`, or a `/worktree`
   command), use it. It handles directory placement, branch creation, and
   cleanup — don't shell out to `git worktree add` on top of it.
2. **`git worktree` fallback**, only if no native tool is available:
   ```bash
   git worktree add ../<repo-name>-<short-branch-name> -b <branch-name>
   cd ../<repo-name>-<short-branch-name>
   ```
   Pick `<branch-name>` from the plan/feature being built, not a generic
   name like `work` — a second run later needs its own branch.

## Step 3: Report where you are

State plainly, once and in the user's language: "Working in worktree
`<path>`, branch `<name>`." (or, if working in place: "No worktree — working
directly on the current branch, as agreed.") Everything downstream (the `.orchestrator-active`
marker, the ledger in plan-runner's §0.5, any delegate spawned) happens
relative to this workspace.

## Cleanup

Isolation set up here is cleaned up at the natural end of the flow that
created it — `plan-runner`'s handoff (§4) or `foreman`'s release handoff —
not mid-run. If a native worktree tool created it, let that tool's own
cleanup path handle removal; for the manual `git worktree` fallback, remove
it explicitly once the branch has been merged or abandoned
(`git worktree remove <path>`), never while the run is still in progress.
