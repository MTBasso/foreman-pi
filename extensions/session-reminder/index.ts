/**
 * Session reminder — Pi port of foreman's hooks/session-start.sh
 *
 * Claude Code's SessionStart hook fires once and can return `additionalContext`
 * straight into the model's context. Pi has no 1:1 equivalent: `session_start`
 * fires once but documents no return value, while `before_agent_start` can
 * inject a message but fires on every run, not just the first.
 *
 * So: detect what to say in `session_start`, stash it in a closure flag, and
 * deliver + clear it on the next `before_agent_start`. This is the pattern
 * Pi's own extensions.md shows for a one-time reminder (the `addedReviewReminder`
 * example) — see PLAN.md §3 for the research trail.
 *
 * Orientation pre-gathering (memory file/git/top-level listing) exists because
 * a live run showed the model burning 7+ turns just re-checking basic project
 * state before `pi-claude-cli`'s `--resume` gave up with "No response
 * requested." — the multi-round-trip instability already documented in this
 * machine's CLAUDE.md for this provider. The only real mitigation is cutting
 * the number of round trips the model needs before it can act, by doing this
 * cheap synchronous I/O here instead of making the model discover it.
 *
 * Orchestrator mode (lib/mode.ts) is session state, so a fresh `startup`/`new`
 * session is never locked by a leftover. The reminder states the mode (read at
 * `before_agent_start`, so extension load order does not matter). On `resume`
 * or `fork` into a session whose restored state is "active", the user is asked
 * to keep it; a timeout or no UI keeps the restored state (nothing destructive
 * happens by default).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { t } from "../../lib/i18n.ts";
import { createModeTracker, MODE_SET_EVENT } from "../../lib/mode.ts";

/** How long the resume/fork "keep orchestrator mode?" prompt waits before keeping the restored state. */
const DEFAULT_KEEP_MODE_TIMEOUT_MS = 30_000;

function keepModeTimeoutMs(): number {
	const n = Number(process.env.FOREMAN_KEEP_MODE_TIMEOUT_MS);
	return process.env.FOREMAN_KEEP_MODE_TIMEOUT_MS && Number.isFinite(n) && n > 0 ? n : DEFAULT_KEEP_MODE_TIMEOUT_MS;
}
const MEMORY_NAME = "FOREMAN_MEMORY.md";

const BASE_REMINDER =
	"This project has the foreman plugin. For a new feature/bug that needs " +
	"grilling+planning+building+QA+release, use the foreman skill (/foreman). " +
	"For an already-approved plan under docs/plans/, use plan-runner " +
	"(/plan-runner <plan>). If a prior run went wrong (repeated work, ignored " +
	"plan, a stall, unexpected cost), use /foreman-diagnose. Orchestrator mode " +
	"is entered with /foreman (or /plan-runner, /foreman-audit) and left with " +
	"/foreman off. Converse with the user in the language of their messages " +
	"(default English). Don't mention this reminder unless one of these is " +
	"actually relevant.";

