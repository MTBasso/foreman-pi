/**
 * Session reminder — Pi port of foreman's hooks/session-start.sh
 *
 * Claude Code's SessionStart hook fires once and can return `additionalContext`
 * straight into the model's context. Pi has no 1:1 equivalent: `session_start`
 * fires once but documents no return value, while `before_agent_start` can
 * inject a message but fires on every run, not just the first.
 *
 * So: detect what to say in `session_start` (reading `.orchestrator-active`'s
 * presence/age is cheap and synchronous), stash it in a closure flag, and
 * deliver + clear it on the next `before_agent_start`. This is the pattern
 * Pi's own extensions.md shows for a one-time reminder (the `addedReviewReminder`
 * example) — see PLAN.md §3 for the research trail.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER_NAME = ".orchestrator-active";

const BASE_REMINDER =
	"This project has the foreman plugin. For a new feature/bug that needs " +
	"grilling+planning+building+QA+release, use the foreman skill (/foreman). " +
	"For an already-approved plan under docs/plans/, use plan-runner " +
	"(/plan-runner <plan>). If a prior run went wrong (repeated work, ignored " +
	"plan, a stall, unexpected cost), use /foreman-diagnose. Don't mention this " +
	"reminder unless one of these is actually relevant.";

function staleMarkerNote(cwd: string): string | undefined {
	const marker = join(cwd, MARKER_NAME);
	if (!existsSync(marker)) return undefined;

	let ageNote = "";
	try {
		const ageMs = Date.now() - statSync(marker).mtimeMs;
		ageNote = ` (created ${Math.round(ageMs / 60000)}m ago)`;
	} catch {
		// Non-fatal: the age is a nice-to-have, not required for the warning.
	}

	return (
		` NOTE: a ${MARKER_NAME} marker already exists${ageNote}, but this is a ` +
		"brand-new session with no memory of starting foreman mode here — it is " +
		"very likely a leftover from a previous session that ended without " +
		"clearing it (crash, interrupt, or the user just closing the terminal). " +
		"The orchestrator-guardrail extension will restrict write/edit while that " +
		"file exists. Before doing any file edit, confirm with the user whether " +
		"foreman mode should actually still be active; if not, remove it."
	);
}

export default function (pi: ExtensionAPI) {
	let pendingReminder: string | null = null;

	pi.on("session_start", async (event, ctx) => {
		// "startup" and "new" both begin with zero memory of ever running
		// /foreman in this session — a marker found at that moment is almost
		// always stale. "resume"/"fork"/"reload" can still be a legitimate
		// mid-run continuation, so leave those alone (mirrors the bash hook's
		// startup|clear handling, adapted to Pi's session_start reasons).
		const stale =
			event.reason === "startup" || event.reason === "new" ? staleMarkerNote(ctx.cwd) : undefined;

		pendingReminder = BASE_REMINDER + (stale ?? "");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!pendingReminder) return undefined;
		if (event.messageType !== "user") return undefined; // only inject on the real first turn

		const message = pendingReminder;
		pendingReminder = null; // one-shot, same as the Claude Code hook (paid once per session)

		return {
			message: {
				customType: "foreman-session-reminder",
				content: message,
				display: false,
			},
		};
	});
}
