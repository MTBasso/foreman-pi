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
 *
 * Orientation pre-gathering (marker/memory/git/top-level listing) was added
 * after a live run (session 01a1c625) showed the model burning 7+ turns just
 * re-checking whether `.orchestrator-active` exists, never progressing past
 * foreman's own step 0/1 before `pi-claude-cli`'s `--resume` gave up with
 * "No response requested." — the exact multi-round-trip instability already
 * documented in this machine's CLAUDE.md for this provider. No amount of
 * SKILL.md wording fixes a provider-level round-trip reliability bug; the
 * only real mitigation is cutting the number of round trips the model needs
 * before it can act, by doing this cheap synchronous I/O here instead of
 * making the model spend its own tool calls discovering it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MARKER_NAME = ".orchestrator-active";
const MEMORY_NAME = "FOREMAN_MEMORY.md";

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
 * Everything foreman's own step 0 (marker/references) and step 1 (orient on
 * the project) would otherwise spend several bash/read tool calls gathering.
 * Doing it here means the model's first turn already has it and can skip
 * straight to acting or asking, instead of re-deriving it one round trip at
 * a time.
 */
function gatherOrientation(cwd: string): string {
	const lines: string[] = [];

	const markerExists = existsSync(join(cwd, MARKER_NAME));
	lines.push(`.orchestrator-active: ${markerExists ? "present (see note above)" : "absent"}`);

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

export default function (pi: ExtensionAPI) {
	let pendingReminder: string | null = null;

	pi.on("session_start", async (event, ctx) => {
		// "startup" and "new" both begin with zero memory of ever running
		// /foreman in this session — a marker found at that moment is almost
		// always stale. "resume"/"fork"/"reload" can still be a legitimate
		// mid-run continuation, so leave those alone (mirrors the bash hook's
		// startup|clear handling, adapted to Pi's session_start reasons).
		const isFreshSession = event.reason === "startup" || event.reason === "new";
		const stale = isFreshSession ? staleMarkerNote(ctx.cwd) : undefined;
		const orientation = isFreshSession ? gatherOrientation(ctx.cwd) : undefined;

		pendingReminder = BASE_REMINDER + (stale ?? "") + (orientation ? "\n\n" + orientation : "");
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
