/**
 * Orchestrator guardrail — Pi port of foreman's hooks/block-edit-during-orchestrator.sh
 *
 * While `.orchestrator-active` exists at the project root, this session is acting
 * as the foreman orchestrator: it must delegate Write/Edit/code-writing-Bash to a
 * worker instead of doing it directly (see the `foreman` skill). Its only action
 * tool is `foreman_delegate` (extensions/coordination/): the blocking `subagent`
 * tool is removed from the orchestrator's active set and denied in tool_call
 * (Phase 3 of docs/plans/foreman-pi-event-driven-coordinator.md).
 *
 * Two layers, same as the plan (PLAN.md, section 1):
 *  - Proactive: setActiveTools() restricts to read/grep/find/ls/foreman_delegate (no bash/write/edit/subagent) from this session's own active
 *    tool set on every turn while the marker is present, so the model is never
 *    even offered them.
 *  - Reactive: a tool_call handler still blocks write/edit/bash-that-writes as a
 *    backstop, in case active tools were restored mid-turn or bash is used to
 *    route around the missing tools.
 *
 * Workers are intended to need none of this: each one runs as its own `pi`
 * process (extensions/coordination/spawn-worker.ts, or subagent-dispatch for
 * non-orchestrator use), with its own tools from its
 * agent .md frontmatter. There is no agent_id-style distinction to make here,
 * unlike the Claude Code hook this replaces — parent and child are different
 * processes... EXCEPT that when foreman-pi is installed as a package (see
 * README.md's packaging section), Pi's default extension discovery loads
 * this extension into *every* `pi` invocation on the machine, including the
 * subagent-dispatch child processes themselves (they don't pass
 * --no-extensions, since they still need other installed extensions, e.g.
 * the model-fallback virtual model agents inherit by default). Without the
 * check below, a child sharing the orchestrator's cwd would see the same
 * `.orchestrator-active` marker and get wrongly restricted — confirmed live,
 * a frontend-dev subagent's `edit` tool vanished mid-task. subagent-dispatch
 * sets FOREMAN_PI_SUBAGENT=1 on every child it spawns specifically so this
 * extension can exempt them.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

const MARKER_NAME = ".orchestrator-active";

function markerPath(cwd: string): string {
	return join(cwd, MARKER_NAME);
}

function isOrchestratorActive(cwd: string): boolean {
	if (process.env.FOREMAN_PI_SUBAGENT === "1") return false;
	return existsSync(markerPath(cwd));
}

/**
 * Tools the orchestrator may have: read-only inspection plus delegation.
 * No bash (opaque, hard to audit), no write/edit (must delegate).
 */
const ORCHESTRATOR_TOOLS = ["read", "grep", "find", "ls", "foreman_delegate"];
/** Tools that are always blocked while orchestrating, even if re-enabled. */
const BLOCKED_TOOLS = ["bash", "write", "edit"];

export default function (pi: ExtensionAPI) {
	// Proactive layer: keep the active tool set in sync with the marker on
	// every turn. Cheap (one existsSync), and the model never sees write/edit
	// as available while orchestrating.
	pi.on("turn_start", async (_event, ctx) => {
		if (!isOrchestratorActive(ctx.cwd)) return;
		const active = pi.getActiveTools();
		const next = active.filter((t: string) => ORCHESTRATOR_TOOLS.includes(t));
		if (next.length !== active.length) pi.setActiveTools(next);
		// Deliberately do not auto-restore when the marker disappears: that is
		// the user's call (end orchestrator mode), not this guardrail's.
	});

	// Reactive layer: backstop for write/edit (e.g. active tools restored
	// mid-session) and the only layer that can cover bash, since bash is a
	// single opaque command string rather than a distinct tool.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!isOrchestratorActive(ctx.cwd)) {
			return undefined;
		}

		if (event.toolName === "subagent") {
			return {
				block: true,
				reason:
					`An orchestrator skill is active (${MARKER_NAME} present): \`subagent\` is not available to the ` +
					"orchestrator. Use foreman_delegate (role + handoff_prompt + plan_step), then end your turn.",
			};
		}

		if (isToolCallEventType("bash", event)) {
			return {
				block: true,
				reason:
					`An orchestrator skill is active (${MARKER_NAME} present): bash is not available to the ` +
					"orchestrator. Inspect with read/grep/find/ls and delegate any command with foreman_delegate.",
			};
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = event.input.path;
			if (path.endsWith("FOREMAN_MEMORY.md")) {
				return undefined;
			}
			return {
				block: true,
				reason: `An orchestrator skill is active (${MARKER_NAME} present) and must delegate "${event.toolName}" via foreman_delegate instead of editing files itself. Remove the marker (end orchestrator mode) or delegate this change.`,
			};
		}

		return undefined;
	});
}
