# Handoff: Plan readme-gap, step 15 (Drafts UI)

You are the plan-step-builder agent. Implement ONLY step 15 of docs/plans/readme-gap.md and commit it.

## Build instructions
Build instructions: none. Follow step 15's Touches and Checks, the plan's "State coverage" (drafts: list loading/empty/failed; opened draft; read-only draft with batches; delete confirm; delete refused 409; save success/failed) and "Conventions every step follows" (UI style, i18n parity and sorted keys, re-record golden with `--record builder`, update JS-key golden list in test_i18n_assets_mock.py, no hard-coded English in JS, escaped output).

## Grilled requirement
Worktree /home/null/Code/directAds/.worktrees/readme-gap, branch feat/readme-gap. Everything up to step 13 is committed. Drafts backend is `git show badde5b` (GET /api/campaigns, PUT /{id}, POST /{id}/duplicate, DELETE /{id}; specs with batches are immutable, 409). Targeting form parser is step 10 (`git show 78472e7`), cards model is step 13 (`git show eb13b2b`). Touch only: app/templates/builder.html, app/static/js/builder.js, app/static/css/main.css, app/routes/pages.py, app/i18n/en/builder.json, app/i18n/pt-BR/builder.json, app/i18n/golden/builder.html, app/services/test_i18n_assets_mock.py. Build a compact drafts panel at the top of step 1 (list, open, duplicate, delete with confirm), `/builder?draft=<id>` deep link, opening fills every field and shows stored media as already uploaded, "Save draft" updates the open draft (state.specId) instead of inserting a new row, a draft with batches opens read-only with "duplicate to edit". If Smart Approval swap cards cannot show already-uploaded server paths without a refactor, open such drafts duplicate-only and report that as a known limit. Commit "feat(builder): campaign drafts panel".
Python is exactly `/home/null/Code/directAds/.venv/bin/python`. Before reporting done run test_i18n_mock, test_i18n_assets_mock, test_drafts_mock, test_carousel_mock and pyright on touched paths.

## Decided context
Python/FastAPI, Jinja2 + vanilla JS, dark theme amber #f0a830, i18n en+pt-BR.

## Deliverable
Step 15 committed with checks passing. Report commit sha, results, rendered line, rulings, known limits (try to screenshot into .foreman/previews/).

## Constraints
No push. Nothing on master. Do not edit other steps' files.
