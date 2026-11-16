/**
 * Behavioural test for spawnWorker, run with:
 *   npx tsx extensions/coordination/spawn-worker-test.ts
 *
 * Drives spawnWorker through its injected deps seam with a scripted fake
 * runPiJson (no `pi` process), the real package agents, and a fake sleep.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeWorkerPrompt, discoverAgents } from "../../lib/agents.ts";
import type { PiRunHandle, PiRunResult, RunPiJsonOptions } from "../../lib/spawn.ts";
import { MAX_INLINE_PROMPT_BYTES, spawnWorker } from "./spawn-worker.ts";
import type { SpawnRequest } from "./coordinator.ts";

let failures = 0;
const check = (n: string, ok: boolean) => {
	if (!ok) {
		failures++;
		console.log(`FAIL - ${n}`);
	}
};

// The seam must exist before anything runs, so a missing seam can never spawn a real `pi`.
if (spawnWorker.length < 2) {
	console.log("FAIL - spawnWorker has no deps parameter (seam missing)");
	process.exit(1);
}

// Environment: no herdr panes, no isolation unless a case asks for it.
for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "FOREMAN_MAX_RESUMES", "FOREMAN_WORKER_SKILLS"]) delete process.env[k];
process.env.FOREMAN_ISOLATE = "never";

const res = (o: Partial<PiRunResult> = {}): PiRunResult => ({ code: 0, signal: null, messages: [], stderr: "", ...o });
const worked = [{ role: "assistant", content: [{ type: "text", text: "did work" }] }];

interface Call {
	args: string[];
	opts: RunPiJsonOptions;
	systemPrompt: string;
}

/** Scripted fake: each call takes the next script entry (a result, or a handle factory). */
function fakeRun(script: Array<PiRunResult | ((c: Call) => PiRunHandle)>) {
	const calls: Call[] = [];
	const runPiJson = (args: string[], opts: RunPiJsonOptions): PiRunHandle => {
		const i = args.indexOf("--append-system-prompt");
		const call: Call = { args, opts, systemPrompt: i >= 0 ? readFileSync(args[i + 1], "utf-8") : "" };
		calls.push(call);
		const next = script[Math.min(calls.length - 1, script.length - 1)];
		if (typeof next === "function") return next(call);
		return { done: Promise.resolve(next), kill() {} };
	};
	return { calls, runPiJson };
}

const taskOf = (c: Call) => c.args[c.args.length - 1];
const sleeps: number[] = [];
const retry = { sleep: async (ms: number) => void sleeps.push(ms), baseMs: 7 };

function fakeGate(remaining = 0) {
	const noted: Array<{ text: string; backoffMs: number }> = [];
	return {
		noted,
		gate: {
			remainingMs: () => remaining,
			noteRateLimit(text: string, backoffMs: number) {
				noted.push({ text, backoffMs });
				return backoffMs;
			},
		} as any,
	};
}

const base = mkdtempSync(join(tmpdir(), "spawn-worker-test-"));
const runDir = join(base, "run");
const plain = join(base, "plain");
mkdirSync(plain, { recursive: true });
let n = 0;
const req = (o: Partial<SpawnRequest> = {}): SpawnRequest => ({ taskId: `t${++n}`, role: "reviewer" as any, prompt: "review the diff", cwd: plain, runDir, ...o });

const agentOf = (role: string) => discoverAgents(plain, "user").agents.find((a) => a.name === role)!;

