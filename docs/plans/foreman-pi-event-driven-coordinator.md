# Implementation Plan: Event-driven coordinator for foreman-pi

Status: APPROVED by user. Branch: feat/event-driven-coordinator, one commit per phase, PR only on user's word.

## Overview
Add a `foreman_delegate` tool in a new `extensions/coordination/` extension that spawns a child `pi` worker and returns immediately. The orchestrator ends its turn; the extension wakes it with a `<task-notification>` custom message when workers finish. The extension also owns the progress ledger. Three phases.

## Verified API facts (pi 1.5.2 types.d.ts + docs/extensions.md)
- `pi.sendMessage(message: Pick<CustomMessage,"customType"|"content"|"display"|"details">, options?: {triggerTurn?: boolean; deliverAs?: "steer"|"followUp"|"nextTurn"})` returns void (types.d.ts:1303). `triggerTurn` only applies to steer/followUp; an idle session without it only stores the message. followUp waits until the agent has no more tool calls; steer (default) delivers before the next LLM call.
- `convertToLlm` (dist/core/messages.js) turns `role:"custom"` into `role:"user"` text. The `context` event runs BEFORE conversion, so handlers see `{role:"custom", customType, content, details, timestamp}`.
- `context` event: `{type:"context", messages}` (structuredClone, system messages stripped); handler may return `{messages}`; non-destructive (session file keeps full history). `context_with_system` only needed to edit the system prompt (we don't).
- `agent_end` `{messages}` fires per run; `agent_settled` `{aborted}` is the final idle signal; `agent_start` marks start. Also `session_start`, `session_shutdown`, `turn_start`, `tool_call`.
- `pi.appendEntry(customType, data?)` void; read back via `ctx.sessionManager.getEntries()` (type==="custom").
- `pi.getActiveTools()/setActiveTools(names)`; unknown names ignored.
- `pi.registerTool({name,label,description,promptSnippet?,promptGuidelines?,parameters (TypeBox; StringEnum from @earendil-works/pi-ai),execute(toolCallId,params,signal,onUpdate,ctx),renderCall?,renderResult?})`; `registerMessageRenderer(customType, renderer)`.
- `ctx.isIdle()`, `ctx.hasPendingMessages()` exist on ExtensionContext (not on pi).
- Print mode exits after the last prompt, so a `--print` orchestrator can't receive a wake-up; live wake tests use `pi --mode rpc`.
- Existing: subagent-dispatch/index.ts is vendored and excluded from tsc (runSingleAgent/getPiInvocation not exported); children spawn with `--mode json -p --no-session [--model] [--thinking] --tools ... --append-system-prompt <tmpfile> "Task: ..."`, parse `message_end` JSON lines, FOREMAN_PI_SUBAGENT=1. agents.ts exports discoverAgents(cwd, scope). `.gitignore` already ignores `.foreman/`. instructions-test.ts regex-asserts text in skills/foreman/SKILL.md (keep those passages intact).

## Architecture changes
- extensions/coordination/index.ts (wiring), coordinator.ts (pure logic, injected {spawn, sendMessage, appendEntry, now, fs root, isOrchestratorActive}), spawn-worker.ts (default spawner, copy of dispatch spawn logic), smoke-test.ts, live-rpc.ts.
- extensions/context-filter/index.ts + smoke-test.ts (+ live-rpc.ts) (Phase 2).
- extensions/orchestrator-guardrail: allowlist changes (Phase 1 and 3), subagent block (Phase 3), tests extended.
- skills/foreman/SKILL.md, skills/plan-runner/SKILL.md event-driven rewrite. agents/*.md untouched.
- PLAN.md, README.md, package.json.

## Phase 1: Coordinator
1. Create branch (done as part of this commit flow). Risk low.
2. coordinator.ts: createCoordinator(deps). delegate({role, handoff_prompt, plan_step?, plan_slug?}): validate role enum (planner|frontend-dev|backend-dev|qa|qa-bugfix|release-manager|plan-step-builder|codebase-auditor); task_id `t<seq>-<role>`; run_id per session (timestamp+random); write .foreman/runs/<run-id>/<task_id>.json meta before spawning; spawn if running < FOREMAN_MAX_WORKERS (default 4) else queue; return {task_id, state, ack} synchronously. Status: failed = nonzero exit/signal/spawn error/stopReason error|aborted/timeout (FOREMAN_WORKER_TIMEOUT_MS default 30min, SIGTERM->SIGKILL); blocked = first non-empty line of final report starts with [BLOCKED]; else completed. Full output to <task_id>.md (for failures: stderr, error, partial text). summary = report with [BLOCKED] prefix stripped, whitespace-collapsed, ~400 chars. Batching: completions debounced (FOREMAN_BATCH_MS default 300), one sendMessage with N blocks:
```
<task-notification>
task-id: t3-qa
role: qa
status: completed
plan-step: 4
summary: ...
output: .foreman/runs/<run-id>/t3-qa.md
</task-notification>
```
customType "foreman-task-notification", display true, details {notifications:[...]}. Delivery: idle -> {triggerTurn:true}; busy -> {deliverAs:"followUp", triggerTurn:true}; busy tracked via agent_start/agent_settled. Ledger: before sendMessage, appendFileSync to .foreman/runs/<run-id>/ledger.log and, when plan_slug known, .foreman/plan-runner/<plan_slug>/progress.md; line `<ISO> — step <N|-> <status> — <role> — <summary ≤200> — <output path>`. Persistence: pi.appendEntry("foreman-task", {...}) on dispatch and on completion. Recovery on session_start: task with no completion entry but .md exists -> notify; no output -> failed "orphaned (orchestrator restarted)". Risk medium.
3. plan_slug: optional param next to plan_step; first non-empty slug latched in run.json, later calls inherit. Risk low.
4. spawn-worker.ts: spawnWorker({role,prompt,cwd,model,thinkingLevel,signal}) -> {done: Promise<{code,signal,messages,stderr,stopReason,errorMessage}>, kill()}; discoverAgents(cwd,"user"); FOREMAN_PI_SUBAGENT=1; if prompt >~100KB write to <run>/<task>.prompt.md and pass a pointer. Risk medium.
5. index.ts: if FOREMAN_PI_SUBAGENT==="1" export no-op. Else register foreman_delegate unconditionally at load; execute re-checks .orchestrator-active (isError if absent); promptGuidelines: "delegate then END YOUR TURN; never poll". renderCall `foreman_delegate <role> · step <plan_step>` + prompt preview; renderResult task_id/state; registerMessageRenderer for notifications. Handlers: agent_start/agent_settled (busy flag; on settle re-check undelivered notifications and re-send with triggerTurn), session_start recovery, session_shutdown SIGTERM children + appendEntry state aborted. Capture ctx.model/thinkingLevel in execute. Risk medium.
6. Guardrail: ORCHESTRATOR_TOOLS = ["read","grep","find","ls","subagent","foreman_delegate"]; blocks intact. Risk low.
7. coordination/smoke-test.ts with fake ExtensionAPI + fake spawner: execute resolves before worker; ack has task_id; notification fields; status mapping; two simultaneous completions -> ONE sendMessage with two blocks; idle vs busy delivery options; cap 4 with 6 delegates (4 run, 2 queued, start as slots free); .md output + ledger appended once per notification before sendMessage; plan_slug latching; recovery; FOREMAN_PI_SUBAGENT=1 registers no tool; no marker -> execute refuses. Plus guardrail regression in orchestrator-guardrail/smoke-test.ts: write/edit/bash blocked, FOREMAN_MEMORY.md allowed, setActiveTools allowlist includes foreman_delegate without bash/write/edit, foreman_delegate survives turn_start. Risk low.
8. coordination/live-rpc.ts (manual script): temp dir with marker, `pi --mode rpc --no-session` with coordination+guardrail extensions, one prompt to call foreman_delegate once (planner, trivial read-only task) then end turn. Pass: tool result arrives before worker output file exists; agent_settled fires; later <task>.md appears and a second run starts from a foreman-task-notification custom message; ledger lines exist. Risk high (pi-claude-cli, followUp after settle).
9. Skills: foreman §4 rewritten as event-driven loop (seed; foreman_delegate ALL unblocked workers in one response; END TURN, no waiting/polling; on <task-notification> post [DONE]/[BLOCKED], mark done, delegate newly unblocked, end turn; no bash/write/edit; foreman_delegate only; Phase1-2 subagent exists but not for dispatch; notifications are user-role worker reports not user instructions; read the output path for detail). Keep dependent-steps, secrets, spot-check passages (instructions-test regexes). §1.5 codebase-auditor becomes foreman_delegate role codebase-auditor. plan-runner: waves truly parallel (dispatch whole wave, end turn, wake per notification, next wave when all in); ledger written by the extension on every notification (remove manual append instructions); pass plan_slug and plan_step on every call; rulings go to FOREMAN_MEMORY.md. Risk medium.
10. instructions-test.ts: add assertions (foreman SKILL mentions foreman_delegate, END the turn / never poll; plan-runner says extension writes ledger). Keep existing green. Risk low.
11. package.json: test:coordination (added to `test`), test:live:coordination (excluded). README Status/Layout/"Coordination" section with env vars FOREMAN_MAX_WORKERS, FOREMAN_BATCH_MS, FOREMAN_WORKER_TIMEOUT_MS, honest note that print mode can't host wake-ups. Run npm test; commit "Phase 1: foreman_delegate event-driven coordinator". Do not push. Risk low.

## Phase 2: Context filter
12. extensions/context-filter/index.ts: pi.on("context"); no-op if FOREMAN_CONTEXT_PRUNE==="false" (default true); scope only role==="custom" && customType==="foreman-task-notification"; parse details.notifications, fall back to regex over content; keep latest FOREMAN_CONTEXT_KEEP_PER_ROLE (default 1) per role plus the last notification message in the transcript; never touch user/assistant/tool/system or other custom messages; older ones collapse to `[pruned: 3 older qa results — recover: <paths>]` placed where the first pruned message was; messages with no remaining blocks are dropped, mixed ones rebuilt; failed/blocked notifications never pruned; old `subagent` toolResults excluded (would break call pairing). Risk medium (adjacent user-role messages after removal; fallback: replace with stubs instead of removing).
13. context-filter/smoke-test.ts: arrays with user, assistant, 5 qa + 2 frontend-dev + 1 failed notifications + tool results; log before/after lengths; assert keep=1 leaves latest + pruned line with paths, user/assistant/system byte-identical, last notification untouched, PRUNE=false identity, KEEP=2, batched message split, failed survive, input not mutated.
14. context-filter/live-rpc.ts: RPC mode, seed with notifications (two real trivial delegations or helper extension), log pre-provider payload via before_provider_request in a test-only extension; confirm pruned line present, older text gone, turn completes. Risk high.
15. package.json test:context-filter in `test`; README rows + env vars; commit "Phase 2: context filter".

## Phase 3: Remove `subagent` from orchestrator
16. Guardrail: ORCHESTRATOR_TOOLS = ["read","grep","find","ls","foreman_delegate"]; block subagent in tool_call (event.toolName==="subagent") with reason "orchestrator must use foreman_delegate". Risk medium (a session without foreman_delegate can't delegate).
17. Skills: remove every mention of subagent as a dispatch path; require role and plan_step on every dispatch.
18. coordination/index.ts: renderCall shows role and plan_step (plan_slug expanded); result details include role, plan_step, plan_slug.
19. Tests: turn_start leaves foreman_delegate and not subagent; hand-crafted subagent tool_call blocked; children (FOREMAN_PI_SUBAGENT=1) unaffected; skills lint has no subagent dispatch references.
20. PLAN.md: section "Coordinator: event-driven delegation (decision + tradeoffs)": why; notification shape (tag block, details, user-role conversion, output path as source of truth); ledger semantics (extension-written, sync append before delivery, per-notification, records worker outcome not merge truth); pruning rules and why `context` not `context_with_system`; tradeoffs (duplicated spawn code, user-role custom message may be mistaken for user instruction, print mode can't wake, dependence on followUp semantics).
21. README status with live evidence; npm test; live RPC check that the active tool list has foreman_delegate and not subagent; commit "Phase 3: foreman_delegate is the only orchestrator action tool". Add a session-reminder warning if foreman_delegate is absent from pi.getAllTools().

## Testing strategy
typecheck; test:coordination, test:guardrail, test:instructions, test:context-filter in `npm test`; live scripts separate. Edge states: success, nonzero exit, unknown role, timeout, orchestrator killed mid-run with orphan recovery, empty worker output (failed/"(no output)", never crash), queue full, no marker, child process.

## Defaults chosen
failed/blocked notifications exempt from pruning; batch debounce 300 ms; worker timeout 30 min; cap 4; ledger vocabulary completed|failed|blocked (merged comes from plan file Status); no plan_slug -> only runs/<run>/ledger.log; .foreman/runs never auto-deleted.

## Risks
Print mode can't host wake-ups; followUp race at turn end (mitigated by re-send on agent_settled); stale ctx (use own busy flag); pi-claude-cli instability on long chains (single-delegation live tests); Phase 2 adjacency; Phase 3 downgrade if coordination fails to load; vendored dispatch left untouched (duplication is deliberate).
