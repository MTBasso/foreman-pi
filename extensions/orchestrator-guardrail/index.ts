/**
 * Orchestrator guardrail — Pi port of foreman's hooks/block-edit-during-orchestrator.sh
 *
 * While `.orchestrator-active` exists at the project root, this session is acting
 * as the foreman orchestrator: it must delegate Write/Edit/code-writing-Bash to a
 * subagent instead of doing it directly (see the `foreman` skill).
 *
 * Two layers, same as the plan (PLAN.md, section 1):
 *  - Proactive: setActiveTools() drops write/edit from this session's own active
 *    tool set on every turn while the marker is present, so the model is never
 *    even offered them.
 *  - Reactive: a tool_call handler still blocks write/edit/bash-that-writes as a
 *    backstop, in case active tools were restored mid-turn or bash is used to
 *    route around the missing tools.
 *
 * Subagents need none of this: each one runs as its own `pi` process (see
 * extensions/subagent-dispatch/), with its own tools from its agent .md
 * frontmatter. There is no agent_id-style distinction to make here, unlike the
 * Claude Code hook this replaces — parent and child are different processes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

const MARKER_NAME = ".orchestrator-active";
const ALLOWED_TARGET_SUBSTRINGS = [".foreman/", "FOREMAN_MEMORY.md"];

// Heuristic only — not a sandbox. Mirrors the bash version's `looks_like_write`.
// A command that trips this but is genuinely read-only/diagnostic is a false
// positive to fix by widening this list, not to work around (see PLAN.md §1
// and the original plugin's references/orchestrator-marker.md).
const WRITE_COMMAND_PATTERNS: RegExp[] = [
	/(^|[^0-9>&])>{1,2}[^&>]/, // redirection, excluding 2>&1 / &>2 style fd-dup forms
	/\bsed\b[^|;&]*-i\b/,
	/\bperl\b[^|;&]*-i\b/,
	/\btee\b/,
	/(^|[|;&] *)patch\b/,
	/\bdd\b[^|;&]*\bof=/,
];

// Redirecting a spot-check's output to a log file, or discarding it, is
// bookkeeping, not an implementation change. Deliberately narrow: `.txt` and
// `.out` were in this list until a live test caught `echo hacked > existing.txt`
// sailing through under the "spot-check output" exception — `.txt` in
// particular is a real content format (docs, data, config), not a safe
// signal that a redirect is log-only. Only `.log` and `/dev/null` are
// unambiguous enough to allowlist by extension alone.
const ALLOWED_BASH_TARGET_PATTERNS: RegExp[] = [/\/dev\/null/, /\.log(\s|$)/];

function markerPath(cwd: string): string {
	return join(cwd, MARKER_NAME);
}

function isOrchestratorActive(cwd: string): boolean {
	return existsSync(markerPath(cwd));
}

function looksLikeWriteCommand(command: string): boolean {
	return WRITE_COMMAND_PATTERNS.some((re) => re.test(command));
}

function isAllowedTarget(text: string): boolean {
	return (
		ALLOWED_TARGET_SUBSTRINGS.some((s) => text.includes(s)) ||
		ALLOWED_BASH_TARGET_PATTERNS.some((re) => re.test(text))
	);
}

/** Tools this session should not have while acting as the orchestrator. */
const RESTRICTED_TOOLS = ["write", "edit"];

export default function (pi: ExtensionAPI) {
	// Proactive layer: keep the active tool set in sync with the marker on
	// every turn. Cheap (one existsSync), and the model never sees write/edit
	// as available while orchestrating.
	pi.on("turn_start", async (_event, ctx) => {
		const active = pi.getActiveTools();
		const shouldRestrict = isOrchestratorActive(ctx.cwd);
		const hasRestricted = RESTRICTED_TOOLS.some((t) => active.includes(t));

		if (shouldRestrict && hasRestricted) {
			pi.setActiveTools(active.filter((t: string) => !RESTRICTED_TOOLS.includes(t)));
		}
		// Deliberately do not auto-restore here: restoring tools is the
		// orchestrator's/user's call (removing the marker), not something this
		// guardrail should do on its own just because it saw the marker gone
		// for one turn.
	});

	// Reactive layer: backstop for write/edit (e.g. active tools restored
	// mid-session) and the only layer that can cover bash, since bash is a
	// single opaque command string rather than a distinct tool.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!isOrchestratorActive(ctx.cwd)) {
			return undefined;
		}

		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			const path = event.input.path;
			if (path.endsWith("FOREMAN_MEMORY.md")) {
				return undefined;
			}
			return {
				block: true,
				reason: `An orchestrator skill is active (${MARKER_NAME} present) and must delegate "${event.toolName}" to a subagent instead of editing files itself. Remove the marker (end orchestrator mode) or delegate this change.`,
			};
		}

		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (looksLikeWriteCommand(command) && !isAllowedTarget(command)) {
				return {
					block: true,
					reason:
						"An orchestrator skill is active and this bash command looks like it writes to a file " +
						"(redirection/sed -i/tee/patch/dd). Delegate the change to a subagent instead of editing it " +
						"through the shell. If this command is actually read-only/diagnostic and the match is a " +
						"false positive, widen the pattern list in extensions/orchestrator-guardrail/index.ts " +
						"rather than finding another way around it.",
				};
			}
		}

		return undefined;
	});
}
