/**
 * Manual live check for the coordinator (NOT part of `npm test`):
 *   npx tsx extensions/coordination/live-rpc.ts
 *
 * Starts `pi --mode rpc --no-session` in a temp dir that contains an
 * .orchestrator-active marker, asks it to call foreman_delegate ONCE (planner,
 * trivial read-only task) and end its turn. Then verifies the event-driven loop:
 *   1. the foreman_delegate tool result arrives BEFORE the worker output file exists
 *   2. agent_settled fires (orchestrator idle, worker still running)
 *   3. later <task_id>.md appears
 *   4. the worker result reaches the orchestrator as a foreman-task-notification custom message.
 *      Two valid paths, reported separately: "idle-wake" (a new run starts from the message after the
 *      orchestrator settled) or "mid-run" (worker finished while the orchestrator was still in its
 *      turn, so it was delivered as a followUp). LIVE_SLOW=1 makes the worker slower to favor idle-wake.
 *   5. ledger lines exist (runs/<run>/ledger.log)
 *
 * Relies on the foreman-pi package (coordination + guardrail extensions) being
 * discoverable by pi (installed package or settings), same as a real session.
 * Costs real model tokens (orchestrator turn x2 + one worker). Flaky by nature
 * (pi-claude-cli); the event log printed at the end is the evidence.
 *
 * Env: LIVE_TIMEOUT_MS (default 300000), LIVE_PI (pi binary, default "pi"),
 *      LIVE_KEEP=1 keeps the temp dir.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 300_000);
const dir = mkdtempSync(join(tmpdir(), "foreman-live-"));
writeFileSync(join(dir, ".orchestrator-active"), "");
writeFileSync(join(dir, "hello.txt"), "foreman live test file\n");

const t0 = Date.now();
const log: string[] = [];
const note = (s: string) => {
	const line = `+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`;
	log.push(line);
	console.log(line);
};

const findOutputs = () => {
	const runsDir = join(dir, ".foreman", "runs");
	if (!existsSync(runsDir)) return { md: [] as string[], ledger: "" };
	const md: string[] = [];
	let ledger = "";
	for (const run of readdirSync(runsDir)) {
		for (const f of readdirSync(join(runsDir, run))) {
			if (f.endsWith(".md") && !f.endsWith(".prompt.md")) md.push(join(runsDir, run, f));
			if (f === "ledger.log") ledger += readFileSync(join(runsDir, run, f), "utf8");
		}
	}
	return { md, ledger };
};

const checks: Record<string, boolean> = {
	"tool result arrived before worker output existed": false,
	"agent_settled fired after the delegate call": false,
	"worker output .md appeared": false,
	"worker result delivered as foreman-task-notification": false,
	"ledger lines exist": false,
};

const proc = spawn(process.env.LIVE_PI ?? "pi", ["--mode", "rpc", "--no-session"], {
	cwd: dir,
	stdio: ["pipe", "pipe", "pipe"],
	// If this script is itself run from inside a foreman worker, the flag would
	// turn coordination/guardrail into no-ops for the orchestrator under test.
	env: { ...process.env, FOREMAN_PI_SUBAGENT: undefined as unknown as string },
});
let stderr = "";
proc.stderr.on("data", (d) => (stderr += d.toString()));

let buffer = "";
let delegateEnded = false;
let settledAfterDelegate = false;
let notificationSeen = false;
let agentStartsAfterNotification = 0;
let secondRunStarted = false;
let currentlyRunning = false;
let deliveryPath = "none";
let delegateCalls = 0;
let finalSettled = false;

function handle(ev: any) {
	switch (ev.type) {
		case "agent_start":
			note("agent_start");
			currentlyRunning = true;
			if (notificationSeen) {
				secondRunStarted = true;
				agentStartsAfterNotification++;
			}
			break;
		case "agent_end":
			note("agent_end");
			currentlyRunning = false;
			break;
		case "agent_settled":
			note(`agent_settled aborted=${ev.aborted}`);
			if (delegateEnded) settledAfterDelegate = true;
			if (notificationSeen) finalSettled = true;
			break;
		case "tool_execution_start":
			note(`tool_execution_start ${ev.toolName}`);
			if (ev.toolName === "foreman_delegate") delegateCalls++;
			break;
		case "tool_execution_end":
			note(`tool_execution_end ${ev.toolName} isError=${ev.isError}`);
			if (ev.toolName === "foreman_delegate" && !ev.isError) {
				delegateEnded = true;
				checks["tool result arrived before worker output existed"] = findOutputs().md.length === 0;
			}
			break;
		case "message_start":
			if (ev.message?.role === "custom") {
				note(`message_start custom:${ev.message.customType}`);
				if (ev.message.customType === "foreman-task-notification") {
					notificationSeen = true;
					deliveryPath = settledAfterDelegate ? "idle-wake" : "mid-run";
				}
			}
			break;
		case "response":
			if (!ev.success) note(`response error: ${ev.error}`);
			break;
	}
}

proc.stdout.on("data", (d) => {
	buffer += d.toString();
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const l of lines) {
		if (!l.trim()) continue;
		try {
			handle(JSON.parse(l.replace(/\r$/, "")));
		} catch {
			// non-JSON noise
		}
	}
});

const prompt =
	"You are in orchestrator mode. Call the foreman_delegate tool EXACTLY ONCE with role \"planner\" and " +
	"handoff_prompt \"Read hello.txt and reply with its first line verbatim. Do not modify any files.\" " +
	"plan_slug \"live-test\", plan_step 1. Then END YOUR TURN immediately with a one-line acknowledgement. " +
	(process.env.LIVE_SLOW === "1" ? "The handoff must also tell the worker to first read hello.txt five separate times with five separate read calls. " : "") +
	"Do not wait, poll, or call any other tool. When you later receive a <task-notification>, reply with one line and stop.";
proc.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: prompt })}\n`);
note("prompt sent");

async function main() {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 500));
		const { md, ledger } = findOutputs();
		if (md.length > 0) checks["worker output .md appeared"] = true;
		if (ledger.trim()) checks["ledger lines exist"] = true;
		checks["agent_settled fired after the delegate call"] = settledAfterDelegate;
		checks["worker result delivered as foreman-task-notification"] = notificationSeen;
		if (finalSettled && checks["ledger lines exist"]) break;
		if (proc.exitCode !== null) {
			note(`pi exited early code=${proc.exitCode}`);
			break;
		}
	}
	proc.stdin.end();
	await new Promise((r) => setTimeout(r, 3000));
	if (proc.exitCode === null) proc.kill("SIGTERM");

	const { md, ledger } = findOutputs();
	console.log("\n--- event order ---");
	for (const l of log) console.log(l);
	console.log(`\nforeman_delegate calls: ${delegateCalls}; notification delivery path: ${deliveryPath}; orchestrator still running at end: ${currentlyRunning}`);
	console.log("--- outputs ---");
	for (const f of md) console.log(`${f}:\n${readFileSync(f, "utf8").slice(0, 400)}`);
	console.log("--- ledger ---");
	console.log(ledger || "(none)");
	if (stderr.trim()) console.log(`--- stderr (tail) ---\n${stderr.slice(-800)}`);
	console.log("\n--- checks ---");
	let pass = true;
	for (const [k, v] of Object.entries(checks)) {
		console.log(`${v ? "ok " : "FAIL"} - ${k}`);
		if (!v) pass = false;
	}
	if (process.env.LIVE_KEEP === "1") console.log(`temp dir kept: ${dir}`);
	else rmSync(dir, { recursive: true, force: true });
	console.log(pass ? "\nLIVE PASS" : "\nLIVE FAIL");
	process.exit(pass ? 0 : 1);
}

main();
