# Handoff: readme-gap step 0 (worktree + baseline)

plan-step-builder: do only this step. No feature code.

## Build instructions
Build instructions: none (step 0 Touches and Checks in docs/plans/readme-gap.md).

## Grilled requirement
1. From /home/null/Code/directAds run: `git worktree add ../directAds-readme-gap -b feat/readme-gap` (from master). Do not touch the untracked files in the main checkout.
2. Inside the new worktree, follow docs/plans/readme-gap.md "Phase 0: baseline": run pyright and every existing suite (`.venv/bin/python -m app.services.test_<name>_mock`; the .venv lives in the main checkout at /home/null/Code/directAds/.venv, so use that interpreter by absolute path, with cwd in the worktree). Make sure docs/plans/readme-gap.md is present in the worktree (copy it from the main checkout if untracked, and commit it with message "docs(plan): readme-gap plan"). Write failing test names, one per line, to .foreman/baseline.txt in the worktree (do not commit it).

## Decided context
Python/FastAPI, SQLite, fish shell, i18n en+pt-BR. Never write secrets to disk. Do not copy .env into the worktree's tracked files.

## Deliverable
Report worktree absolute path, branch, HEAD sha, and baseline results (failing suites/pyright, if any). Completed when the worktree exists and baseline.txt is written.

## Constraints
No changes to master. No push.