try {
	// argv
	{
		const f = fakeRun([res()]);
		const h = spawnWorker(req(), { runPiJson: f.runPiJson, ...fakeGate(), retry });
		await h.done;
		const c = f.calls[0];
		const reviewer = agentOf("reviewer");
		const ti = c.args.indexOf("--tools");
		check("argv carries --tools from the agent frontmatter and --append-system-prompt with the contract", ti >= 0 && c.args[ti + 1] === reviewer.tools!.join(",") && c.args.includes("--append-system-prompt") && c.systemPrompt === composeWorkerPrompt(reviewer) && c.systemPrompt.includes("foreman-report"));
		check("argv is a json, no-session child with the Task last", c.args.slice(0, 4).join(" ") === "--mode json -p --no-session" && taskOf(c).startsWith("Task: "));
	}

	// Task + footer
	{
		const f = fakeRun([res()]);
		await spawnWorker(req({ prompt: "HANDOFF-BODY" }), { runPiJson: f.runPiJson, ...fakeGate(), retry }).done;
		const task = taskOf(f.calls[0]);
		check("Task arg is handoff plus footer naming the worker cwd", task.startsWith("Task: HANDOFF-BODY\n\n---\n") && task.includes(`Working directory: ${plain}`) && task.includes("User language:") && task.trimEnd().endsWith("Shared worker rules in your system prompt."));
		check("Task arg has no resume preamble on a first attempt", !/interrupted/.test(task));
	}

	// env
	{
		const f = fakeRun([res()]);
		await spawnWorker(req({ role: "reviewer" as any }), { runPiJson: f.runPiJson, ...fakeGate(), retry }).done;
		const env = f.calls[0].opts.env ?? {};
		check("env has FOREMAN_PI_SUBAGENT=1 and FOREMAN_PI_ROLE", env.FOREMAN_PI_SUBAGENT === "1" && env.FOREMAN_PI_ROLE === "reviewer");
		check("FOREMAN_WORKTREE only when isolated (absent here)", !("FOREMAN_WORKTREE" in env));
	}

	// Isolation on a real temp git repo
	{
		const repo = join(base, "repo");
		mkdirSync(repo, { recursive: true });
		const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
		g("init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "a\n");
		g("add", "-A");
		g("commit", "-q", "-m", "init");
		const repoReal = realpathSync(repo);

		process.env.FOREMAN_ISOLATE = "always";
		const f = fakeRun([res()]);
		const h = spawnWorker(req({ role: "plan-step-builder" as any, cwd: repoReal }), { runPiJson: f.runPiJson, ...fakeGate(), retry });
		await h.done;
		const c = f.calls[0];
		check("FOREMAN_WORKTREE only when isolated", c.opts.env?.FOREMAN_WORKTREE === "1" && c.opts.cwd !== repoReal && c.opts.cwd.includes(join(".foreman", "worktrees")) && taskOf(c).includes(`Working directory: ${c.opts.cwd}`));

		// Kill reaches the running attempt and releases the writer slot.
		process.env.FOREMAN_ISOLATE = "auto";
		let killed = 0;
		let release!: (r: PiRunResult) => void;
		const pending = new Promise<PiRunResult>((r) => (release = r));
		const first = fakeRun([() => ({ done: pending, kill: () => { killed++; release(res({ code: null, signal: "SIGTERM" })); } })]);
		const h1 = spawnWorker(req({ role: "plan-step-builder" as any, cwd: repoReal }), { runPiJson: first.runPiJson, ...fakeGate(), retry });
		const second = fakeRun([res()]);
		await spawnWorker(req({ role: "plan-step-builder" as any, cwd: repoReal }), { runPiJson: second.runPiJson, ...fakeGate(), retry }).done;
		check("a second writer while one runs is isolated (slot held)", second.calls[0].opts.env?.FOREMAN_WORKTREE === "1");
		h1.kill();
		await h1.done;
		const third = fakeRun([res()]);
		await spawnWorker(req({ role: "plan-step-builder" as any, cwd: repoReal }), { runPiJson: third.runPiJson, ...fakeGate(), retry }).done;
		check("kill reaches the running attempt and releases the writer slot", killed === 1 && third.calls[0].opts.env?.FOREMAN_WORKTREE === undefined);
		process.env.FOREMAN_ISOLATE = "never";
	}

	// Resume wiring, role-aware
	for (const [role, re, notRe] of [
		["reviewer", /start again from the handoff/, /commit/i],
		["plan-step-builder", /commit only your own paths/, undefined],
	] as const) {
		const f = fakeRun([res({ code: 1, errorMessage: "503 overloaded", messages: worked }), res()]);
		await spawnWorker(req({ role: role as any, prompt: "ORIGINAL" }), { runPiJson: f.runPiJson, ...fakeGate(), retry }).done;
		const second = f.calls[1] ? taskOf(f.calls[1]) : "";
		const ok = f.calls.length === 2 && second.startsWith("Task: Your previous run was interrupted") && /resume 1/.test(second) && second.includes("ORIGINAL") && re.test(second.split("ORIGINAL")[0]) && (!notRe || !notRe.test(second.split("ORIGINAL")[0]));
		check(`transient failure after output resumes with the role-aware preamble first (${role})`, ok);
	}

	// No output: original Task, no preamble
	{
		const f = fakeRun([res({ code: 1, errorMessage: "503 overloaded" }), res()]);
		await spawnWorker(req(), { runPiJson: f.runPiJson, ...fakeGate(), retry }).done;
		check("transient failure with no output re-runs the original Task without preamble", f.calls.length === 2 && taskOf(f.calls[0]) === taskOf(f.calls[1]) && !/interrupted/.test(taskOf(f.calls[1])));
	}

	// Rate limit -> gate
	{
		sleeps.length = 0;
		const { gate, noted } = fakeGate(50);
		const f = fakeRun([res({ code: 1, errorMessage: "429 rate_limit_error" }), res()]);
		await spawnWorker(req(), { runPiJson: f.runPiJson, gate, retry }).done;
		check("rate limit calls gate.noteRateLimit with the back-off", noted.length === 1 && /429/.test(noted[0].text) && noted[0].backoffMs === 7 && sleeps[0] === 50);
		const f2 = fakeRun([res({ code: 1, errorMessage: "503 server error", stderr: "boom" }), res()]);
		const g2 = fakeGate();
		await spawnWorker(req(), { runPiJson: f2.runPiJson, gate: g2.gate, retry }).done;
		check("a non-rate-limit transient failure does not touch the gate", g2.noted.length === 0);
	}

	// onAttempt / onEvent
	{
		const attempts: number[] = [];
		const onEvent = () => {};
		const f = fakeRun([res({ code: 1, errorMessage: "503", messages: worked }), res({ code: 1, errorMessage: "503" }), res()]);
		await spawnWorker(req({ onAttempt: (a) => attempts.push(a), onEvent }), { runPiJson: f.runPiJson, ...fakeGate(), retry }).done;
		check("onAttempt fires for attempts >= 1 and onEvent is forwarded", attempts.join() === "1,2" && f.calls.every((c) => c.opts.onEvent === onEvent));
	}

	// Unknown role
	{
		const f = fakeRun([res()]);
		const h = spawnWorker(req({ role: "nope" as any }), { runPiJson: f.runPiJson, ...fakeGate(), retry });
		const r = await h.done;
		check("unknown role returns a spawnError handle", /Unknown agent: "nope"/.test(r.spawnError ?? "") && f.calls.length === 0);
	}

	// Oversized handoff
	{
		const f = fakeRun([res()]);
		const big = "x".repeat(MAX_INLINE_PROMPT_BYTES + 10);
		const r = req({ prompt: big });
		await spawnWorker(r, { runPiJson: f.runPiJson, ...fakeGate(), retry }).done;
		const task = taskOf(f.calls[0]);
		check("oversized handoff becomes a pointer and still gets the footer", task.includes(`${r.taskId}.prompt.md`) && !task.includes("xxxxxxxxxx") && existsSync(join(runDir, `${r.taskId}.prompt.md`)) && task.includes("Working directory:"));
	}
} finally {
	rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "All spawn-worker checks passed." : `${failures} spawn-worker check(s) FAILED.`);
if (failures) process.exit(1);
