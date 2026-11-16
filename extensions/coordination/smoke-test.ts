/**
 * Smoke test for extensions/coordination, run with:
 *   npx tsx extensions/coordination/smoke-test.ts
 *
 * Drives createCoordinator with a fake spawner (no real `pi` processes) and a
 * fake ExtensionAPI for the wiring in index.ts. See live-rpc.ts for the real
 * end-to-end check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdr } from "../../lib/herdr.ts";
import { createBackoffGate, type BackoffGate } from "../../lib/backoff.ts";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT, composeWorkerPrompt, discoverAgents } from "../../lib/agents.ts";
import { t } from "../../lib/i18n.ts";
import { MODE_EVENT } from "../../lib/mode.ts";
import { ROLES as SHARED_ROLES } from "../../lib/roles.ts";
import { GLYPHS, WORKERS_ABORT_EVENT, WORKERS_EVENT, createHealthWatcher, renderReport, renderStuckNotice, renderWorkersUi, type WorkersSnapshot } from "../../lib/workers.ts";
import extension, { buildDetails, callText, delegateResultText, registerCoordination } from "./index.ts";
import {
	createCoordinator,
	finalReport,
	formatBlock,
	NOTIFICATION_CUSTOM_TYPE,
	parseFinalBlock,
	type SendOptions,
	type SpawnRequest,
	type WorkerResult,
} from "./coordinator.ts";

let failures = 0;
const check = (label: string, cond: boolean, _detail?: string) => {
	console.log(`${cond ? "ok " : "FAIL"} - ${label}`);
	if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	...extra,
});
const ok = (text: string): WorkerResult => ({ code: 0, signal: null, messages: [assistant(text)], stderr: "" });

interface Sent {
	message: { customType: string; content: string; display: boolean; details: any };
	options: SendOptions;
	ledgerLinesAtSend: number;
}

function harness(opts: { maxWorkers?: number; timeoutMs?: number; active?: boolean; root?: string; resolveWorkdir?: (root: string, requested: string) => string; maxWriters?: number; gate?: BackoffGate; now?: () => number; verify?: (o: any) => any } = {}) {
	const root = opts.root ?? mkdtempSync(join(tmpdir(), "foreman-coord-"));
	const workers = new Map<string, { req: SpawnRequest; resolve: (r: WorkerResult) => void; killed: boolean }>();
	const spawned: string[] = [];
	const sent: Sent[] = [];
	const entries: any[] = [];
	let active = opts.active ?? true;
	const coord = createCoordinator({
		root,
		maxWorkers: opts.maxWorkers ?? 4,
		batchMs: 20,
		timeoutMs: opts.timeoutMs ?? 0,
		isOrchestratorActive: () => active,
		resolveWorkdir: opts.resolveWorkdir,
		maxWriters: opts.maxWriters,
		gate: opts.gate,
		...(opts.verify ? { verify: opts.verify } : {}),
		...(opts.now ? { now: opts.now } : {}),
		spawn(req) {
			spawned.push(req.taskId);
			let resolve!: (r: WorkerResult) => void;
			const done = new Promise<WorkerResult>((res) => (resolve = res));
			const w = { req, resolve, killed: false };
			workers.set(req.taskId, w);
			return {
				done,
				kill() {
					w.killed = true;
					resolve({ code: null, signal: "SIGTERM", messages: [], stderr: "killed" });
				},
			};
		},
		sendMessage(message, options) {
			const ledger = join(root, ".foreman", "runs", coord.runId, "ledger.log");
			const lines = existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).length : 0;
			sent.push({ message: message as any, options, ledgerLinesAtSend: lines });
		},
		appendEntry: (t, d) => entries.push({ customType: t, data: d }),
	});
	return {
		root,
		coord,
		workers,
		spawned,
		sent,
		entries,
		setActive: (a: boolean) => (active = a),
		finish: (id: string, r: WorkerResult) => workers.get(id)!.resolve(r),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

async function main() {
	const savedSubagentEnv = process.env.FOREMAN_PI_SUBAGENT;
	const savedModeEnv = process.env.FOREMAN_PI_MODE;
	delete process.env.FOREMAN_PI_SUBAGENT;
	delete process.env.FOREMAN_PI_MODE;
	// 1. delegate returns synchronously with an ack, before the worker finishes.
	{
		const h = harness();
		const ack = h.coord.delegate({ role: "planner", handoff_prompt: "plan it", plan_step: 2, plan_slug: "my-plan" });
		check("delegate returns task_id synchronously", ack.task_id === "t1-planner");
		check("ack state running", ack.state === "running");
		check("ack tells orchestrator to end turn", /END YOUR TURN/.test(ack.ack));
		check("no notification before worker finishes", h.sent.length === 0);
		const meta = JSON.parse(readFileSync(join(h.root, ".foreman/runs", ack.run_id, "t1-planner.json"), "utf8"));
		check("meta json written before spawn completes", meta.role === "planner" && meta.plan_step === 2 && meta.state === "running");
		check("dispatch persisted via appendEntry", h.entries.some((e) => e.customType === "foreman-task" && e.data.taskId === "t1-planner"));

		// 2. completion -> one notification with the right fields.
		h.finish("t1-planner", ok("Plan written to docs/plans/x.md\nmore detail"));
		await h.coord.whenIdle();
		check("exactly one sendMessage", h.sent.length === 1);
		const s = h.sent[0];
		check("customType + display", s.message.customType === NOTIFICATION_CUSTOM_TYPE && s.message.display === true);
		check("block fields", /<task-notification>\ntask-id: t1-planner\nrole: planner\nstatus: completed\nplan-step: 2\nsummary: Plan written/.test(s.message.content));
		check("block has output path", s.message.content.includes(`output: .foreman/runs/${ack.run_id}/t1-planner.md`));
		check("details.notifications present", s.message.details.notifications?.length === 1 && !!s.message.details.batchId);
		const out = join(h.root, ".foreman/runs", ack.run_id, "t1-planner.md");
		check("full output written to .md", existsSync(out) && readFileSync(out, "utf8").includes("more detail"));
		const ledger = readFileSync(join(h.root, ".foreman/runs", ack.run_id, "ledger.log"), "utf8");
		check("ledger.log line format", /^\S+ — step 2 completed — planner — Plan written.* — \.foreman\/runs\/.+\/t1-planner\.md\n$/.test(ledger));
		check("ledger appended before sendMessage", s.ledgerLinesAtSend === 1);
		const progress = join(h.root, ".foreman/plan-runner/my-plan/progress.md");
		check("progress.md written for plan_slug", existsSync(progress) && readFileSync(progress, "utf8") === ledger);
		check("completion persisted", h.entries.some((e) => e.data.taskId === "t1-planner" && e.data.state === "completed"));
		h.cleanup();
	}

	// 3. status mapping.
	{
		const h = harness({ timeoutMs: 80 });
		const mk = (role: string) => h.coord.delegate({ role, handoff_prompt: "x" }).task_id;
		const ids = {
			ok: mk("qa"),
			blocked: mk("qa"),
			code: mk("qa"),
			signal: mk("qa"),
			spawn: mk("qa"),
			stop: mk("qa"),
			aborted: mk("qa"),
			empty: mk("qa"),
		};
		// maxWorkers 4: first four run, rest queued; finish in order to pump the queue.
		const results: Array<[string, WorkerResult]> = [
			[ids.ok, ok("all good")],
			[ids.blocked, ok("\n  [BLOCKED] need the API key\nrest")],
			[ids.code, { code: 2, signal: null, messages: [assistant("partial work")], stderr: "boom" }],
			[ids.signal, { code: null, signal: "SIGKILL", messages: [], stderr: "" }],
			[ids.spawn, { code: null, signal: null, messages: [], stderr: "", spawnError: "ENOENT" }],
			[ids.stop, { code: 0, signal: null, messages: [assistant("x", { stopReason: "error" })], stderr: "", stopReason: "error", errorMessage: "provider 500" }],
			[ids.aborted, { code: 0, signal: null, messages: [], stderr: "", stopReason: "aborted" }],
			[ids.empty, { code: 0, signal: null, messages: [], stderr: "" }],
		];
		for (const [id, r] of results.slice(0, 4)) h.finish(id, r);
		await sleep(5);
		for (const [id, r] of results.slice(4)) {
			await sleep(2);
			h.finish(id, r);
		}
		await h.coord.whenIdle();
		const all = h.sent.flatMap((s) => s.message.details.notifications) as any[];
		const st = (id: string) => all.find((n) => n.taskId === id);
		check("completed", st(ids.ok).status === "completed");
		check("[BLOCKED] first line -> blocked, prefix stripped", st(ids.blocked).status === "blocked" && st(ids.blocked).summary.startsWith("need the API key"));
		check("nonzero exit -> failed", st(ids.code).status === "failed" && /code 2/.test(st(ids.code).summary));
		check("signal -> failed", st(ids.signal).status === "failed");
		check("spawn error -> failed", st(ids.spawn).status === "failed" && /ENOENT/.test(st(ids.spawn).summary));
		check("stopReason error -> failed", st(ids.stop).status === "failed" && /provider 500/.test(st(ids.stop).summary));
		check("stopReason aborted -> failed", st(ids.aborted).status === "failed");
		check("empty output -> failed '(no output)', no crash", st(ids.empty).status === "failed" && /no output/.test(st(ids.empty).summary));
		const runDir = join(h.root, ".foreman/runs", h.coord.runId);
		const failedMd = readFileSync(join(runDir, `${ids.code}.md`), "utf8");
		check("failure .md has stderr and partial text", failedMd.includes("boom") && failedMd.includes("partial work"));
		// timeout
		const tid = mk("backend-dev");
		await sleep(150);
		check("timeout kills the worker", h.workers.get(tid)!.killed === true);
		await h.coord.whenIdle();
		const tn = h.sent.flatMap((s) => s.message.details.notifications).find((n: any) => n.taskId === tid);
		check("timeout -> failed with timed out", tn?.status === "failed" && /timed out/.test(tn.summary));
		// summary cap
		const long = h.coord.delegate({ role: "qa", handoff_prompt: "x" }).task_id;
		h.finish(long, ok(`${"word ".repeat(300)}`));
		await h.coord.whenIdle();
		const ln = h.sent.flatMap((s) => s.message.details.notifications).find((n: any) => n.taskId === long);
		check("summary <= 400 chars, whitespace collapsed", ln.summary.length <= 400 && !/\s{2}/.test(ln.summary));
		h.cleanup();
	}

	// 4. two simultaneous completions -> ONE sendMessage with two blocks.
	{
		const h = harness();
		const a = h.coord.delegate({ role: "qa", handoff_prompt: "a" }).task_id;
		const b = h.coord.delegate({ role: "frontend-dev", handoff_prompt: "b" }).task_id;
		h.finish(a, ok("A done"));
		h.finish(b, ok("B done"));
		await h.coord.whenIdle();
		check("one sendMessage for two completions", h.sent.length === 1);
		check("two blocks in the message", (h.sent[0].message.content.match(/<task-notification>/g) ?? []).length === 2);
		check("ledger has both lines before send", h.sent[0].ledgerLinesAtSend === 2);
		h.cleanup();
	}

	// 5. idle vs busy delivery.
	{
		const h = harness();
		const a = h.coord.delegate({ role: "qa", handoff_prompt: "a" }).task_id;
		h.finish(a, ok("done"));
		await h.coord.whenIdle();
		check("idle delivery: triggerTurn only", h.sent[0].options.triggerTurn === true && h.sent[0].options.deliverAs === undefined);
		check("idle send marks busy (no agent_start race)", h.coord.stats().busy === true);
		// busy: orchestrator mid-run
		h.coord.onAgentSettled([h.sent[0].message.details.batchId]);
		h.coord.onAgentStart();
		const b = h.coord.delegate({ role: "qa", handoff_prompt: "b" }).task_id;
		h.finish(b, ok("done b"));
		await h.coord.whenIdle();
		check("busy delivery: followUp + triggerTurn", h.sent[1].options.deliverAs === "followUp" && h.sent[1].options.triggerTurn === true);

		// 10. followUp lost at turn end -> re-sent on settle, ledger not duplicated.
		const ledgerPath = join(h.root, ".foreman/runs", h.coord.runId, "ledger.log");
		const before = readFileSync(ledgerPath, "utf8");
		h.coord.onAgentSettled([]); // second batch NOT visible in the session
		check("undelivered batch re-sent on settle", h.sent.length === 3 && h.sent[2].options.triggerTurn === true && h.sent[2].options.deliverAs === undefined);
		check("re-send carries same batch", h.sent[2].message.details.batchId === h.sent[1].message.details.batchId);
		check("ledger not duplicated on re-send", readFileSync(ledgerPath, "utf8") === before);
		h.coord.onAgentSettled([h.sent[1].message.details.batchId]);
		check("delivered batch is not re-sent", h.sent.length === 3);
		h.cleanup();
	}

	// 10b. batch never delivered -> dropped after 3 attempts with a warning.
	{
		const h = harness();
		const id = h.coord.delegate({ role: "qa", handoff_prompt: "a" }).task_id;
		h.finish(id, ok("done"));
		await h.coord.whenIdle();
		const warnings: string[] = [];
		const origError = console.error;
		console.error = (...a: unknown[]) => void warnings.push(a.join(" "));
		try {
			for (let i = 0; i < 5; i++) h.coord.onAgentSettled([]);
		} finally {
			console.error = origError;
		}
		check("undelivered batch sent at most 3 times", h.sent.length === 3);
		check(
			"dropped batch warns with task id and output path",
			warnings.length === 1 && warnings[0].includes(id) && warnings[0].includes(`.foreman/runs/${h.coord.runId}/${id}.md`),
		);
		h.cleanup();
	}

	// 6. concurrency cap: 6 delegates, 4 run, 2 queued, start as slots free.
	{
		const h = harness({ maxWorkers: 4 });
		const acks = Array.from({ length: 6 }, (_, i) => h.coord.delegate({ role: "qa", handoff_prompt: `t${i}` }));
		check("4 spawned, 2 queued", h.spawned.length === 4 && acks.filter((a) => a.state === "queued").length === 2);
		check("stats", h.coord.stats().running === 4 && h.coord.stats().queued === 2);
		h.finish("t1-qa", ok("one"));
		await sleep(5);
		check("queued task starts when a slot frees", h.spawned.length === 5 && h.spawned[4] === "t5-qa");
		h.finish("t2-qa", ok("two"));
		await sleep(5);
		check("second queued task starts", h.spawned.length === 6);
		for (const id of ["t3-qa", "t4-qa", "t5-qa", "t6-qa"]) h.finish(id, ok(id));
		await h.coord.whenIdle();
		const all = h.sent.flatMap((s) => s.message.details.notifications);
		check("all 6 notified", all.length === 6);
		h.cleanup();
	}

	// 8. plan_slug latching.
	{
		const h = harness();
		const a = h.coord.delegate({ role: "qa", handoff_prompt: "a" }).task_id; // no slug yet
		const b = h.coord.delegate({ role: "qa", handoff_prompt: "b", plan_slug: "alpha", plan_step: 1 }).task_id; // latches
		const c = h.coord.delegate({ role: "qa", handoff_prompt: "c" }).task_id; // inherits
		for (const id of [a, b, c]) h.finish(id, ok(id));
		await h.coord.whenIdle();
		const runJson = JSON.parse(readFileSync(join(h.root, ".foreman/runs", h.coord.runId, "run.json"), "utf8"));
		check("slug latched in run.json", runJson.plan_slug === "alpha");
		const progress = readFileSync(join(h.root, ".foreman/plan-runner/alpha/progress.md"), "utf8");
		check("later call inherits slug", progress.includes("t3-qa.md") && progress.includes("t2-qa.md"));
		check("call before latch has no progress.md entry", !progress.includes("t1-qa.md"));
		check("run ledger has all three", readFileSync(join(h.root, ".foreman/runs", h.coord.runId, "ledger.log"), "utf8").split("\n").filter(Boolean).length === 3);
		h.cleanup();
	}

	// 9. recovery.
	{
		const h = harness();
		const oldRun = "old-run";
		const dir = join(h.root, ".foreman/runs", oldRun);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "t1-qa.md"), "Recovered report text\n");
		const entries = [
			{ runId: oldRun, taskId: "t1-qa", role: "qa", state: "running", planStep: 3, output: `.foreman/runs/${oldRun}/t1-qa.md` },
			{ runId: oldRun, taskId: "t2-qa", role: "qa", state: "running", output: `.foreman/runs/${oldRun}/t2-qa.md` },
			{ runId: oldRun, taskId: "t3-qa", role: "qa", state: "running", output: `.foreman/runs/${oldRun}/t3-qa.md` },
			{ runId: oldRun, taskId: "t3-qa", role: "qa", state: "completed", output: `.foreman/runs/${oldRun}/t3-qa.md` },
		];
		check("recover reports 2 orphans", h.coord.recover(entries) === 2);
		await h.coord.whenIdle();
		const ns = h.sent[0].message.details.notifications as any[];
		check("output present -> notified with report", ns.find((n) => n.taskId === "t1-qa")?.status === "completed" && /Recovered report/.test(ns.find((n) => n.taskId === "t1-qa").summary));
		check("no output -> failed orphaned", ns.find((n) => n.taskId === "t2-qa")?.status === "failed" && /orphaned/.test(ns.find((n) => n.taskId === "t2-qa").summary));
		check("task with completion entry not re-notified", !ns.some((n) => n.taskId === "t3-qa"));
		h.cleanup();
	}

	// 12. shutdown kills children, sends nothing.
	{
		const h = harness({ maxWorkers: 1 });
		const a = h.coord.delegate({ role: "qa", handoff_prompt: "a" }).task_id;
		h.coord.delegate({ role: "qa", handoff_prompt: "b" });
		h.coord.shutdown();
		await sleep(40);
		check("shutdown kills running worker", h.workers.get(a)!.killed);
		check("queued task never spawned", h.spawned.length === 1);
		check("shutdown sends no notification", h.sent.length === 0);
		check("aborted state persisted", h.entries.some((e) => e.data.state === "aborted"));
		h.cleanup();
	}

	// 11. guards.
	{
		const h = harness({ active: false });
		let msg = "";
		try {
			h.coord.delegate({ role: "qa", handoff_prompt: "x" });
		} catch (e) {
			msg = String(e);
		}
		check("mode off -> coordinator refuses and points at /foreman", /not in orchestrator mode/.test(msg) && /\/foreman/.test(msg) && !/marker/i.test(msg));
		h.setActive(true);
		msg = "";
		try {
			h.coord.delegate({ role: "wizard", handoff_prompt: "x" });
		} catch (e) {
			msg = String(e);
		}
		check("unknown role rejected", /Unknown role/.test(msg));
		check("nothing spawned for rejected calls", h.spawned.length === 0);
		check("finalReport ignores non-assistant/empty", finalReport([{ role: "user", content: [] }]) === "");
		h.cleanup();
	}

	// index.ts wiring with a fake ExtensionAPI (real pi.events bus).
	{
		const fake = () => {
			const tools: any[] = [];
			const handlers: Record<string, any[]> = {};
			const renderers: string[] = [];
			const commands: Record<string, any> = {};
			const events = createEventBus();
			return {
				tools,
				handlers,
				renderers,
				commands,
				events,
				api: {
					events,
					registerTool: (tool: any) => tools.push(tool),
					registerCommand: (name: string, o: any) => (commands[name] = o),
					registerMessageRenderer: (type: string) => renderers.push(type),
					on: (e: string, h: any) => ((handlers[e] ??= []).push(h), () => {}),
					sendMessage: () => {},
					appendEntry: () => {},
				},
			};
		};
		process.env.FOREMAN_PI_SUBAGENT = "1";
		const child = fake();
		await extension(child.api as any);
		check("FOREMAN_PI_SUBAGENT=1 registers no tool, command or handler", child.tools.length === 0 && Object.keys(child.handlers).length === 0 && Object.keys(child.commands).length === 0);
		delete process.env.FOREMAN_PI_SUBAGENT;

		const orch = fake();
		await extension(orch.api as any);
		check("foreman_delegate registered", orch.tools.length === 1 && orch.tools[0].name === "foreman_delegate");
		check("/foreman-status registered", !!orch.commands["foreman-status"] && !!orch.commands["foreman-status"].description);
		check("notification renderer registered", orch.renderers.includes(NOTIFICATION_CUSTOM_TYPE));
		const props = Object.keys(orch.tools[0].parameters.properties);
		check("params: role, handoff_prompt, plan_step, plan_slug", ["role", "handoff_prompt", "plan_step", "plan_slug"].every((p) => props.includes(p)));
		const roleEnum: string[] = orch.tools[0].parameters.properties.role.enum ?? [];
		check("role enum is exactly lib/roles.ts ROLES", JSON.stringify(roleEnum) === JSON.stringify([...SHARED_ROLES]), roleEnum.join(","));
		check("role enum has reviewer and shipper, not the dropped role", roleEnum.includes("reviewer") && roleEnum.includes("shipper") && !roleEnum.includes(["release", "manager"].join("-")));
		check("guidelines say end turn / never poll", /END YOUR TURN/.test(orch.tools[0].promptGuidelines.join(" ")) && /Never poll/.test(orch.tools[0].promptGuidelines.join(" ")));

		const dir = mkdtempSync(join(tmpdir(), "foreman-coord-idx-"));
		const ctx: any = { cwd: dir, model: undefined, sessionManager: { getEntries: () => [] } };
		let err = "";
		try {
			await orch.tools[0].execute("id", { role: "qa", handoff_prompt: "x" }, undefined, undefined, ctx);
		} catch (e) {
			err = String(e);
		}
		check("mode off -> execute refuses and says to run /foreman", /orchestrator mode/.test(err) && /\/foreman/.test(err) && !/marker/i.test(err));
		// A leftover file from an older version changes nothing.
		writeFileSync(join(dir, [".orchestrator", "active"].join("-")), "");
		err = "";
		try {
			await orch.tools[0].execute("id", { role: "qa", handoff_prompt: "x" }, undefined, undefined, ctx);
		} catch (e) {
			err = String(e);
		}
		check("a stray leftover marker file does not enable delegation", /orchestrator mode/.test(err));
		orch.events.emit(MODE_EVENT, { active: true });
		err = "";
		try {
			await orch.tools[0].execute("id", { role: "nope", handoff_prompt: "x" }, undefined, undefined, ctx);
		} catch (e) {
			err = String(e);
		}
		const th = { fg: (_c: any, t: string) => t, bold: (t: string) => t };
		const a = { role: "qa", plan_step: 7, plan_slug: "my-plan", handoff_prompt: "do it" };
		check("renderCall shows role and plan_step", /qa/.test(callText(a, false, th)) && /step 7/.test(callText(a, false, th)));
		check("renderCall hides plan_slug collapsed, shows expanded", !/my-plan/.test(callText(a, false, th)) && /my-plan/.test(callText(a, true, th)));
		const det: any = buildDetails({ task_id: "t1-qa", state: "running", ack: "x", run_id: "r" } as any, a);
		check("result details include role, plan_step, plan_slug", det.role === "qa" && det.plan_step === 7 && det.plan_slug === "my-plan" && det.task_id === "t1-qa");
		const resTxt = JSON.parse(delegateResultText({ task_id: "t1-qa", state: "running", ack: "x", run_id: "r9" } as any));
		check("delegate result text includes run_id", resTxt.run_id === "r9" && resTxt.task_id === "t1-qa" && resTxt.state === "running");
		check("renderCall via tool def works", /step 7/.test(orch.tools[0].renderCall(a, th, { expanded: false }).render(200).join("\n")));
		check("mode on (event) + unknown role -> execute throws Unknown role", /Unknown role/.test(err));
		for (const h of orch.handlers.agent_settled ?? []) await h({ type: "agent_settled", aborted: false }, ctx);
		for (const h of orch.handlers.session_shutdown ?? []) await h({}, ctx);
		check("lifecycle handlers tolerate no-op sessions", true);
		rmSync(dir, { recursive: true, force: true });
	}

	// Phase 7a. snapshot / onChange / abortAll on the coordinator.
	{
		const h = harness({ maxWorkers: 1 });
		let changes = 0;
		const off = h.coord.onChange(() => changes++);
		check("snapshot: empty before any task", JSON.stringify(h.coord.snapshot()) === JSON.stringify({ running: [], queued: 0, finished: [] }));
		const a = h.coord.delegate({ role: "qa", handoff_prompt: "a", plan_step: 4 }).task_id;
		const b = h.coord.delegate({ role: "backend-dev", handoff_prompt: "b" }).task_id;
		let s1 = h.coord.snapshot();
		check("snapshot: one running (role, step, startedAt), one queued", s1.running.length === 1 && s1.running[0].taskId === a && s1.running[0].role === "qa" && s1.running[0].planStep === 4 && typeof s1.running[0].startedAt === "number" && s1.queued === 1 && s1.finished.length === 0);
		check("onChange fired for start and queue", changes >= 2);
		h.finish(a, ok("done"));
		await sleep(10);
		s1 = h.coord.snapshot();
		check("snapshot: finished listed with state, next task promoted", s1.finished[0]?.taskId === a && s1.finished[0].state === "completed" && s1.running[0]?.taskId === b && s1.queued === 0);
		h.finish(b, { code: 1, signal: null, messages: [], stderr: "x" });
		await h.coord.whenIdle();
		s1 = h.coord.snapshot();
		check("snapshot: failed state, newest first", s1.finished[0].taskId === b && s1.finished[0].state === "failed" && s1.finished[1].state === "completed" && s1.running.length === 0);
		const before = changes;
		off();
		h.coord.delegate({ role: "qa", handoff_prompt: "c" });
		check("onChange unsubscribe works", changes === before);
		h.cleanup();

		// finished list is capped
		const h2 = harness({ maxWorkers: 20 });
		const ids = Array.from({ length: 8 }, () => h2.coord.delegate({ role: "qa", handoff_prompt: "x" }).task_id);
		for (const id of ids) h2.finish(id, ok("ok"));
		await h2.coord.whenIdle();
		check("snapshot: finished capped at 5", h2.coord.snapshot().finished.length === 5);
		h2.cleanup();

		// abortAll
		const h3 = harness({ maxWorkers: 1 });
		const r1 = h3.coord.delegate({ role: "qa", handoff_prompt: "a" }).task_id;
		h3.coord.delegate({ role: "qa", handoff_prompt: "b" });
		const n = await h3.coord.abortAll();
		const s3 = h3.coord.snapshot();
		check("abortAll: kills running, drops queued, returns count", n === 2 && h3.workers.get(r1)!.killed && h3.spawned.length === 1);
		check("abortAll: snapshot shows both aborted, nothing running or queued", s3.running.length === 0 && s3.queued === 0 && s3.finished.length === 2 && s3.finished.every((f) => f.state === "aborted"));
		await sleep(60);
		check("abortAll: no notification wakes the orchestrator", h3.sent.length === 0);
		check("abortAll: aborted state persisted", h3.entries.some((e) => e.data.taskId === r1 && e.data.state === "aborted"));
		const again = h3.coord.delegate({ role: "qa", handoff_prompt: "after" });
		check("delegate works again after abortAll", again.state === "running");
		h3.cleanup();
	}

	// Phase 7b. widget/status renderers (pure) in both locales.
	{
		const now = 1_000_000;
		const empty: WorkersSnapshot = { running: [], queued: 0, finished: [] };
		check("render: empty -> status and widget cleared", renderWorkersUi(empty, now).status === undefined && renderWorkersUi(empty, now).widget === undefined);
		const doneOnly: WorkersSnapshot = { running: [], queued: 0, finished: [{ taskId: "t1-qa", role: "qa", state: "completed", finishedAt: now }] };
		check("render: only finished -> cleared (finished lines only ride along with live workers)", renderWorkersUi(doneOnly, now).widget === undefined);
		const live: WorkersSnapshot = {
			running: [{ taskId: "t2-backend-dev", role: "backend-dev", planStep: 3, title: "Carousel UI", startedAt: now - 65_000 }, { taskId: "t3-qa", role: "qa", startedAt: now - 4_000 }],
			queued: 2,
			finished: [
				{ taskId: "t1-planner", role: "planner", state: "completed", finishedAt: now },
				{ taskId: "t0-qa", role: "qa", state: "failed", finishedAt: now },
				{ taskId: "t9-qa", role: "qa", state: "blocked", finishedAt: now },
				{ taskId: "t8-qa", role: "qa", state: "aborted", finishedAt: now },
			],
		};
		const lang = (l: string) => {
			process.env.FOREMAN_LANG = l;
			const r = renderWorkersUi(live, now);
			const rep = renderReport(live, { active: true, source: "entry" }, now);
			delete process.env.FOREMAN_LANG;
			return { ...r, rep };
		};
		const en = lang("en");
		const pt = lang("pt-BR");
		check("render: running line has step, title and elapsed time", en.widget!.some((l) => l === "▶ step 3 · Carousel UI · 1m05s") && en.widget!.some((l) => l === "▶ qa · 4s"));
		check("render: no header, no task ids", !en.widget!.some((l) => /Foreman workers|t2-backend-dev|t3-qa/.test(l)));
		check("render: queued count and only the latest finished worker", en.widget!.some((l) => l.includes("2 queued")) && en.widget!.some((l) => l === `${GLYPHS.completed} planner`) && en.widget!.length === 4);
		check("render: status text", en.status === "workers: 2 running, 2 queued", en.status);
		check("render: pt-BR differs and is Portuguese", pt.status === "workers: 2 em execução, 2 na fila" && pt.widget!.some((l) => l.includes("etapa 3 · Carousel UI")) && pt.widget!.some((l) => l.includes("2 na fila")));
		check("render: report mentions mode, source, workers in both locales", /Orchestrator mode: on \(session entry\)/.test(en.rep) && /Modo orquestrador: ativado \(entrada da sessão\)/.test(pt.rep) && en.rep !== pt.rep);
		check("render: no raw placeholders", ![en.status!, pt.status!, ...en.widget!, ...pt.widget!, en.rep, pt.rep].some((x) => /\{\w+\}/.test(x)));
		const none = renderReport(empty, { active: false, source: "default" }, now);
		check("report: empty state says nothing ran", none.includes(t("report.none")) && /off \(default\)/.test(none));

		// E1 task 4: activity line and report detail.
		const view = (o: Partial<import("../../lib/activity.ts").ActivityView> = {}): import("../../lib/activity.ts").ActivityView => ({
			phase: "writing", label: "write app/static/js/builder.js 38 KB", bytes: 38_000, lastEventAt: now - 1000, turns: 3, toolCalls: 21, outTokens: 14_000, cost: 0.42,
			recent: [], health: "active", denials: 0, lastDenial: "", ...o,
		});
		const snapA = (a?: import("../../lib/activity.ts").ActivityView, cols?: number, title = "Carousel UI") =>
			renderWorkersUi({ running: [{ taskId: "t1-dev", role: "dev", planStep: 13, title, startedAt: now - 283_000, activity: a }], queued: 0, finished: [] }, now, cols).widget![0];
		check("widget line for an active writing worker matches the documented shape", snapA(view()) === "● step 13 · Carousel UI · 4m43s · writing app/static/js/builder.js 38 KB · 21 tools · 14k out", snapA(view()));
		const glyphs: Array<[import("../../lib/activity.ts").Health, string]> = [["active", "●"], ["waiting", "◐"], ["silent", "⚠"], ["repeating", "⟳"], ["denied", "✖"]];
		check("each health glyph renders for its state", glyphs.every(([h, g]) => snapA(view({ health: h })).startsWith(`${g} step 13`)));
		const longLine = snapA(view({ label: `write ${"very/long/dir/".repeat(20)}file.ts 90 KB` }), 100);
		check("line at 100 columns is one line and keeps elapsed time when the label is long", Array.from(longLine).length <= 100 && !longLine.includes("\n") && longLine.startsWith("● step 13 · Carousel UI · 4m43s · writing") && longLine.endsWith("…"), longLine);
		const narrow = snapA(view(), 30);
		check("narrow width never cuts glyph, step/title or elapsed", narrow.startsWith("● step 13 · Carousel UI · 4m43s") && Array.from(narrow).length <= 40);
		check("no-activity worker keeps the old line", snapA(undefined) === "▶ step 13 · Carousel UI · 4m43s" && snapA(view({ phase: "idle", label: "", turns: 0, toolCalls: 0, outTokens: 0, cost: 0 })) === "▶ step 13 · Carousel UI · 4m43s");
		const qf = renderWorkersUi({ running: [{ taskId: "t1-dev", role: "dev", startedAt: now - 5000, activity: view() }], queued: 2, finished: [{ taskId: "t0-qa", role: "qa", state: "failed", finishedAt: now }] }, now).widget!;
		check("queued and finished lines unchanged", qf[1] === "… 2 queued" && qf[2] === `${GLYPHS.failed} qa · failed`, JSON.stringify(qf));
		const recent = Array.from({ length: 7 }, (_, i) => ({ label: `bash cmd${i}`, durationMs: 2000 + i * 1000, isError: false, at: now }));
		const liveA: WorkersSnapshot = { running: [{ taskId: "t1-dev", role: "dev", planStep: 13, startedAt: now - 60_000, activity: view({ recent: recent.slice(0, 5), denials: 2, lastDenial: "Blocked by the foreman worker guard: x", health: "silent", lastEventAt: now - 95_000 }) }], queued: 0, finished: [] };
		const repEn = renderReport(liveA, { active: true, source: "entry" }, now);
		check("renderReport lists last 5 actions, tokens and denial count", [0, 1, 2, 3, 4].every((i) => repEn.includes(`bash cmd${i}`)) && repEn.includes("14k output tokens") && repEn.includes("21 tool calls") && repEn.includes("guard denials: 2") && repEn.includes("$0.42") && repEn.includes("no events for 95s"), repEn);
		process.env.FOREMAN_LANG = "pt-BR";
		const repPt = renderReport(liveA, { active: true, source: "entry" }, now);
		const linePt = snapA(view());
		delete process.env.FOREMAN_LANG;
		check("pt-BR renders the same structure", repPt.split("\n").length === repEn.split("\n").length && repPt.includes("negações do guard: 2") && repPt.includes("sem eventos há 95s") && linePt.startsWith("● etapa 13 · Carousel UI · 4m43s · escrevendo") && ![repPt, linePt].some((x) => /\{\w+\}/.test(x)), repPt);
		check("empty / no running workers still returns {}", Object.keys(renderWorkersUi(empty, now, 100)).length === 0);
	}

	// Phase 7c. index.ts: status bar, widget, events, /foreman-status, abort (fake spawn).
	{
		const savedBatch = process.env.FOREMAN_BATCH_MS;
		process.env.FOREMAN_BATCH_MS = "20";
		const mk = () => {
			const tools: any[] = [];
			const commands: Record<string, any> = {};
			const handlers: Record<string, any[]> = {};
			const events = createEventBus();
			const workers = new Map<string, { resolve: (r: WorkerResult) => void; killed: boolean }>();
			const sentMsgs: any[] = [];
			const api: any = {
				events,
				registerTool: (tool: any) => tools.push(tool),
				registerCommand: (name: string, o: any) => (commands[name] = o),
				registerMessageRenderer: () => {},
				on: (e: string, h: any) => ((handlers[e] ??= []).push(h), () => {}),
				sendMessage: (m: any, o: any) => sentMsgs.push({ m, o }),
				appendEntry: () => {},
			};
			registerCoordination(api, (req) => {
				let resolve!: (r: WorkerResult) => void;
				const done = new Promise<WorkerResult>((res) => (resolve = res));
				const w = { resolve, killed: false };
				workers.set(req.taskId, w);
				return { done, kill: () => ((w.killed = true), resolve({ code: null, signal: "SIGTERM", messages: [], stderr: "" })) };
			});
			return { tools, commands, handlers, events, workers, sentMsgs };
		};
		const uiCtx = (dir: string, over: Record<string, unknown> = {}) => {
			const calls = { status: [] as Array<string | undefined>, widget: [] as Array<string[] | undefined>, notify: [] as string[] };
			const ctx: any = {
				cwd: dir,
				hasUI: true,
				model: undefined,
				sessionManager: { getEntries: () => [], getBranch: () => [] },
				ui: {
					setStatus: (_k: string, v?: string) => calls.status.push(v),
					setWidget: (_k: string, v?: string[]) => calls.widget.push(v),
					notify: (m: string) => calls.notify.push(m),
				},
				...over,
			};
			return { ctx, calls };
		};
		const dir = mkdtempSync(join(tmpdir(), "foreman-coord-ui-"));
		const m = mk();
		const { ctx, calls } = uiCtx(dir);
		const snaps: WorkersSnapshot[] = [];
		m.events.on(WORKERS_EVENT, (d: any) => snaps.push(d));
		await m.handlers.session_start[0]({ reason: "startup" }, ctx);
		m.events.emit(MODE_EVENT, { active: true });
		const ack = await m.tools[0].execute("id", { role: "qa", handoff_prompt: "x", plan_step: 2 }, undefined, undefined, ctx);
		check("ui: delegate returns an ack and the worker is running", JSON.parse(ack.content[0].text).state === "running");
		check("ui: foreman:workers snapshot published on the bus", snaps.at(-1)?.running.length === 1 && snaps.at(-1)?.running[0].taskId === "t1-qa");
		check("ui: status bar set while running", calls.status.at(-1) === "workers: 1 running, 0 queued", String(calls.status.at(-1)));
		check("ui: widget lists the running worker", !!calls.widget.at(-1)?.some((l) => l.startsWith("▶ step 2 · ")));

		await m.commands["foreman-status"].handler("", ctx);
		check("/foreman-status notifies with mode and workers (no model call)", calls.notify.at(-1)?.includes("Orchestrator mode: on") === true && calls.notify.at(-1)?.includes("t1-qa") === true && m.sentMsgs.length === 0);
		process.env.FOREMAN_LANG = "pt-BR";
		await m.commands["foreman-status"].handler("", ctx);
		delete process.env.FOREMAN_LANG;
		check("/foreman-status is localized", /Modo orquestrador: ativado/.test(calls.notify.at(-1) ?? "") && /Situação do foreman/.test(calls.notify.at(-1) ?? ""));

		m.workers.get("t1-qa")!.resolve(ok("fine"));
		await sleep(60);
		check("ui: status and widget cleared once nothing is live", calls.status.at(-1) === undefined && calls.widget.at(-1) === undefined);
		check("ui: published snapshot shows the finished worker", snaps.at(-1)?.running.length === 0 && snaps.at(-1)?.finished[0]?.state === "completed");

		// Failed worker rides along in the widget while another runs.
		await m.tools[0].execute("id", { role: "qa", handoff_prompt: "a" }, undefined, undefined, ctx);
		await m.tools[0].execute("id", { role: "qa", handoff_prompt: "b" }, undefined, undefined, ctx);
		m.workers.get("t2-qa")!.resolve({ code: 2, signal: null, messages: [], stderr: "boom" });
		await sleep(60);
		check("ui: failed worker shown with its glyph next to the running one", !!calls.widget.at(-1)?.some((l) => l.startsWith(`${GLYPHS.failed} qa`)) && !!calls.widget.at(-1)?.some((l) => l.startsWith("▶ qa")));

		// Abort via the bus: kills, acks, clears the UI, no notification.
		let acked = false;
		const notesBefore = m.sentMsgs.length;
		m.events.emit(WORKERS_ABORT_EVENT, { ack: () => (acked = true) });
		await sleep(60);
		check("abort event: worker killed, ack received", acked && m.workers.get("t3-qa")!.killed);
		check("abort event: UI cleared, snapshot has nothing running", calls.status.at(-1) === undefined && snaps.at(-1)?.running.length === 0);
		check("abort event: no extra notification for aborted worker", m.sentMsgs.length === notesBefore);

		// Abort with no coordinator yet acks at once.
		const m2 = mk();
		let acked2 = false;
		m2.events.emit(WORKERS_ABORT_EVENT, { ack: () => (acked2 = true) });
		check("abort event with no coordinator: immediate ack", acked2);

		// hasUI false: no UI calls at all, no crash.
		const m3 = mk();
		const noUi = uiCtx(dir, { hasUI: false });
		m3.events.emit(MODE_EVENT, { active: true });
		await m3.tools[0].execute("id", { role: "qa", handoff_prompt: "x" }, undefined, undefined, noUi.ctx);
		const errLines: string[] = [];
		const origWrite = process.stderr.write.bind(process.stderr);
		(process.stderr as any).write = (c: any) => (errLines.push(String(c)), true);
		await m3.commands["foreman-status"].handler("", noUi.ctx);
		(process.stderr as any).write = origWrite;
		check("hasUI false: no status/widget calls; /foreman-status falls back to stderr", noUi.calls.status.length === 0 && noUi.calls.widget.length === 0 && noUi.calls.notify.length === 0 && errLines.join("").includes("t1-qa"));
		m3.workers.get("t1-qa")!.resolve(ok("x"));
		await sleep(40);

		// Stale ctx: UI calls throw after a reload; nothing propagates.
		const m4 = mk();
		const stale = uiCtx(dir);
		stale.ctx.ui.setStatus = () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		};
		stale.ctx.ui.setWidget = stale.ctx.ui.setStatus;
		m4.events.emit(MODE_EVENT, { active: true });
		let threw = "";
		try {
			await m4.tools[0].execute("id", { role: "qa", handoff_prompt: "x" }, undefined, undefined, stale.ctx);
			m4.workers.get("t1-qa")!.resolve(ok("x"));
			await sleep(40);
		} catch (e) {
			threw = String(e);
		}
		check("stale ctx: status/widget errors are swallowed", threw === "", threw);
		await m.handlers.session_shutdown[0]({}, ctx);
		check("session_shutdown clears status and widget", calls.status.at(-1) === undefined && calls.widget.at(-1) === undefined);
		rmSync(dir, { recursive: true, force: true });
		if (savedBatch === undefined) delete process.env.FOREMAN_BATCH_MS;
		else process.env.FOREMAN_BATCH_MS = savedBatch;
	}


	// Rendered: field (render gate).
	{
		const blk = (r: string) => `--- foreman-report ---\nStatus: completed\nSummary: s\nFiles: none\nRulings: none\nBlocked-on: none\n${r}--- end foreman-report ---`;
		check("rendered: unrendered parsed", parseFinalBlock(blk("Rendered: unrendered\n")).rendered === "unrendered");
		check("rendered: path parsed", parseFinalBlock(blk("Rendered: .foreman/shots/a.png\n")).rendered === ".foreman/shots/a.png");
		check("rendered: n/a and absent are empty", parseFinalBlock(blk("Rendered: n/a\n")).rendered === "" && parseFinalBlock(blk("")).rendered === "");
		check("rendered does not break the contract", parseFinalBlock(blk("Rendered: unrendered\n")).contract === "ok");
	}

	// Phase 4a. parseFinalBlock: contract parsing and fallback chain.
	{
		const blk = (fields: string) => `--- foreman-report ---\n${fields}\n--- end foreman-report ---`;
		const full = (status: string, extra = "") =>
			blk(`Status: ${status}\nSummary: did it\nFiles: a.ts, b/c.ts\nRulings: Ruling: x — y\nBlocked-on: none${extra}`);
		for (const st of ["completed", "failed", "blocked"] as const) {
			const p = parseFinalBlock(`work\n${full(st)}`);
			check(`parser: Status ${st}`, p.status === st && p.contract === "ok" && p.summary === "did it");
		}
		const p0 = parseFinalBlock(full("completed"));
		check("parser: files, rulings, blocked-on none", p0.files.join("|") === "a.ts|b/c.ts" && p0.rulings.join("|") === "Ruling: x — y" && p0.blockedOn === "");
		const pb = parseFinalBlock(`[BLOCKED] first\n${full("completed")}`);
		check("parser: [BLOCKED] plus a block -> block wins", pb.status === "completed" && pb.contract === "ok");
		const pl = parseFinalBlock("[BLOCKED] need key\nrest");
		check("parser: legacy [BLOCKED] -> blocked, contract missing", pl.status === "blocked" && pl.contract === "missing" && pl.summary.startsWith("need key"));
		const pm = parseFinalBlock("just prose");
		check("parser: missing block -> completed/missing", pm.status === "completed" && pm.contract === "missing" && pm.summary === "just prose");
		const pd = parseFinalBlock(blk("Status: done\nSummary: s"));
		check("parser: Status: done -> malformed, falls to completed", pd.contract === "malformed" && pd.status === "completed");
		const pdb = parseFinalBlock(`[BLOCKED] x\n${blk("Status: done\nSummary: s")}`);
		check("parser: malformed then [BLOCKED] -> blocked/malformed", pdb.contract === "malformed" && pdb.status === "blocked");
		const p2 = parseFinalBlock(`${blk("Status: failed\nSummary: first")}\ntext\n${blk("Status: completed\nSummary: last")}`);
		check("parser: two blocks, last wins", p2.status === "completed" && p2.summary === "last");
		const p2b = parseFinalBlock(`${blk("Status: failed\nSummary: good")}\n${blk("Status: nope\nSummary: bad")}`);
		check("parser: last WELL-FORMED wins over later malformed", p2b.status === "failed" && p2b.contract === "ok");
		const pf = parseFinalBlock("```\n" + full("blocked") + "\n```");
		check("parser: block inside a code fence", pf.status === "blocked" && pf.contract === "ok");
		const pc = parseFinalBlock(full("completed").replace(/\n/g, "\r\n"));
		check("parser: CRLF", pc.status === "completed" && pc.summary === "did it" && pc.files.length === 2);
		const pms = parseFinalBlock(blk("Status: completed\nSummary: line one\nline two\n\nline three\nFiles: none\nRulings: none\nBlocked-on: none"));
		check("parser: multi-line Summary", pms.summary === "line one line two line three" && pms.files.length === 0 && pms.rulings.length === 0);
		const pe = parseFinalBlock(blk("Status: completed\nSummary: s\nFiles:\nRulings:\nBlocked-on:"));
		check("parser: empty Files", pe.contract === "ok" && pe.files.length === 0 && pe.blockedOn === "");
		const pbo = parseFinalBlock(blk("Status: blocked\nSummary: s\nFiles: none\nRulings: none\nBlocked-on: the user's API key"));
		check("parser: Blocked-on captured", pbo.status === "blocked" && pbo.blockedOn === "the user's API key");
		const pun = parseFinalBlock("--- foreman-report ---\nStatus: completed\nSummary: s");
		check("parser: unterminated block -> malformed", pun.contract === "malformed");
		// Bilingual cases
		const ppt = parseFinalBlock(blk("Status: completed\nSummary: Implementação concluída: ação, validação e testes passaram.\nResumo: tudo certo, sem pendências.\nFiles: src/ção.ts\nRulings: Ruling: usar café — decisão rápida\nBlocked-on: nada"));
		check("parser: pt-BR Summary with accents and Resumo: line", ppt.contract === "ok" && ppt.status === "completed" && ppt.summary === "Implementação concluída: ação, validação e testes passaram. Resumo: tudo certo, sem pendências." && ppt.files[0] === "src/ção.ts");
		const ploc = parseFinalBlock(blk("Estado: concluído\nResumo: feito\nArquivos: a.ts"));
		check("parser: localized keys -> malformed, not misparsed", ploc.contract === "malformed" && ploc.status === "completed");
		const pmix = parseFinalBlock(blk("Status: concluído\nSummary: feito"));
		check("parser: localized Status value -> malformed", pmix.contract === "malformed");
		const pup = parseFinalBlock(blk("STATUS: COMPLETED\nSUMMARY: Ok\nFILES: none"));
		check("parser: upper case keys and value accepted", pup.contract === "ok" && pup.status === "completed" && pup.summary === "Ok");
		// Phase 8: reviewer report, Portuguese findings + English Verdict token
		const prv = parseFinalBlock(blk("Status: completed\nSummary: Revisão concluída: 1 achado importante em src/ação.ts:42 (validação ausente).\nVerdict: changes-requested\nFiles: none\nRulings: none\nBlocked-on: none"));
		check("parser: reviewer pt-BR findings keep the English Verdict token in summary", prv.contract === "ok" && prv.status === "completed" && /Revisão concluída/.test(prv.summary) && /Verdict: changes-requested$/.test(prv.summary), prv.summary);
		const prva = parseFinalBlock(blk("Status: completed\nSummary: Nenhum problema encontrado.\nVerdict: approve\nFiles: none"));
		check("parser: reviewer approve verdict", prva.status === "completed" && /Verdict: approve$/.test(prva.summary));
		const prvb = parseFinalBlock(blk("Status: blocked\nSummary: Não foi possível resolver os SHAs.\nFiles: none\nRulings: none\nBlocked-on: BASE_SHA unresolved"));
		check("parser: reviewer blocked when SHAs unresolved", prvb.status === "blocked" && prvb.contract === "ok");
		// A shipper handoff without a review reference is answered with a blocked report (contract in agents/shipper.md).
		const shipperPrompt = composeWorkerPrompt(discoverAgents(process.cwd(), "user").agents.find((a) => a.name === "shipper")!);
		check("shipper prompt: missing review reference -> Status: blocked, nothing else", /missing[^\n]*\n?[^\n]*Status: blocked/.test(shipperPrompt) && /Blocked-on: review reference/.test(shipperPrompt) && /Verdict: approve/.test(shipperPrompt));
		const psh = parseFinalBlock(blk("Status: blocked\nSummary: no review reference in the handoff\nFiles: none\nRulings: none\nBlocked-on: review reference"));
		check("parser: shipper blocked report", psh.status === "blocked" && psh.contract === "ok");
		check("parser: empty report", parseFinalBlock("").status === undefined);
		const pgd = parseFinalBlock(blk("Status: completed\nSummary: s\nFiles: none\nRulings: none\nBlocked-on: none\nGuard-denied: python3 -c 'exec(1)'\n- npm test\nRendered: n/a"));
		check("parseFinalBlock reads Guard-denied", pgd.contract === "ok" && pgd.status === "completed" && pgd.guardDenied.length === 2 && pgd.guardDenied[0] === "python3 -c 'exec(1)'" && pgd.guardDenied[1] === "npm test", JSON.stringify(pgd.guardDenied));
		check("parseFinalBlock: Guard-denied none/absent is empty", parseFinalBlock(blk("Status: completed\nSummary: s\nGuard-denied: none")).guardDenied.length === 0 && parseFinalBlock(blk("Status: completed\nSummary: s")).guardDenied.length === 0);
		check("formatBlock omits guard-denied when empty", !formatBlock({ taskId: "t1-qa", role: "qa", status: "completed", summary: "s", output: "o", guardDenied: [] }).includes("guard-denied"));
		{
			const many = Array.from({ length: 8 }, (_, i) => `cmd${i}`);
			const f = formatBlock({ taskId: "t1-qa", role: "qa", status: "completed", summary: "s", output: "o", guardDenied: many });
			check("formatBlock caps guard-denied at 5 items with +N more", f.includes("cmd4") && !f.includes("cmd5") && f.includes("+3 more"), f);
			const long = formatBlock({ taskId: "t1-qa", role: "qa", status: "completed", summary: "s", output: "o", guardDenied: ["x".repeat(500)] });
			check("formatBlock caps each guard-denied item at 200 chars", long.includes("x".repeat(200)) && !long.includes("x".repeat(201)));
		}
		check("formatBlock includes guard-denied when present", formatBlock({ taskId: "t1-qa", role: "qa", status: "completed", summary: "s", output: "o", guardDenied: ["npm test", "rm x"] }).includes("guard-denied: npm test | rm x"));
		const nb = formatBlock({ taskId: "t1-qa", role: "qa", status: "completed", summary: "s", output: "o", contract: "ok" });
		const nm = formatBlock({ taskId: "t1-qa", role: "qa", status: "completed", summary: "s", output: "o", contract: "malformed" });
		const nn = formatBlock({ taskId: "t1-qa", role: "qa", status: "completed", summary: "s", output: "o" });
		check("formatBlock: no report-contract line when ok/absent", !/report-contract/.test(nb) && nb === nn);
		check("formatBlock: leading lines unchanged, contract line appended", nm.startsWith(nb.replace("\n</task-notification>", "")) && /\nreport-contract: malformed\n<\/task-notification>$/.test(nm));
	}

	// Phase 4b. coordinator wiring: contract in finishTask and recover.
	{
		const h = harness({ maxWorkers: 8 });
		const mk = () => h.coord.delegate({ role: "qa", handoff_prompt: "x", plan_step: 1 }).task_id;
		const block = (st: string, summary: string) => `prose\n--- foreman-report ---\nStatus: ${st}\nSummary: ${summary}\nFiles: x.ts, y.ts\nRulings: Ruling: a — b\nBlocked-on: ${st === "blocked" ? "the user" : "none"}\n--- end foreman-report ---`;
		const okId = mk();
		const blockedId = mk();
		const failedId = mk();
		const missingId = mk();
		const malId = mk();
		const procId = mk();
		h.finish(okId, ok(block("completed", "all green")));
		h.finish(blockedId, ok(block("blocked", "need creds")));
		h.finish(failedId, ok(block("failed", "repro: step 3 breaks")));
		h.finish(missingId, ok("plain prose report"));
		h.finish(malId, ok("--- foreman-report ---\nStatus: done\nSummary: s\n--- end foreman-report ---"));
		h.finish(procId, { code: 3, signal: null, messages: [assistant(block("completed", "claims success"))], stderr: "crash" });
		await h.coord.whenIdle();
		const all = h.sent.flatMap((s) => s.message.details.notifications) as any[];
		const st = (id: string) => all.find((n) => n.taskId === id);
		check("wiring: ok block -> completed with summary/files/rulings", st(okId).status === "completed" && st(okId).summary === "all green" && st(okId).files.join() === "x.ts,y.ts" && st(okId).rulings[0] === "Ruling: a — b" && st(okId).contract === "ok");
		check("wiring: blocked block -> blocked + blockedOn", st(blockedId).status === "blocked" && st(blockedId).blockedOn === "the user");
		check("wiring: Status: failed with exit 0 -> failed, worker summary kept", st(failedId).status === "failed" && st(failedId).summary === "repro: step 3 breaks");
		check("wiring: missing block -> completed, contract missing", st(missingId).status === "completed" && st(missingId).contract === "missing");
		check("wiring: malformed block -> contract malformed", st(malId).contract === "malformed" && st(malId).status === "completed");
		check("wiring: process failure beats completed block", st(procId).status === "failed" && /code 3/.test(st(procId).summary));
		const content = h.sent.map((s) => s.message.content).join("\n");
		check("wiring: report-contract line only for missing/malformed", (content.match(/report-contract: missing/g) ?? []).length === 1 && (content.match(/report-contract: malformed/g) ?? []).length === 1);
		const meta = JSON.parse(readFileSync(join(h.root, ".foreman/runs", h.coord.runId, `${okId}.json`), "utf8"));
		check("wiring: per-task meta has files/rulings/blockedOn/contract", meta.files.length === 2 && meta.rulings.length === 1 && meta.contract === "ok" && meta.blockedOn === "");
		check("wiring: BLOCK_RE-style match still isolates each block", (content.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []).length === 6);
		h.cleanup();

		// recover: reads the contract from a saved report.
		const root = mkdtempSync(join(tmpdir(), "foreman-coord-rec4-"));
		const runDir = join(root, ".foreman", "runs", "old");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "t1-qa.md"), `${block("blocked", "waiting on creds")}\n`);
		const h2 = harness({ root });
		const n = h2.coord.recover([{ runId: "old", taskId: "t1-qa", role: "qa", state: "running", output: ".foreman/runs/old/t1-qa.md" }]);
		await h2.coord.whenIdle();
		const rn = h2.sent.flatMap((s) => s.message.details.notifications)[0] as any;
		check("recover: contract block drives status/summary/blockedOn", n === 1 && rn.status === "blocked" && rn.summary === "waiting on creds" && rn.blockedOn === "the user" && rn.contract === "ok");
		h2.cleanup();
	}

	// Phase 4c. compose: every role's worker prompt.
	{
		const { agents } = discoverAgents(process.cwd(), "user");
		const pkg = agents.filter((a) => a.source === "package");
		check("compose: package agents found", pkg.length >= 8);
		for (const a of pkg) {
			const prompt = composeWorkerPrompt(a);
			check(`compose: ${a.name} has contract marker and language rule`, prompt.includes("--- foreman-report ---") && prompt.includes("--- end foreman-report ---") && /User language:/.test(prompt) && /Field names, `Status` values/.test(prompt));
			check(`compose: ${a.name} has no raw {{PACKAGE_ROOT}}`, !prompt.includes("{{PACKAGE_ROOT}}"));
			check(`compose: ${a.name} starts with the agent body`, prompt.startsWith(a.systemPrompt.trim().slice(0, 40)));
		}
		const sample = composeWorkerPrompt(pkg[0]);
		const m = /Package root: (\S+)/.exec(sample);
		check("compose: Package root line is the real path and exists", !!m && m[1] === PACKAGE_ROOT && existsSync(join(m[1], "references", "worker-common.md")));
		check("compose: worker prompt carries Gotchas, Guard-denied and the baseline-diff path", /### Gotchas/.test(sample) && /Guard-denied:/.test(sample) && sample.includes(`${PACKAGE_ROOT}/scripts/baseline-diff.mjs`));
		check("compose: {{PACKAGE_ROOT}} also substituted in the agent body", composeWorkerPrompt({ systemPrompt: "see {{PACKAGE_ROOT}}/x" }).includes(`see ${PACKAGE_ROOT}/x`));
	}

	// A2. spawn-worker appends the coordinator footer via composeTaskArg with the final cwd.
	{
		const src = readFileSync(join(process.cwd(), "extensions", "coordination", "spawn-worker.ts"), "utf-8");
		check("spawn-worker composes the Task arg with the footer and final cwd", /workerFooter\(\{ locale: detectLocale\(\), cwd \}\)/.test(src) && /composeTaskArg\(\{ handoff: promptText/.test(src));
	}

	// Step 5. workdir: remembered per run, used as the worker cwd.
	{
		const wtBase = mkdtempSync(join(tmpdir(), "foreman-wt-"));
		const wt1 = join(wtBase, "one");
		const wt2 = join(wtBase, "two");
		mkdirSync(wt1);
		mkdirSync(wt2);
		const fakeResolve = (root: string, req: string) => {
			if (!req.startsWith(wtBase)) throw new Error(`workdir ${req} is not allowed`);
			return req;
		};
		const h = harness({ maxWorkers: 8, resolveWorkdir: fakeResolve });
		const a1 = h.coord.delegate({ role: "qa", handoff_prompt: "a", workdir: wt1 });
		const req1 = h.workers.get(a1.task_id)!.req;
		check("delegate passes workdir as SpawnRequest.cwd and keeps runDir under root", req1.cwd === wt1 && req1.runDir === join(h.root, ".foreman", "runs", h.coord.runId));
		const a2 = h.coord.delegate({ role: "qa", handoff_prompt: "b" });
		check("workdir is remembered for later delegates in the run", h.workers.get(a2.task_id)!.req.cwd === wt1);
		const a3 = h.coord.delegate({ role: "qa", handoff_prompt: "c", workdir: wt2 });
		const a4 = h.coord.delegate({ role: "qa", handoff_prompt: "d" });
		check("per-call workdir overrides the remembered one", h.workers.get(a3.task_id)!.req.cwd === wt2 && h.workers.get(a4.task_id)!.req.cwd === wt2);
		const before = h.spawned.length;
		let threw = false;
		try { h.coord.delegate({ role: "qa", handoff_prompt: "e", workdir: "/etc" }); } catch { threw = true; }
		const a5 = h.coord.delegate({ role: "qa", handoff_prompt: "f" });
		check("invalid workdir throws from delegate and spawns nothing", threw && h.spawned.length === before + 1 && h.workers.get(a5.task_id)!.req.cwd === wt2);
		const meta = JSON.parse(readFileSync(join(h.root, ".foreman", "runs", h.coord.runId, `${a1.task_id}.json`), "utf8"));
		check("meta json records workdir", meta.workdir === wt1);
		const h2 = harness();
		const b1 = h2.coord.delegate({ role: "qa", handoff_prompt: "x" });
		check("no workdir: cwd is the root", h2.workers.get(b1.task_id)!.req.cwd === h2.root);
		// Latch cleared by an empty value or ".".
		for (const clear of ["", "."]) {
			const hc = harness({ resolveWorkdir: fakeResolve });
			hc.coord.delegate({ role: "qa", handoff_prompt: "a", workdir: wt1 });
			const c2 = hc.coord.delegate({ role: "qa", handoff_prompt: "b", workdir: clear });
			const c3 = hc.coord.delegate({ role: "qa", handoff_prompt: "c" });
			check(`workdir ${JSON.stringify(clear)} clears the latch`, hc.workers.get(c2.task_id)!.req.cwd === hc.root && hc.workers.get(c3.task_id)!.req.cwd === hc.root);
			hc.cleanup();
		}
		// Latched dir deleted before start: fall back to root, note in meta.
		{
			const hd = harness({ resolveWorkdir: fakeResolve });
			const gone = join(wtBase, "gone");
			mkdirSync(gone);
			hd.coord.delegate({ role: "qa", handoff_prompt: "a", workdir: gone });
			rmSync(gone, { recursive: true });
			const d2 = hd.coord.delegate({ role: "qa", handoff_prompt: "b" });
			const m = JSON.parse(readFileSync(join(hd.root, ".foreman", "runs", hd.coord.runId, `${d2.task_id}.json`), "utf8"));
			check("deleted workdir falls back to root with workdir_fallback note", hd.workers.get(d2.task_id)!.req.cwd === hd.root && typeof m.workdir_fallback === "string" && m.workdir_fallback.includes(gone) && m.cwd === hd.root, JSON.stringify(m));
			hd.cleanup();
		}
		rmSync(wtBase, { recursive: true, force: true });
		h.cleanup();
		h2.cleanup();
	}

	// Step 6. Overlap warning on delegate.
	{
		const h = harness({ maxWorkers: 8 });
		mkdirSync(join(h.root, "docs", "plans"), { recursive: true });
		writeFileSync(join(h.root, "docs", "plans", "wave.md"), [
			"## Parallel",
			"1. **One** (Touches: `lib/a.ts`, `lib/i18n/en.ts`)",
			"2. **Two** (Touches: `lib/i18n/en.ts`)",
			"3. **Three** (Touches: `docs/z.md`)",
		].join("\n"));
		const a1 = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "a", plan_slug: "wave", plan_step: 1 });
		check("no warning for the first step of a wave", !/shares files/.test(a1.ack));
		const a2 = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "b", plan_slug: "wave", plan_step: 2 });
		check("delegate ack warns on overlap with a running step", /step 2 shares files with running step 1/.test(a2.ack) && /lib\/i18n\/en\.ts/.test(a2.ack) && a2.state === "running");
		const a3 = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "c", plan_slug: "wave", plan_step: 3 });
		check("no warning when Touches are disjoint", !/shares files/.test(a3.ack));
		h.finish(a1.task_id, ok("done"));
		await new Promise((r) => setTimeout(r, 30));
		const a4 = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "d", plan_slug: "wave", plan_step: 2 });
		check("no warning once the overlapping step finished", !/shares files/.test(a4.ack));
		const h2 = harness({ maxWorkers: 8 });
		mkdirSync(join(h2.root, "docs", "plans"), { recursive: true });
		writeFileSync(join(h2.root, "docs", "plans", "seq.md"), "1. **One** (Touches: `a.ts`)\n2. **Two** (Touches: `a.ts`)\n");
		h2.coord.delegate({ role: "plan-step-builder", handoff_prompt: "a", plan_slug: "seq", plan_step: 1 });
		const b2 = h2.coord.delegate({ role: "plan-step-builder", handoff_prompt: "b", plan_slug: "seq", plan_step: 2 });
		check("no warning when the plan has no Parallel section", !/shares files/.test(b2.ack));
		h.cleanup();
		h2.cleanup();
	}

	{
		// Step 8: shared back-off gate and writer cap.
		const savedWriters = process.env.FOREMAN_MAX_WRITERS;
		delete process.env.FOREMAN_MAX_WRITERS;
		const h = harness({ maxWorkers: 8, gate: createBackoffGate() });
		const w1 = h.coord.delegate({ role: "backend-dev", handoff_prompt: "w1" });
		const w2 = h.coord.delegate({ role: "backend-dev", handoff_prompt: "w2" });
		const w3 = h.coord.delegate({ role: "frontend-dev", handoff_prompt: "w3" });
		check("FOREMAN_MAX_WRITERS default is 2", w1.state === "running" && w2.state === "running" && w3.state === "queued");
		const r1 = h.coord.delegate({ role: "reviewer", handoff_prompt: "r1" });
		const w4 = h.coord.delegate({ role: "backend-dev", handoff_prompt: "w4" });
		check("readers start while two writers run and a third writer queues", r1.state === "running" && w4.state === "queued" && h.coord.stats().queued === 2);
		h.finish(w1.task_id, ok("done"));
		await sleep(30);
		check("queued writer keeps its place and starts when a writer finishes", h.spawned.includes(w3.task_id) && !h.spawned.includes(w4.task_id) && h.coord.stats().queued === 1);
		h.finish(w2.task_id, ok("done"));
		await sleep(30);
		check("next queued writer starts in order", h.spawned.includes(w4.task_id));
		for (const id of [...h.workers.keys()]) h.finish(id, ok("x"));
		await sleep(60);
		h.cleanup();
		if (savedWriters !== undefined) process.env.FOREMAN_MAX_WRITERS = savedWriters;

		const gate = createBackoffGate({ now: () => Date.now(), rng: () => 0.5 });
		const g = harness({ maxWorkers: 4, gate });
		const a = g.coord.delegate({ role: "reviewer", handoff_prompt: "a" });
		const b = g.coord.delegate({ role: "reviewer", handoff_prompt: "b" });
		gate.noteRateLimit("429", 150);
		gate.noteRateLimit("529 overloaded", 100);
		check("two workers hitting 429 share one pause (coordinator)", gate.remainingMs() > 100 && gate.remainingMs() <= 150);
		const c = g.coord.delegate({ role: "reviewer", handoff_prompt: "c" });
		check("coordinator does not start a queued task while paused", c.state === "queued" && !g.spawned.includes(c.task_id));
		g.finish(a.task_id, ok("a"));
		g.finish(b.task_id, ok("b"));
		await sleep(60);
		check("still queued before the pause ends", !g.spawned.includes(c.task_id));
		await sleep(200);
		check("coordinator starts it after the pause ends", g.spawned.includes(c.task_id));
		for (const id of [...g.workers.keys()]) g.finish(id, ok("x"));
		await sleep(60);
		g.cleanup();
	}

	// Step 9: orphan evidence.
	{
		const h = harness();
		const ack = h.coord.delegate({ role: "qa", handoff_prompt: "go" });
		const out = join(h.root, ".foreman/runs", h.coord.runId, `${ack.task_id}.md`);
		check("stub report exists right after delegate", existsSync(out) && readFileSync(out, "utf8").startsWith(`# ${ack.task_id} RUNNING`));
		const meta = JSON.parse(readFileSync(join(h.root, ".foreman/runs", h.coord.runId, `${ack.task_id}.json`), "utf8"));
		check("meta json records cwd", typeof meta.cwd === "string" && meta.cwd.length > 0);
		h.finish(ack.task_id, ok("final words"));
		await h.coord.whenIdle();
		check("stub is overwritten by the final report", readFileSync(out, "utf8").trim() === "final words");
		h.cleanup();
	}
	{
		const root = mkdtempSync(join(tmpdir(), "foreman-coord-orph-"));
		const dir = join(root, ".foreman/runs/old");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "t1-qa.md"), "# t1-qa RUNNING\n\nstarted: x\n");
		const h = harness({ root });
		h.coord.recover([{ runId: "old", taskId: "t1-qa", role: "qa", state: "running", output: ".foreman/runs/old/t1-qa.md" }]);
		await h.coord.whenIdle();
		const n = h.sent.flatMap((s) => s.message.details.notifications)[0] as any;
		check("recover: stub-only orphan is failed and orphaned, not completed", n.status === "failed" && /orphaned/.test(n.summary));
		h.cleanup();
	}
	{
		const root = mkdtempSync(join(tmpdir(), "foreman-coord-orph2-"));
		const dir = join(root, ".foreman/runs/old");
		mkdirSync(dir, { recursive: true });
		const repo = join(root, "wt");
		mkdirSync(repo);
		execFileSync("git", ["init", "-q"], { cwd: repo });
		writeFileSync(join(repo, "a.txt"), "x");
		writeFileSync(join(repo, "b.txt"), "y");
		writeFileSync(join(dir, "t1-qa.md"), "# t1-qa RUNNING\n");
		writeFileSync(join(dir, "t1-qa.json"), JSON.stringify({ cwd: repo }));
		writeFileSync(
			join(dir, "t1-qa.events.jsonl"),
			[JSON.stringify({ type: "message_end", message: assistant("I was halfway through the migration") })].join("\n") + "\n",
		);
		// no evidence at all for t2
		writeFileSync(join(dir, "t2-qa.md"), "# t2-qa RUNNING\n");
		writeFileSync(join(dir, "t2-qa.json"), JSON.stringify({ cwd: join(root, "gone") }));
		const h = harness({ root });
		h.coord.recover([
			{ runId: "old", taskId: "t1-qa", role: "qa", state: "running", output: ".foreman/runs/old/t1-qa.md" },
			{ runId: "old", taskId: "t2-qa", role: "qa", state: "running", output: ".foreman/runs/old/t2-qa.md" },
		]);
		await h.coord.whenIdle();
		const ns = h.sent.flatMap((s) => s.message.details.notifications) as any[];
		const n1 = ns.find((n) => n.taskId === "t1-qa");
		const n2 = ns.find((n) => n.taskId === "t2-qa");
		check("recover: orphan notification includes last assistant text from events log", n1.status === "failed" && /halfway through the migration/.test(n1.summary));
		check("recover: orphan notification includes git status --short of the worker cwd (temp git repo)", n1.partial === 2 && /partial: 2 changed paths/.test(formatBlock(n1)));
		check("recover: missing cwd or events log degrades to the old message", n2.status === "failed" && n2.summary === "orphaned (orchestrator restarted)" && n2.partial === undefined);
		h.cleanup();
	}
	{
		const root = mkdtempSync(join(tmpdir(), "foreman-coord-seq-"));
		const h = harness({ root });
		h.coord.recover([
			{ runId: "old", taskId: "t7-qa", role: "qa", state: "completed", output: "x" },
			{ runId: "old2", taskId: "t3-planner", role: "planner", state: "completed", output: "y" },
		]);
		const ack = h.coord.delegate({ role: "qa", handoff_prompt: "next" });
		check("seq is seeded from recovered entries so the next task id is higher", ack.task_id === "t8-qa", ack.task_id);
		h.cleanup();
	}

	// Step 12: activity wiring and status.json.
	{
		let clock = 1_000_000;
		const h = harness({ now: () => clock });
		let changes = 0;
		h.coord.onChange(() => changes++);
		const ack = h.coord.delegate({ role: "qa", handoff_prompt: "go" });
		const req = h.workers.get(ack.task_id)!.req;
		const statusPath = join(h.root, ".foreman/runs", h.coord.runId, `${ack.task_id}.status.json`);
		const ev = (i: number) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `x${i}` } });
		const before = changes;
		check("SpawnRequest carries onEvent and onAttempt", typeof req.onEvent === "function" && typeof req.onAttempt === "function");
		check("snapshot: running worker has no activity data yet (renders the old line)", renderWorkersUi(h.coord.snapshot(), clock).widget![0].startsWith("▶ "));
		req.onEvent!(ev(0));
		const sa = h.coord.snapshot().running[0].activity;
		check("snapshot: running worker carries the tracker view", sa?.phase === "reporting" && sa.health === "active" && renderWorkersUi(h.coord.snapshot(), clock).widget![0].startsWith("● "));
		check("status.json is written on the first event", existsSync(statusPath));
		const first = JSON.parse(readFileSync(statusPath, "utf8"));
		check("status.json has view, updated_at and cwd", first.view?.phase === "reporting" && typeof first.updated_at === "string" && typeof first.cwd === "string");
		clock += 500;
		for (let i = 1; i < 50; i++) req.onEvent!(ev(i));
		const second = JSON.parse(readFileSync(statusPath, "utf8"));
		check("status.json is written at most every 2 s (fake clock)", second.updated_at === first.updated_at);
		clock += 2000;
		req.onEvent!(ev(99));
		const third = JSON.parse(readFileSync(statusPath, "utf8"));
		check("status.json rewritten after 2 s", third.updated_at !== first.updated_at);
		check("status.json is atomic: no temp file is left behind", !existsSync(`${statusPath}.tmp`));
		check("no emitChange per event", changes === before);
		check("getTask(id).activity exposes the tracker", h.coord.getTask(ack.task_id)?.activity?.view(clock).phase === "reporting");
		req.onEvent!({ type: "turn_end" });
		req.onAttempt!(1);
		check("tracker resets on retry attempt", h.coord.getTask(ack.task_id)!.activity!.view(clock).turns === 0 && h.coord.getTask(ack.task_id)!.activity!.view(clock).phase === "idle");
		req.onEvent!({ type: "turn_end" });
		clock += 100;
		h.finish(ack.task_id, ok("done"));
		await h.coord.whenIdle();
		const fin = JSON.parse(readFileSync(statusPath, "utf8"));
		check("status.json final write on finish", fin.view.turns === 1 && fin.finished === true, JSON.stringify(fin).slice(0, 200));
		h.cleanup();
	}
	{
		const root = mkdtempSync(join(tmpdir(), "foreman-coord-status-"));
		const dir = join(root, ".foreman/runs/old");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "t1-qa.md"), "# t1-qa RUNNING\n");
		writeFileSync(
			join(dir, "t1-qa.status.json"),
			JSON.stringify({ updated_at: new Date().toISOString(), cwd: root, view: { phase: "tool", label: "npm test", lastEventAt: Date.now() - 42_000, outTokens: 1234, recent: [{ label: "bash npm run build", durationMs: 10, isError: false, at: 1 }] } }),
		);
		writeFileSync(join(dir, "t1-qa.events.jsonl"), JSON.stringify({ type: "message_end", message: assistant("log fallback text") }) + "\n");
		writeFileSync(join(dir, "t2-qa.md"), "# t2-qa RUNNING\n");
		writeFileSync(join(dir, "t2-qa.events.jsonl"), JSON.stringify({ type: "message_end", message: assistant("only the log") }) + "\n");
		const h = harness({ root });
		h.coord.recover([
			{ runId: "old", taskId: "t1-qa", role: "qa", state: "running", output: ".foreman/runs/old/t1-qa.md" },
			{ runId: "old", taskId: "t2-qa", role: "qa", state: "running", output: ".foreman/runs/old/t2-qa.md" },
		]);
		await h.coord.whenIdle();
		const ns = h.sent.flatMap((s) => s.message.details.notifications) as any[];
		const n1 = ns.find((n) => n.taskId === "t1-qa");
		const n2 = ns.find((n) => n.taskId === "t2-qa");
		check("recover reads status.json into the orphan summary", /npm test/.test(n1.summary) && /1234/.test(n1.summary) && /4\ds ago/.test(n1.summary), n1.summary);
		check("recover keeps the events log as fallback without status.json", /only the log/.test(n2.summary) && !/tokens/.test(n2.summary), n2.summary);
		h.cleanup();
	}

	// Phase 14. Stuck and repeating notifications.
	{
		const view = (health: string, over: Record<string, unknown> = {}): any => ({ phase: "tool", label: "npm test", bytes: 0, lastEventAt: 0, turns: 1, toolCalls: 3, outTokens: 10, cost: 0, recent: [], health, denials: 0, lastDenial: "", ...over });
		const snapOf = (health: string, over: Record<string, unknown> = {}): WorkersSnapshot => ({ running: [{ taskId: "t1-qa", role: "qa", planStep: 3, title: "Suite", startedAt: 0, activity: view(health, over) }], queued: 0, finished: [] });
		const w = createHealthWatcher();
		check("health: active worker produces no notice", w.check(snapOf("active"), 1000).length === 0);
		const n1 = w.check(snapOf("silent", { lastEventAt: 1000 }), 100_000);
		check("flip to silent notifies once", n1.length === 1 && n1[0].kind === "stuck" && n1[0].health === "silent");
		check("staying silent does not re-notify", w.check(snapOf("silent"), 101_000).length === 0 && w.check(snapOf("silent"), 300_000).length === 0);
		const n2 = w.check(snapOf("active"), 310_000);
		check("recovery clears the flag and notifies once", n2.length === 1 && n2[0].kind === "recovered" && w.check(snapOf("active"), 311_000).length === 0);
		const n3 = w.check(snapOf("repeating", { recent: [{ label: "bash npm run build --flag", durationMs: 1, isError: true, at: 1 }] }), 400_000);
		check("repeating notifies with the repeated command head", n3.length === 1 && /npm run build/.test(renderStuckNotice(n3[0])), n3.length ? renderStuckNotice(n3[0]) : "none");
		const wf = createHealthWatcher();
		wf.check(snapOf("silent"), 0);
		wf.check(snapOf("active"), 1000);
		check("flapping within 60 s is throttled, then allowed", wf.check(snapOf("silent"), 5000).length === 0 && wf.check(snapOf("silent"), 70_000).length === 1);
		const wl = createHealthWatcher();
		wl.check(snapOf("silent"), 0);
		wl.check({ running: [], queued: 0, finished: [] }, 1000);
		check("a worker that finishes while flagged leaves no state", wl.size() === 0 && wl.check(snapOf("silent"), 2000).length === 1);
		check("stuck notice text is localized in both catalogs", /stuck/i.test(renderStuckNotice(n1[0])) && (process.env.FOREMAN_LANG = "pt-BR", !/\{/.test(renderStuckNotice(n1[0])) && renderStuckNotice(n1[0]) !== (delete process.env.FOREMAN_LANG, renderStuckNotice(n1[0]))));
		delete process.env.FOREMAN_LANG;

		// FOREMAN_STUCK_AFTER_S=0 disables the silent flip; =1 enables it (tracker threshold).
		const savedStuck = process.env.FOREMAN_STUCK_AFTER_S;
		const savedBatch14 = process.env.FOREMAN_BATCH_MS;
		const stuckView = async (secs: string) => {
			process.env.FOREMAN_STUCK_AFTER_S = secs;
			const h = harness();
			h.coord.delegate({ role: "qa", handoff_prompt: "x" });
			await sleep(1300);
			const v = h.coord.snapshot().running[0]?.activity;
			h.finish("t1-qa", ok("done"));
			await h.coord.whenIdle();
			h.cleanup();
			return v;
		};
		const off = await stuckView("0");
		const on = await stuckView("1");
		check("FOREMAN_STUCK_AFTER_S=0 disables the silent flip", off?.health !== "silent");
		check("FOREMAN_STUCK_AFTER_S threshold flips silent", on?.health === "silent", String(on?.health));
		if (savedStuck === undefined) delete process.env.FOREMAN_STUCK_AFTER_S; else process.env.FOREMAN_STUCK_AFTER_S = savedStuck;

		// Integration through index.ts: UI + herdr only, never sendMessage.
		process.env.FOREMAN_STUCK_AFTER_S = "1";
		process.env.FOREMAN_BATCH_MS = "20";
		const herdrCalls: string[][] = [];
		const fakeHerdr = createHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "p1", HERDR_BIN_PATH: "herdr" }, (_b, a) => herdrCalls.push(a));
		const tools: any[] = [];
		const handlers: Record<string, any[]> = {};
		const sentMsgs: any[] = [];
		const workers = new Map<string, (r: WorkerResult) => void>();
		const api: any = {
			events: createEventBus(),
			registerTool: (x: any) => tools.push(x),
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			on: (e: string, hd: any) => ((handlers[e] ??= []).push(hd), () => {}),
			sendMessage: (m: any) => sentMsgs.push(m),
			appendEntry: () => {},
		};
		registerCoordination(api, (req) => {
			let resolve!: (r: WorkerResult) => void;
			const done = new Promise<WorkerResult>((res) => (resolve = res));
			workers.set(req.taskId, resolve);
			return { done, kill: () => resolve({ code: null, signal: "SIGTERM", messages: [], stderr: "" }) };
		}, fakeHerdr);
		const dir = mkdtempSync(join(tmpdir(), "foreman-coord-stuck-"));
		const notes: Array<[string, string]> = [];
		const ctx: any = { cwd: dir, hasUI: true, sessionManager: { getEntries: () => [], getBranch: () => [] }, ui: { setStatus: () => {}, setWidget: () => {}, notify: (m: string, l: string) => notes.push([m, l]) } };
		await handlers.session_start[0]({ reason: "startup" }, ctx);
		api.events.emit(MODE_EVENT, { active: true });
		await tools[0].execute("id", { role: "qa", handoff_prompt: "x" }, undefined, undefined, ctx);
		await sleep(3500);
		const stuckNotes = notes.filter(([m]) => /stuck/i.test(m));
		check("stuck notice reaches the UI as a warning, once", stuckNotes.length === 1 && stuckNotes[0][1] === "warning", JSON.stringify(notes));
		check("herdr.notify is called when herdr is active (fake herdr)", herdrCalls.some((a) => a[0] === "notification" && /stuck/i.test(a.join(" "))), JSON.stringify(herdrCalls));
		check("stuck notice is never sent via sendMessage", sentMsgs.length === 0);
		workers.get("t1-qa")!(ok("x"));
		await sleep(100);
		if (savedStuck === undefined) delete process.env.FOREMAN_STUCK_AFTER_S; else process.env.FOREMAN_STUCK_AFTER_S = savedStuck;
		if (savedBatch14 === undefined) delete process.env.FOREMAN_BATCH_MS; else process.env.FOREMAN_BATCH_MS = savedBatch14;
	}

	// usage in the run json (B4)
	{
		const h = harness();
		const ack = h.coord.delegate({ role: "qa", handoff_prompt: "go" });
		const req = h.workers.get(ack.task_id)!.req;
		const msg = (u: Record<string, unknown>) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }], usage: u } });
		req.onEvent!(msg({ input: 5, output: 7, cacheRead: 11, cacheWrite: 13, cost: { total: 0.5 } }));
		req.onAttempt!(1);
		req.onEvent!(msg({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: { total: 0.25 } }));
		h.finish(ack.task_id, ok("done"));
		await h.coord.whenIdle();
		const meta = JSON.parse(readFileSync(join(h.root, ".foreman/runs", h.coord.runId, `${ack.task_id}.json`), "utf8"));
		const u = meta.usage;
		check("coordinator meta json has usage after finish", !!u && u.input === 6 && u.output === 8 && u.cacheRead === 12 && u.cacheWrite === 14 && u.turns === 2 && u.toolCalls === 2 && u.attempts === 2 && u.cost === 0.75 && u.guardDenials?.total === 0, JSON.stringify(u));
		check("meta json keeps the raw handoff next to usage", meta.handoff_prompt === "go");
	}
	{
		const h = harness();
		const ack = h.coord.delegate({ role: "qa", handoff_prompt: "go" });
		const req = h.workers.get(ack.task_id)!.req;
		const bad = { get type(): string { throw new Error("boom"); } };
		let threw = false;
		try { req.onEvent!(bad); } catch { threw = true; }
		h.finish(ack.task_id, ok("done"));
		await h.coord.whenIdle();
		check("usage feed throwing does not fail the task", !threw && h.sent.length === 1 && /status: completed/.test(h.sent[0].message.content));
	}

	// Step 7 (C1): circuit breaker, advisory text in the delegate ack.
	{
		const blocked = (why: string) =>
			ok(`--- foreman-report ---\nStatus: blocked\nSummary: s\nFiles: none\nRulings: none\nBlocked-on: ${why}\n--- end foreman-report ---`);
		const failedRes = (): WorkerResult => ({ code: 1, signal: null, messages: [], stderr: "boom" });
		const attempt = async (h: ReturnType<typeof harness>, step: number | undefined, res: WorkerResult, slug: string | undefined = "cb") => {
			const a = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "go", ...(step !== undefined ? { plan_step: step } : {}), ...(slug ? { plan_slug: slug } : {}) });
			h.finish(a.task_id, res);
			await h.coord.whenIdle();
			return a;
		};
		const next = (h: ReturnType<typeof harness>, step: number | undefined) => {
			const a = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "again", ...(step !== undefined ? { plan_step: step } : {}), plan_slug: "cb" });
			h.finish(a.task_id, ok("done"));
			return a.ack;
		};
		{
			const h = harness();
			const a1 = (await attempt(h, 3, blocked("needs root"))).ack;
			const a2 = (await attempt(h, 3, blocked("needs sudo"))).ack;
			check("attempts 1 and 2 of a blocked step carry no warning", !/Attempt/.test(a1) && !/Attempt/.test(a2));
			const a3 = next(h, 3);
			check("3rd dispatch after two blocked outcomes warns with both reasons", /Attempt 3 for step 3/.test(a3) && /needs root/.test(a3) && /needs sudo/.test(a3) && /rule on it/.test(a3) && /END YOUR TURN/.test(a3), a3);
			check("differing reasons are not flagged identical", !/identical/.test(a3));
			h.cleanup();
		}
		{
			const h = harness();
			await attempt(h, 2, failedRes());
			await attempt(h, 2, blocked("x"));
			check("failed plus blocked counts", /Attempt 3 for step 2/.test(next(h, 2)));
			h.cleanup();
		}
		{
			const h = harness();
			await attempt(h, 1, blocked("a"));
			await attempt(h, 1, ok("all good"));
			await attempt(h, 1, blocked("b"));
			check("a completed attempt resets the count", !/Attempt/.test(next(h, 1)));
			h.cleanup();
		}
		{
			const h = harness();
			await attempt(h, 1, blocked("a"));
			await attempt(h, 2, blocked("a"));
			check("different plan steps are tracked separately", !/Attempt/.test(next(h, 1)) && !/Attempt/.test(next(h, 2)));
			h.cleanup();
		}
		{
			const h = harness();
			await attempt(h, undefined, blocked("a"), undefined);
			await attempt(h, undefined, blocked("a"), undefined);
			const a = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "x" });
			check("no plan_step never warns", !/Attempt/.test(a.ack));
			h.cleanup();
		}
		{
			const h = harness();
			await attempt(h, 4, blocked("same  thing"));
			await attempt(h, 4, blocked("same thing"));
			check("identical reasons are flagged", /The last two reasons are identical\./.test(next(h, 4)));
			h.cleanup();
		}
		{
			const h = harness();
			await attempt(h, 5, blocked("a"));
			await attempt(h, 5, blocked("b"));
			const ab = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "x", plan_step: 5, plan_slug: "cb" });
			await h.coord.abortAll();
			await h.coord.whenIdle();
			const after = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "y", plan_step: 5, plan_slug: "cb" });
			check("aborted outcomes are ignored", /Attempt 3 for step 5/.test(ab.ack) && /Attempt 3 for step 5/.test(after.ack) && !/aborted/.test(after.ack), after.ack);
			h.cleanup();
		}
		{
			const h = harness();
			await attempt(h, 6, blocked("r1"));
			await attempt(h, 6, blocked("r2"));
			const entries = h.entries.filter((e) => e.customType === "foreman-task").map((e) => e.data);
			check("finish persists blockedOn", entries.some((e) => e.state === "blocked" && e.blockedOn === "r2"));
			const h2 = harness();
			h2.coord.recover(entries);
			const a = h2.coord.delegate({ role: "plan-step-builder", handoff_prompt: "z", plan_step: 6, plan_slug: "cb" });
			check("recover() seeds history so a resumed session warns on its first re-dispatch", /Attempt 3 for step 6/.test(a.ack) && /r1/.test(a.ack) && /r2/.test(a.ack), a.ack);
			h.cleanup();
			h2.cleanup();
		}
	}

	// Step 8 (A8): report size hint.
	{
		const lineCount = (f: string) => { const t = readFileSync(f, "utf8"); return t === "" ? 0 : t.replace(/\n$/, "").split("\n").length; };
		{
			const h = harness();
			const a = h.coord.delegate({ role: "qa", handoff_prompt: "x" });
			h.finish(a.task_id, ok("line one\nline two\nline three"));
			await h.coord.whenIdle();
			const n = h.sent[0].message.details.notifications[0];
			const outFile = join(h.root, n.output);
			check("completed notification has report: N lines equal to the output file", n.reportLines === lineCount(outFile) && n.reportLines === 3 && h.sent[0].message.content.includes("report: 3 lines"));
			check("report line sits right after output:", new RegExp(`output: ${n.output.replace(/[.]/g, "\\.")}\\nreport: 3 lines\\n`).test(h.sent[0].message.content));
			h.cleanup();
		}
		{
			const h = harness();
			const a = h.coord.delegate({ role: "qa", handoff_prompt: "x" });
			h.finish(a.task_id, { code: 2, signal: null, messages: [assistant("partial work")], stderr: "boom" });
			await h.coord.whenIdle();
			const n = h.sent[0].message.details.notifications[0];
			check("failed body is counted", n.status === "failed" && n.reportLines === lineCount(join(h.root, n.output)) && n.reportLines > 1);
			h.cleanup();
		}
		{
			const h = harness();
			const oldRun = "old-run";
			const dir = join(h.root, ".foreman/runs", oldRun);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "t1-qa.md"), "Recovered a\nRecovered b\n");
			writeFileSync(join(dir, "t2-qa.md"), "# t2-qa RUNNING\nstub\n");
			const entries = [1, 2, 3].map((i) => ({ runId: oldRun, taskId: `t${i}-qa`, role: "qa", state: "running", planStep: i, output: `.foreman/runs/${oldRun}/t${i}-qa.md` }));
			h.coord.recover(entries);
			await h.coord.whenIdle();
			const ns = h.sent[0].message.details.notifications as any[];
			check("recovered notification counts an existing report, none for a stub or missing file", ns.find((n) => n.taskId === "t1-qa")?.reportLines === 2 && ns.find((n) => n.taskId === "t3-qa")?.reportLines === undefined && ns.find((n) => n.taskId === "t2-qa")?.reportLines === undefined);
			h.cleanup();
		}
		{
			const base = { taskId: "t1-qa", role: "qa", status: "completed" as const, summary: "s", output: ".foreman/runs/r/t1-qa.md" };
			check("formatBlock omits the line when unknown", !formatBlock(base).includes("report:"));
			check("formatBlock prints report line when known", formatBlock({ ...base, reportLines: 7 }).includes("output: .foreman/runs/r/t1-qa.md\nreport: 7 lines\n"));
		}
	}


	// C6: coordinator-side verification of the step's declared Checks (fake verifier; lib/verify-checks-test.ts covers the runner).
	{
		const mkPlan = (root: string) => {
			mkdirSync(join(root, "docs", "plans"), { recursive: true });
			writeFileSync(join(root, "docs", "plans", "p.md"), "1. **X** (Touches: a)\n   - Checks: `npm run t`\n");
		};
		const fakeVerify = () => {
			const calls: any[] = [];
			let killed = 0;
			let release!: (r: any) => void;
			const verify = (o: any) => {
				calls.push(o);
				const done = new Promise<any>((res) => (release = res));
				return { done, kill: () => { killed++; release({ verified: "n/a", note: "killed" }); } };
			};
			return { verify, calls, killed: () => killed, release: (r: any) => release(r) };
		};
		const savedVerify = process.env.FOREMAN_VERIFY_CHECKS;
		delete process.env.FOREMAN_VERIFY_CHECKS;
		const go = (h: ReturnType<typeof harness>, role = "plan-step-builder") => h.coord.delegate({ role, handoff_prompt: "x", plan_step: 1, plan_slug: "p" }).task_id;
		{
			const f = fakeVerify();
			const h = harness({ verify: f.verify });
			mkPlan(h.root);
			const id = go(h);
			h.finish(id, ok("built it"));
			await sleep(100);
			check("notification waits for verification and idle waiters wait too", h.sent.length === 0 && f.calls.length === 1);
			let idle = false;
			void h.coord.whenIdle().then(() => (idle = true));
			await sleep(50);
			check("idle waiters wait for verification", !idle && h.sent.length === 0);
			f.release({ verified: "yes" });
			await h.coord.whenIdle();
			check("exit 0 verification adds verified: yes and runs in the root", h.sent.length === 1 && h.sent[0].message.content.includes("\nverified: yes\n") && f.calls[0].cwd === h.root && f.calls[0].step === 1 && f.calls[0].planText.includes("npm run t"));
			h.cleanup();
		}
		{
			const f = fakeVerify();
			const h = harness({ verify: f.verify });
			mkPlan(h.root);
			const id = go(h);
			h.finish(id, ok("built it"));
			await sleep(30);
			f.release({ verified: "no", note: "FAIL npm:t (.foreman/qa-logs/npm_t.log)" });
			await h.coord.whenIdle();
			const n = h.sent[0].message.details.notifications[0];
			check("a no never changes status; note is printed", n.status === "completed" && h.sent[0].message.content.includes("verified: no — FAIL npm:t"));
			h.cleanup();
		}
		{
			const f = fakeVerify();
			const h = harness({ verify: () => { throw new Error("boom"); } });
			mkPlan(h.root);
			h.finish(go(h), ok("built it"));
			await h.coord.whenIdle();
			check("a throwing verifier yields n/a and the notification still goes out", h.sent.length === 1 && /verified: n\/a/.test(h.sent[0].message.content));
			h.cleanup();
			void f;
		}
		{
			const f = fakeVerify();
			const h = harness({ verify: f.verify });
			mkPlan(h.root);
			const a = go(h);
			const b = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "y", plan_step: 1, plan_slug: "p" }).task_id;
			h.finish(a, ok("built it"));
			await sleep(60);
			check("concurrent writer running gives n/a", f.calls.length === 0 && /verified: n\/a — another writer is running/.test(h.sent[0]?.message.content ?? ""));
			h.finish(b, ok("done"));
			await sleep(60);
			check("verification runs once no other writer is running", f.calls.length === 1);
			f.release({ verified: "yes" });
			await sleep(30);
			h.cleanup();
		}
		{
			const f = fakeVerify();
			const h = harness({ verify: f.verify });
			mkPlan(h.root);
			h.finish(go(h, "qa"), ok("qa green"));
			h.finish(go(h), { code: 1, signal: null, messages: [], stderr: "bad" });
			h.finish(go(h), ok("--- foreman-report ---\nStatus: blocked\nSummary: s\nFiles: none\nRulings: none\nBlocked-on: root\n--- end foreman-report ---"));
			await h.coord.whenIdle();
			check("other roles and non-completed statuses are not verified", f.calls.length === 0 && h.sent.every((s) => !s.message.content.includes("verified:")));
			h.cleanup();
		}
		{
			const f = fakeVerify();
			const h = harness({ verify: f.verify });
			mkPlan(h.root);
			const id = h.coord.delegate({ role: "plan-step-builder", handoff_prompt: "x" }).task_id;
			h.finish(id, ok("built it"));
			await h.coord.whenIdle();
			check("no plan_step or slug means no verified line", f.calls.length === 0 && !h.sent[0].message.content.includes("verified:"));
			h.cleanup();
		}
		{
			process.env.FOREMAN_VERIFY_CHECKS = "off";
			const f = fakeVerify();
			const h = harness({ verify: f.verify });
			mkPlan(h.root);
			h.finish(go(h), ok("built it"));
			await h.coord.whenIdle();
			check("FOREMAN_VERIFY_CHECKS=off skips", f.calls.length === 0 && !h.sent[0].message.content.includes("verified:"));
			h.cleanup();
			delete process.env.FOREMAN_VERIFY_CHECKS;
		}
		{
			const f = fakeVerify();
			const h = harness({ verify: f.verify });
			mkPlan(h.root);
			h.finish(go(h), ok("built it"));
			await sleep(60);
			h.coord.shutdown();
			await sleep(60);
			check("shutdown during verification kills the child and sends nothing", f.killed() === 1 && h.sent.length === 0);
			h.cleanup();
		}
		{
			const base = { taskId: "t1-plan-step-builder", role: "plan-step-builder", status: "completed" as const, summary: "s", output: ".foreman/runs/r/t1.md" };
			check("verified: line appears in formatBlock", formatBlock({ ...base, verified: "yes" }).includes("\nverified: yes\n") && formatBlock({ ...base, verified: "no", verifiedNote: "FAIL x" }).includes("\nverified: no — FAIL x\n") && !formatBlock(base).includes("verified:"));
		}
		if (savedVerify !== undefined) process.env.FOREMAN_VERIFY_CHECKS = savedVerify;
	}

	if (savedSubagentEnv !== undefined) process.env.FOREMAN_PI_SUBAGENT = savedSubagentEnv;
	if (savedModeEnv !== undefined) process.env.FOREMAN_PI_MODE = savedModeEnv;

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main();
