/**
 * Orchestrator guardrail — Pi port of foreman's hooks/block-edit-during-orchestrator.sh
 *
 * While orchestrator mode is on (see lib/mode.ts: session entry, `foreman:mode`
 * event, or FOREMAN_PI_MODE=orchestrator; entered with /foreman), this session
 * acts as the foreman: it must delegate Write/Edit/code-writing-Bash to a
 * worker instead of doing it directly (see the `foreman` skill). Its only
 * action tool is `foreman_delegate` (extensions/coordination/): the blocking
 * `subagent` tool is denied in tool_call.
 *
 * Two layers, same as the plan (PLAN.md, section 1):
 *  - Proactive: setActiveTools() restricts to read/grep/find/ls/foreman_delegate
 *    (no bash/write/edit/subagent) when the mode turns on and on every turn
 *    while it is on, so the model is never even offered them. The active list
 *    from before the first restriction is saved and restored when the mode
 *    turns off; with no saved list (e.g. after /reload) the current tools are
 *    unioned with the built-in defaults present in getAllTools().
 *  - Reactive: a tool_call handler still blocks write/edit/bash as a backstop,
 *    in case active tools were restored mid-turn or bash is used to route
 *    around the missing tools.
 *
 * Workers are never restricted. Each one is its own `pi` process; when
 * foreman-pi is installed as a package this extension is loaded into every
 * `pi` on the machine, including worker children, so FOREMAN_PI_SUBAGENT=1
 * (set by lib/spawn.ts on every worker) is checked first and always means
 * "inactive", whatever FOREMAN_PI_MODE or a session entry says.
 */
import { join, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { createModeTracker } from "../../lib/mode.ts";

/**
 * Tools the orchestrator may have: read-only inspection plus delegation.
 * No bash (opaque, hard to audit), no write/edit (must delegate).
 */
const ORCHESTRATOR_TOOLS = ["read", "grep", "find", "ls", "foreman_delegate"];
/** Tools that are always blocked while orchestrating, even if re-enabled. */
const BLOCKED_TOOLS = ["bash", "write", "edit"];
/** Pi's built-in default tool set, used when no saved list exists. */
const BUILTIN_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

function union(...lists: string[][]): string[] {
	return [...new Set(lists.flat())];
}

export default function (pi: ExtensionAPI) {
	const tracker = createModeTracker(pi);
	/** Active tools from before the first restriction (only set while restricted). */
	let saved: string[] | undefined;

	function restrict() {
		const active = pi.getActiveTools();
		if (saved === undefined && active.some((t: string) => BLOCKED_TOOLS.includes(t))) saved = [...active];
		const next = active.filter((t: string) => ORCHESTRATOR_TOOLS.includes(t));
		if (next.length !== active.length) pi.setActiveTools(next);
	}

	function restore() {
		const current = pi.getActiveTools();
		let target: string[];
		if (saved) {
			target = union(saved, current);
		} else {
			let known: Set<string>;
			try {
				known = new Set(pi.getAllTools().map((t: { name: string }) => t.name));
			} catch {
				known = new Set(BUILTIN_DEFAULT_TOOLS);
			}
			target = union(current, BUILTIN_DEFAULT_TOOLS.filter((t) => known.has(t)));
		}
		saved = undefined;
		if (target.length !== current.length) pi.setActiveTools(target);
	}

	tracker.onChange((active) => (active ? restrict() : restore()));

	pi.on("session_start", async (event, ctx) => {
		tracker.restore(ctx, event.reason);
		if (tracker.isActive()) {
			restrict();
			return;
		}
		if (event.reason !== "reload" || process.env.FOREMAN_PI_SUBAGENT === "1") return;
		// After /reload the in-memory saved list is gone. A leftover restriction
		// looks like: delegation present, none of bash/write/edit active.
		const active = pi.getActiveTools();
		if (active.includes("foreman_delegate") && !active.some((t: string) => BLOCKED_TOOLS.includes(t))) restore();
	});

	// Proactive layer: keep the active tool set restricted on every turn while on.
	pi.on("turn_start", async () => {
		if (tracker.isActive()) restrict();
	});

	// Reactive layer: backstop for write/edit (e.g. active tools restored
	// mid-session) and the only layer that can cover bash, since bash is a
	// single opaque command string rather than a distinct tool.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!tracker.isActive()) {
			return undefined;
		}

		if (event.toolName === "subagent") {
			return {
				block: true,
				reason:
					"Orchestrator mode is on: `subagent` is not available to the orchestrator. " +
					"Use foreman_delegate (role + handoff_prompt + plan_step), then end your turn.",
			};
		}

		if (isToolCallEventType("bash", event)) {
			return {
				block: true,
				reason:
					"Orchestrator mode is on: bash is not available to the orchestrator. " +
					"Inspect with read/grep/find/ls and delegate any command with foreman_delegate. " +
					"Use /foreman off to leave orchestrator mode.",
			};
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			// Exempt only the project-root FOREMAN_MEMORY.md, not that filename elsewhere.
			if (resolve(ctx.cwd, event.input.path) === join(ctx.cwd, "FOREMAN_MEMORY.md")) {
				return undefined;
			}
			return {
				block: true,
				reason: `Orchestrator mode is on; "${event.toolName}" must be delegated via foreman_delegate instead of editing files directly. Use /foreman off to leave orchestrator mode, or delegate this change.`,
			};
		}

		return undefined;
	});
}