function runGit(cwd: string, args: string[]): string | undefined {
	try {
		return execSync(`git ${args.join(" ")}`, {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined; // not a git repo, git missing, or the command errored — non-fatal
	}
}

/**
 * Everything foreman's own step 0 (references) and step 1 (orient on
 * the project) would otherwise spend several bash/read tool calls gathering.
 * Doing it here means the model's first turn already has it and can skip
 * straight to acting or asking, instead of re-deriving it one round trip at
 * a time.
 */
function gatherOrientation(cwd: string): string {
	const lines: string[] = [];

	const memoryPath = join(cwd, MEMORY_NAME);
	if (existsSync(memoryPath)) {
		try {
			const head = readFileSync(memoryPath, "utf-8").split("\n").slice(0, 15).join("\n");
			lines.push(`${MEMORY_NAME} (first 15 lines):\n${head}`);
		} catch {
			lines.push(`${MEMORY_NAME}: exists but could not be read`);
		}
	} else {
		lines.push(`${MEMORY_NAME}: does not exist yet`);
	}

	const branch = runGit(cwd, ["branch", "--show-current"]);
	const status = runGit(cwd, ["status", "--short", "-b"]);
	const log = runGit(cwd, ["log", "--oneline", "-5"]);
	if (branch !== undefined || status !== undefined) {
		lines.push(
			`git: branch=${branch ?? "?"}` +
				(status ? `\nstatus --short -b:\n${status}` : "") +
				(log ? `\nlog --oneline -5:\n${log}` : ""),
		);
	} else {
		lines.push("git: not a git repository (or git unavailable)");
	}

	try {
		const entries = readdirSync(cwd, { withFileTypes: true })
			.map((d) => d.name + (d.isDirectory() ? "/" : ""))
			.sort();
		lines.push(`top-level entries: ${entries.join(", ")}`);
	} catch {
		lines.push("top-level entries: could not list directory");
	}

	return (
		" PRE-GATHERED ORIENTATION (do not re-run ls/cat/git for any of this — " +
		"it was already collected for you; only fetch more if you need detail " +
		"beyond what's here):\n" +
		lines.join("\n\n")
	);
}

/**
 * One-line warning when the orchestrator's only action tool is missing
 * (e.g. the coordination extension failed to load): without foreman_delegate
 * a foreman session cannot delegate at all. Exported for tests.
 */
export function missingDelegateWarning(getAllTools: () => { name: string }[]): string {
	try {
		if (getAllTools().some((t) => t.name === "foreman_delegate")) return "";
	} catch {
		return ""; // tool list unavailable: stay silent rather than guess
	}
	return " WARNING: the foreman_delegate tool is not loaded in this session, so you cannot delegate; tell the user the coordination extension failed to load.";
}

export default function (pi: ExtensionAPI) {
	const tracker = createModeTracker(pi);
	let pendingReminder: string | null = null;

	/** One orientation line; computed at before_agent_start so extension load order does not matter. */
	function modeLine(): string {
		const { active, source } = tracker.describe();
		return `Orchestrator mode: ${active ? "active" : "inactive"} (${source})` +
			(active ? "" : "; foreman_delegate refuses until the user runs /foreman");
	}

	/** Resume/fork into an active session: ask whether to keep the mode. Timeout or no UI keeps it. */
	async function confirmKeepMode(ctx: any) {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, keepModeTimeoutMs());
		let keep = true;
		try {
			keep = await ctx.ui.confirm(t("confirm.keepMode.title"), t("confirm.keepMode"), { signal: controller.signal });
		} catch {
			keep = true; // prompt unavailable: keep the restored state
		} finally {
			clearTimeout(timer);
		}
		// foreman-mode is the single writer; ask it to turn the mode off.
		if (!keep && !timedOut) pi.events.emit(MODE_SET_EVENT, { active: false });
	}

	pi.on("session_start", async (event, ctx) => {
		tracker.restore(ctx, event.reason);

		// A fresh session has no memory of ever running /foreman, and gets the
		// full orientation. resume/fork/reload can be a mid-run continuation.
		const isFreshSession = event.reason === "startup" || event.reason === "new";
		const orientation = isFreshSession ? gatherOrientation(ctx.cwd) : undefined;
		pendingReminder = BASE_REMINDER + missingDelegateWarning(() => pi.getAllTools()) + (orientation ? "\n\n" + orientation : "");

		const src = tracker.source();
		if ((event.reason === "resume" || event.reason === "fork") && tracker.isActive() && (src === "entry" || src === "event") && ctx.hasUI) {
			await confirmKeepMode(ctx);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!pendingReminder) return undefined;
		if (event.messageType !== "user") return undefined; // only inject on the real first turn

		const message = pendingReminder + "\n\n" + modeLine();
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
