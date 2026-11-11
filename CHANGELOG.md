# Changelog

## [0.2.0]

### Added

- Worker report contract: every worker ends with a `--- foreman-report ---` block (`Status`, `Summary`, `Files`, `Rulings`, `Blocked-on`). The coordinator parses it, the notification carries the parsed fields and a `contract` value (`ok`, `missing`, `malformed`), and the keywords stay English whatever language the prose is in.
- Per-agent model tiers (`strong|mid|cheap`) and thinking levels in agent frontmatter, with `FOREMAN_MODEL_<ROLE>`, `FOREMAN_MODEL_<TIER>` and `FOREMAN_THINKING_<ROLE>` overrides. No model ids ship, and the session model (including `foreman/hybrid`) is inherited by default.
- `reviewer` (strong tier, read-only) and `shipper` (mid tier) roles.
- Slash commands: `/foreman`, `/foreman off` (confirms before aborting running workers; refuses without a UI), `/foreman-status`, `/foreman-audit`, `/foreman-diagnose`, `/plan-runner <plan>`.
- Status bar entry and worker widget for orchestrator mode.
- `extensions/worker-guard/`: a path-scoped write/bash policy per worker role (lighter profile for `plan-step-builder`), driven by `FOREMAN_PI_ROLE`. A heuristic guard, not a sandbox; see `references/worker-guard.md`.
- `lib/i18n.ts`: English and Brazilian Portuguese UI strings, selected by `FOREMAN_LANG` or the environment locale. The conversation language follows the user's messages.
- Shared `lib/` (`roles`, `agents`, `spawn`, `model-policy`, `mode`, `workers`, `ui`).
- Packaging manifest (`files`, `engines`, author, `pi.changelogPath`), `npm run test:package` (real install into a sandbox), and GitHub Actions CI.
- `README.pt-BR.md`, `docs/verification-log.md`, and `npm run test:readme` (Model fallback section byte-identical to `main`, README role/command lists match the code, stale-reference grep gate).

### Changed

- Orchestrator mode no longer uses a marker file. It is session state: a persisted `foreman-mode` session entry, the `foreman:mode` event, and the `FOREMAN_PI_MODE` environment override. Workers (`FOREMAN_PI_SUBAGENT=1`) are always exempt.
- Tools removed by the guardrail are restored when the mode is turned off.
- The README is rewritten in English; the 0.1.x live-verification notes moved to `docs/verification-log.md`.
- Stray Portuguese removed from English prompts and references.

### Removed

- The vendored `subagent-dispatch` extension (and with it the standalone `subagent` tool).
- The `release-manager` agent, with no alias; use `shipper`.
- The `.orchestrator-active` marker file and everything that read or wrote it.

### Upgrade note

A leftover `.orchestrator-active` file from 0.1.x is ignored and can be deleted. Enter orchestrator mode with `/foreman` (or set `FOREMAN_PI_MODE=orchestrator` for RPC and print runs). Replace any use of the `release-manager` role with `shipper`.
