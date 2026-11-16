# Handoff: Plan readme-gap, step 6 (One schema pass for all Phase 2 data)

You are the plan-step-builder agent. Implement ONLY step 6 of docs/plans/readme-gap.md, fully (migration + schema.sql + tests), and commit it.

## Build instructions
Build instructions: none. Follow step 6's Touches and Checks, the plan's "Decisions (resolved)" and "Conventions every step follows". Keep the DDL in migrations.py and schema.sql identical (the migrations.py docstring lists the drift points).

## Grilled requirement
Work ONLY in the worktree /home/null/Code/directAds/.worktrees/readme-gap (branch feat/readme-gap). Phase 1 (steps 1-5) is committed. Touch only app/migrations.py, schema.sql, app/services/test_schema_migration_mock.py (new). Check whether the revised plan added anything to step 6 (e.g. a pixel_id column) and follow the plan text. Commit: "feat(db): schema pass for carousel, drafts, nicknames, saved audiences".
Python is exactly `/home/null/Code/directAds/.venv/bin/python`. Never touch workspace/*.sqlite (the live DB).
Run your new suite, test_smart_approval_mock, test_publish_pause_mock, test_i18n_mock and pyright on touched files (~29 pre-existing pyright errors; report only NEW ones).

## Deliverable
Step 6 committed with checks passing. Report commit sha, results, rulings.

## Constraints
No push. Nothing on master. Do not edit other steps' files.
