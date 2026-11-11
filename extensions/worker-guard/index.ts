/**
 * Worker guard: path-scoped write policy for foreman workers.
 *
 * Active only inside a worker child `pi` (FOREMAN_PI_SUBAGENT=1) that has a
 * role (FOREMAN_PI_ROLE, set by lib/spawn.ts `workerEnv`). In every other `pi`
 * process, including the orchestrator session, it does nothing; the
 * orchestrator-guardrail extension covers that side. An unknown role fails
 * closed to read-only. The policy lives in policy.ts (pure, unit-tested).
 *
 * Heuristic, not a sandbox: see references/worker-guard.md for the limits.
 */
import { isToolCallEventType, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { checkBash, checkWrite, workerGuardActive, type Verdict } from "./policy.ts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!workerGuardActive(process.env)) return undefined;
		const role = process.env.FOREMAN_PI_ROLE?.trim();
		let verdict: Verdict;
		try {
			if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				verdict = checkWrite(role, ctx.cwd, event.input.path);
			} else if (isToolCallEventType("bash", event)) {
				verdict = checkBash(role, ctx.cwd, event.input.command);
			} else {
				return undefined;
			}
		} catch (e) {
			return {
				block: true,
				reason: `Blocked by the foreman worker guard: the policy check failed (${e instanceof Error ? e.message : String(e)}). Do not retry it; end your foreman-report with "Status: blocked" naming this reason.`,
			};
		}
		return verdict.block ? { block: true, reason: verdict.reason } : undefined;
	});
}
