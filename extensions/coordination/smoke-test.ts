/**
 * Smoke test for extensions/coordination, run with:
 *   npx tsx extensions/coordination/smoke-test.ts
 *
 * Drives createCoordinator with a fake spawner (no real `pi` processes) and a
 * fake ExtensionAPI for the wiring in index.ts. See live-rpc.ts for the real
 * end-to-end check.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT, composeWorkerPrompt, discoverAgents } from "../../lib/agents.ts";
import { t } from "../../lib/i18n.ts";
import { MODE_EVENT } from "../../lib/mode.ts";
import { ROLES as SHARED_ROLES } from "../../lib/roles.ts";
import { GLYPHS, WORKERS_ABORT_EVENT, WORKERS_EVENT, renderReport, renderWorkersUi, type WorkersSnapshot } from "../../lib/workers.ts";
import extension, { buildDetails, callText, registerCoordination } from "./index.ts";
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

function harness(opts: { maxWorkers?: number; timeoutMs?: number; active?: boolean; root?: string } = {}) {
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
			running: [{ taskId: "t2-backend-dev", role: "backend-dev", planStep: 3, startedAt: now - 65_000 }, { taskId: "t3-qa", role: "qa", startedAt: now - 4_000 }],
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
		check("render: running line has role, step and elapsed time", en.widget!.some((l) => l.includes("t2-backend-dev (backend-dev) · step 3 · 1m05s")) && en.widget!.some((l) => l.includes("t3-qa (qa) · 4s")));
		check("render: queued count and last finished with glyphs", en.widget!.some((l) => l.includes("2 queued")) && en.widget!.some((l) => l.includes(`${GLYPHS.completed} t1-planner`)) && en.widget!.some((l) => l.includes(`${GLYPHS.failed} t0-qa`)) && en.widget!.some((l) => l.includes(`${GLYPHS.blocked} t9-qa`)) && !en.widget!.some((l) => l.includes("t8-qa")));
		check("render: status text", en.status === "workers: 2 running, 2 queued", en.status);
		check("render: pt-BR differs and is Portuguese", pt.status === "workers: 2 em execução, 2 na fila" && pt.widget![0] !== en.widget![0] && pt.widget!.some((l) => l.includes("etapa 3")) && pt.widget!.some((l) => l.includes("2 na fila")) && pt.widget!.some((l) => l.includes("falhou")));
		check("render: report mentions mode, source, workers in both locales", /Orchestrator mode: on \(session entry\)/.test(en.rep) && /Modo orquestrador: ativado \(entrada da sessão\)/.test(pt.rep) && en.rep !== pt.rep);
		check("render: no raw placeholders", ![en.status!, pt.status!, ...en.widget!, ...pt.widget!, en.rep, pt.rep].some((x) => /\{\w+\}/.test(x)));
		const none = renderReport(empty, { active: false, source: "default" }, now);
		check("report: empty state says nothing ran", none.includes(t("report.none")) && /off \(default\)/.test(none));
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
		check("ui: widget lists the running worker", !!calls.widget.at(-1)?.some((l) => l.includes("t1-qa (qa) · step 2")));

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
		check("ui: failed worker shown with its glyph next to the running one", !!calls.widget.at(-1)?.some((l) => l.includes(`${GLYPHS.failed} t2-qa`)) && !!calls.widget.at(-1)?.some((l) => l.includes("t3-qa")));

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
		check("compose: {{PACKAGE_ROOT}} also substituted in the agent body", composeWorkerPrompt({ systemPrompt: "see {{PACKAGE_ROOT}}/x" }).includes(`see ${PACKAGE_ROOT}/x`));
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
