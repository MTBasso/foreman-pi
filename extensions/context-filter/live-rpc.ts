/**
 * Manual live check for the context filter (NOT part of `npm test`):
 *   npx tsx extensions/context-filter/live-rpc.ts
 *
 * Starts `pi --mode rpc --no-session` in a temp dir with an .orchestrator-active marker, plus a
 * test-only helper extension (-e) that logs the FINAL context (context_with_system runs after every
 * `context` handler) and the provider payload (before_provider_request) to a file. Then:
 *   prompt 1: one real foreman_delegate (planner, reads a.txt containing token ALPHA-111)  -> notification 1
 *   prompt 2: one real foreman_delegate (planner, reads b.txt containing token BETA-222)   -> notification 2
 *   prompt 3: plain "reply done" turn
 * and verifies that before the LLM call that follows notification 2 the older planner result is
 * pruned (collapsed `[pruned: ...]` line present, ALPHA-111 absent from every notification message),
 * the turn completes, and FOREMAN_CONTEXT_DEBUG before/after counts were logged (stderr).
 * Also reports whether adjacent user-role messages (custom messages convert to user) occur in the final
 * context and whether the provider accepted the turn.
 *
 * Relies on foreman-pi (coordination + guardrail + context-filter) being discoverable by pi, as in a real
 * session. Costs real tokens (3 orchestrator turns + 2 workers). Env: LIVE_TIMEOUT_MS (default 600000),
 * LIVE_PI, LIVE_KEEP=1 keeps the temp dir.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 600_000);
const dir = mkdtempSync(join(tmpdir(), "foreman-ctx-live-"));
writeFileSync(join(dir, ".orchestrator-active"), "");
writeFileSync(join(dir, "a.txt"), "ALPHA-111\n");
writeFileSync(join(dir, "b.txt"), "BETA-222\n");
const probeLog = join(dir, "probe.jsonl");
const helper = join(dir, "probe-extension.ts");
writeFileSync(
	helper,
	`import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(probeLog)};
const txt = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text ?? "").join("\\n") : "";
export default function (pi) {
	pi.on("context_with_system", (event) => {
		const ms = event.messages;
		appendFileSync(LOG, JSON.stringify({
			kind: "final-context",
			count: ms.length,
			roles: ms.map((m) => m.role === "custom" ? "custom:" + m.customType : m.role),
			notificationText: ms.filter((m) => m.customType === "foreman-task-notification").map((m) => txt(m.content)),
			alphaIn: ms.map((m, i) => (txt(m.content).includes("ALPHA-111") ? i + ":" + (m.role === "custom" ? "custom:" + m.customType : m.role) : null)).filter(Boolean),
			prunedLines: ms.filter((m) => m.customType === "foreman-context-pruned").map((m) => txt(m.content)),
		}) + "\\n");
	});
	pi.on("before_provider_request", (event) => {
		const s = JSON.stringify(event.payload ?? null);
		appendFileSync(LOG, JSON.stringify({ kind: "provider-payload", bytes: s.length, hasPruned: s.includes("[pruned:"), hasAlpha: s.includes("ALPHA-111"), hasBeta: s.includes("BETA-222") }) + "\\n");
	});
}
`,
);

const t0 = Date.now();
const note = (s: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);

const proc = spawn(process.env.LIVE_PI ?? "pi", ["--mode", "rpc", "--no-session", "-e", helper], {
	cwd: dir,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, FOREMAN_PI_SUBAGENT: undefined as unknown as string, FOREMAN_CONTEXT_DEBUG: "1", FOREMAN_CONTEXT_PRUNE: "true" },
});
let stderr = "";
proc.stderr.on("data", (d) => (stderr += d.toString()));

let notifications = 0;
let settledAfterNotif = 0;
let errors: string[] = [];
let assistantErrors = 0;
let buffer = "";
proc.stdout.on("data", (d) => {
	buffer += d.toString();
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const l of lines) {
		if (!l.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(l.replace(/\r$/, ""));
		} catch {
			continue;
		}
		if (ev.type === "agent_start") note("agent_start");
		else if (ev.type === "agent_end") note("agent_end");
		else if (ev.type === "tool_execution_start") note(`tool_execution_start ${ev.toolName}`);
		else if (ev.type === "message_start" && ev.message?.role === "custom") {
			note(`message_start custom:${ev.message.customType}`);
			if (ev.message.customType === "foreman-task-notification") notifications++;
		} else if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.stopReason === "error") {
			assistantErrors++;
			errors.push(String(ev.message.errorMessage ?? "assistant error"));
			note(`assistant error: ${ev.message.errorMessage}`);
		} else if (ev.type === "agent_settled") {
			note(`agent_settled aborted=${ev.aborted}`);
			if (notifications > settledAfterNotif) settledAfterNotif = notifications;
		} else if (ev.type === "response" && !ev.success) note(`response error: ${ev.error}`);
	}
});

const send = (id: string, message: string) => {
	proc.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
	note(`prompt ${id} sent`);
};
const waitFor = async (cond: () => boolean, label: string, ms: number) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		if (proc.exitCode !== null) return false;
		await new Promise((r) => setTimeout(r, 500));
	}
	note(`timeout waiting for ${label}`);
	return false;
};
const delegatePrompt = (file: string) =>
	"You are in orchestrator mode. Call the foreman_delegate tool EXACTLY ONCE with role \"planner\" and " +
	`handoff_prompt "Read ${file} and reply with its first line verbatim. Do not modify any files." plan_slug "ctx-live". ` +
	"Then END YOUR TURN immediately with a one-line acknowledgement. Do not wait, poll, or call any other tool. " +
	"When you later receive a <task-notification>, reply with one line and stop.";

const probe = () =>
	existsSync(probeLog)
		? readFileSync(probeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
		: [];
const settledIdle = async () => {
	await new Promise((r) => setTimeout(r, 4000)); // let a pending batch/wake start
};

async function main() {
	const per = TIMEOUT_MS / 3;
	send("p1", delegatePrompt("a.txt"));
	await waitFor(() => notifications >= 1 && settledAfterNotif >= 1, "notification 1 handled", per);
	await settledIdle();
	send("p2", delegatePrompt("b.txt"));
	await waitFor(() => notifications >= 2 && settledAfterNotif >= 2, "notification 2 handled", per);
	await settledIdle();
	send("p3", "Reply with the single word: done. Do not call any tools.");
	const before3 = settledAfterNotif;
	await new Promise((r) => setTimeout(r, 2000));
	await waitFor(() => !!probe().length && probe().filter((e) => e.kind === "final-context").length >= 5, "post-notification-2 LLM calls", per);
	await new Promise((r) => setTimeout(r, 8000));
	proc.stdin.end();
	await new Promise((r) => setTimeout(r, 3000));
	if (proc.exitCode === null) proc.kill("SIGTERM");

	const entries = probe();
	const ctxs = entries.filter((e) => e.kind === "final-context");
	console.log("\n--- final-context per LLM call (role sequence) ---");
	ctxs.forEach((c, i) => console.log(`#${i + 1} count=${c.count} ${c.roles.join(",")}${c.prunedLines.length ? `\n     pruned: ${c.prunedLines.join(" | ")}` : ""}`));
	console.log("--- provider payloads ---");
	entries.filter((e) => e.kind === "provider-payload").forEach((p) => console.log(JSON.stringify(p)));
	const debugLines = stderr.split("\n").filter((l) => l.includes("[foreman-context-filter]"));
	console.log("--- FOREMAN_CONTEXT_DEBUG stderr ---");
	debugLines.forEach((l) => console.log(l));
	if (stderr.trim() && !debugLines.length) console.log(`--- stderr (tail) ---\n${stderr.slice(-600)}`);

	const alphaInNotif = (c: any) => c.notificationText.some((t: string) => t.includes("ALPHA-111"));
	const firstAlpha = ctxs.findIndex(alphaInNotif);
	const afterN2 = ctxs.filter((c) => c.notificationText.some((t: string) => t.includes("BETA-222")));
	// Pairs of consecutive user-role-converted messages (user + any custom message become user in the LLM view).
	const adjacentPairs = (roles: string[]) => {
		const out: string[] = [];
		roles.forEach((r, i) => {
			const isU = (x?: string) => x === "user" || !!x?.startsWith("custom:");
			if (isU(r) && isU(roles[i + 1])) out.push(`${i}:${r} -> ${i + 1}:${roles[i + 1]}`);
		});
		return out;
	};
	const checks: Record<string, boolean> = {
		"notification 1 and 2 delivered": notifications >= 2,
		"older result was visible before notification 2 (ALPHA-111 seen in some context)": firstAlpha >= 0,
		"every context containing BETA-222 notification lacks ALPHA-111 in notifications": afterN2.length > 0 && afterN2.every((c) => !alphaInNotif(c)),
		"pruned line present in contexts after notification 2": afterN2.length > 0 && afterN2.every((c) => c.prunedLines.some((l: string) => l.includes("[pruned: 1 older planner results"))),
		"debug before/after counts logged, with pruned-or-rebuilt > 0 (stub replaces pruned msg, so after may equal before)": debugLines.some((l) => {
			const m = /pruned-or-rebuilt=(\d+)/.exec(l);
			return !!m && Number(m[1]) > 0;
		}),
		"no assistant/provider errors; turns completed": assistantErrors === 0 && settledAfterNotif >= 2,
	};
	console.log("\n--- adjacency report ---");
	afterN2.forEach((c, i) => {
		const pairs = adjacentPairs(c.roles);
		console.log(`post-N2 context #${i + 1}: adjacent user-role pairs: ${pairs.length ? pairs.join("; ") : "none"}; involving pruned stub: ${pairs.some((p) => p.includes("foreman-context-pruned"))}`);
		console.log(`   messages still containing ALPHA-111: ${c.alphaIn.join(", ") || "none"}`);
	});
	console.log(`provider accepted all turns: ${assistantErrors === 0}${errors.length ? ` (${errors.join("; ")})` : ""}`);
	console.log("\n--- checks ---");
	let pass = true;
	for (const [k, v] of Object.entries(checks)) {
		console.log(`${v ? "ok  " : "FAIL"} - ${k}`);
		if (!v) pass = false;
	}
	void before3;
	if (process.env.LIVE_KEEP === "1") console.log(`temp dir kept: ${dir}`);
	else rmSync(dir, { recursive: true, force: true });
	console.log(pass ? "\nLIVE PASS" : "\nLIVE FAIL");
	process.exit(pass ? 0 : 1);
}

main();
