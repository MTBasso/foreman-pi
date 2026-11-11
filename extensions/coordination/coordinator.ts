/**
 * Coordinator — pure logic behind `foreman_delegate`.
 *
 * No pi imports: everything that touches the outside world is injected
 * (spawn, sendMessage, appendEntry, clock, filesystem root), so the smoke test
 * can drive it with a fake spawner and a fake clock-free harness.
 *
 * Flow: delegate() writes run metadata, spawns (or queues) a worker and returns
 * synchronously. When workers finish, completions are debounced and delivered
 * as ONE `foreman-task-notification` custom message holding N
 * `<task-notification>` blocks. The ledger is appended (sync) before delivery.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FinishedState, WorkersSnapshot } from "../../lib/workers.ts";

export const ROLES = [
	"planner",
	"frontend-dev",
	"backend-dev",
	"qa",
	"qa-bugfix",
	"release-manager",
	"plan-step-builder",
	"codebase-auditor",
] as const;
export type Role = (typeof ROLES)[number];

export const NOTIFICATION_CUSTOM_TYPE = "foreman-task-notification";
export const TASK_ENTRY_TYPE = "foreman-task";

export type TaskStatus = "completed" | "failed" | "blocked";
export type TaskState = "queued" | "running" | TaskStatus | "aborted";

export interface DelegateInput {
	role: string;
	handoff_prompt: string;
	plan_step?: number;
	plan_slug?: string;
}

export interface SpawnRequest {
	taskId: string;
	role: Role;
	prompt: string;
	cwd: string;
	/** Absolute dir for this run; spawner may write oversized prompts here. */
	runDir: string;
	model?: string;
	thinkingLevel?: string;
}

export interface WorkerResult {
	code: number | null;
	signal: string | null;
	/** Child's message_end messages (assistant/user/toolResult), loosely typed. */
	messages: any[];
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	spawnError?: string;
}

export interface WorkerHandle {
	done: Promise<WorkerResult>;
	kill(): void;
	/** Model/thinking the spawner chose (undefined model = inherited session model). Recorded in the task meta. */
	chosen?: { model?: string; thinking?: string };
}

/** How well the worker's final report followed the `--- foreman-report ---` contract. */
export type ReportContract = "ok" | "missing" | "malformed";

export interface Notification {
	taskId: string;
	role: string;
	status: TaskStatus;
	planStep?: number;
	planSlug?: string;
	summary: string;
	/** Path relative to the project root. */
	output: string;
	/** From the worker's report block; absent when the contract was not met. */
	files?: string[];
	rulings?: string[];
	blockedOn?: string;
	contract?: ReportContract;
}

export interface SendOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface CoordinatorDeps {
	/** Project root (orchestrator cwd). */
	root: string;
	spawn(req: SpawnRequest): WorkerHandle;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details: unknown },
		options: SendOptions,
	): void;
	appendEntry(customType: string, data: unknown): void;
	now?: () => number;
	isOrchestratorActive?: () => boolean;
	maxWorkers?: number;
	batchMs?: number;
	timeoutMs?: number;
	/** Test hook: deterministic run id. */
	runId?: string;
}

export interface DelegateAck {
	task_id: string;
	run_id: string;
	state: "running" | "queued";
	ack: string;
}

interface Task {
	taskId: string;
	role: Role;
	prompt: string;
	planStep?: number;
	planSlug?: string;
	state: TaskState;
	model?: string;
	thinkingLevel?: string;
	chosen?: { model?: string; thinking?: string };
	handle?: WorkerHandle;
	timer?: ReturnType<typeof setTimeout>;
	timedOut?: boolean;
	killedByShutdown?: boolean;
	/** Aborted on request (/foreman off): no notification is sent for it. */
	aborted?: boolean;
	startedAt?: number;
	finishedAt?: number;
}

interface Batch {
	batchId: string;
	notifications: Notification[];
	attempts: number;
}

/** Finished workers kept in a snapshot (newest first). */
const SNAPSHOT_FINISHED_MAX = 5;
const SUMMARY_MAX = 400;
const LEDGER_SUMMARY_MAX = 200;

export function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function collapse(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function safeSlug(slug: string): string {
	return slug.replace(/[^\w.-]+/g, "_");
}

/** Text of the last assistant message that has any text. */
export function finalReport(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = m.content
			.filter((p: any) => p?.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/** [BLOCKED] iff the first non-empty line of the report starts with it. */
export function isBlockedReport(report: string): boolean {
	const first = report.split("\n").find((l) => l.trim() !== "");
	return first !== undefined && first.trim().startsWith("[BLOCKED]");
}

export function summarize(report: string): string {
	const stripped = isBlockedReport(report) ? report.replace(/^\s*\[BLOCKED\]:?/, "") : report;
	return truncate(collapse(stripped), SUMMARY_MAX);
}

export interface ParsedReport {
	/** Undefined only when the report is empty. */
	status: TaskStatus | undefined;
	summary: string;
	files: string[];
	rulings: string[];
	blockedOn: string;
	contract: ReportContract;
}

const BLOCK_START = /^[ \t]*(?:>[ \t]*)?-{3}[ \t]*foreman-report[ \t]*-{3}[ \t]*$/i;
const BLOCK_END = /^[ \t]*(?:>[ \t]*)?-{3}[ \t]*end[ \t]+foreman-report[ \t]*-{3}[ \t]*$/i;
// English keywords only: localized keys ("Estado:", "Resumo:") are never labels.
const FIELD_LABEL = /^[ \t]*(status|summary|files|rulings|blocked-on)[ \t]*:(.*)$/i;
const NONE = /^(none|-|n\/a)?$/i;

interface BlockCandidate {
	lines: string[];
	terminated: boolean;
}

function parseBlockBody(lines: string[]): Omit<ParsedReport, "contract"> | undefined {
	const fields: Record<string, string[]> = {};
	let current: string | undefined;
	for (const line of lines) {
		const m = FIELD_LABEL.exec(line);
		if (m) {
			current = m[1].toLowerCase();
			fields[current] = [m[2]];
		} else if (current) {
			fields[current].push(line);
		}
	}
	const value = (k: string) => (fields[k] ?? []).join("\n").trim();
	const status = value("status").toLowerCase();
	if (status !== "completed" && status !== "failed" && status !== "blocked") return undefined;
	const files = value("files")
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter((s) => !NONE.test(s));
	const rulings = value("rulings")
		.split("\n")
		.map((s) => s.trim().replace(/^[-*]\s+/, ""))
		.filter((s) => !NONE.test(s));
	const blockedOn = value("blocked-on");
	return {
		status,
		summary: collapse(value("summary")),
		files,
		rulings,
		blockedOn: NONE.test(blockedOn) ? "" : blockedOn,
	};
}

/**
 * Parse a worker's final report. Pure and language-agnostic: only the English
 * field names and Status values are keywords (case-insensitive); prose in any
 * language inside the fields is never interpreted.
 *
 * Chain: last well-formed block wins; else a legacy `[BLOCKED]` first line
 * means blocked; else a non-empty report is completed with `contract` missing
 * (or malformed when a block was present but unusable).
 */
export function parseFinalBlock(report: string): ParsedReport {
	const text = report.replace(/\r\n?/g, "\n");
	const candidates: BlockCandidate[] = [];
	let open: BlockCandidate | undefined;
	for (const line of text.split("\n")) {
		if (BLOCK_END.test(line)) {
			if (open) {
				open.terminated = true;
				candidates.push(open);
				open = undefined;
			}
		} else if (BLOCK_START.test(line)) {
			if (open) candidates.push(open);
			open = { lines: [], terminated: false };
		} else if (open) {
			open.lines.push(line);
		}
	}
	if (open) candidates.push(open);

	let sawMalformed = false;
	for (let i = candidates.length - 1; i >= 0; i--) {
		const c = candidates[i];
		const parsed = c.terminated ? parseBlockBody(c.lines) : undefined;
		if (parsed) return { ...parsed, contract: "ok" };
		sawMalformed = true;
	}

	const contract: ReportContract = sawMalformed ? "malformed" : "missing";
	if (!text.trim()) return { status: undefined, summary: "", files: [], rulings: [], blockedOn: "", contract };
	const status: TaskStatus = isBlockedReport(text) ? "blocked" : "completed";
	return { status, summary: summarize(text), files: [], rulings: [], blockedOn: "", contract };
}

export function formatBlock(n: Notification): string {
	return [
		"<task-notification>",
		`task-id: ${n.taskId}`,
		`role: ${n.role}`,
		`status: ${n.status}`,
		`plan-step: ${n.planStep ?? "-"}`,
		`summary: ${n.summary}`,
		`output: ${n.output}`,
		...(n.contract === "missing" || n.contract === "malformed" ? [`report-contract: ${n.contract}`] : []),
		"</task-notification>",
	].join("\n");
}

export function createCoordinator(deps: CoordinatorDeps) {
	const now = deps.now ?? Date.now;
	const maxWorkers = Math.max(1, deps.maxWorkers ?? envInt("FOREMAN_MAX_WORKERS", 4));
	const batchMs = deps.batchMs ?? envInt("FOREMAN_BATCH_MS", 300);
	const timeoutMs = deps.timeoutMs ?? envInt("FOREMAN_WORKER_TIMEOUT_MS", 30 * 60 * 1000);
	const isActive = deps.isOrchestratorActive ?? (() => true);

	const runId =
		deps.runId ?? `${new Date(now()).toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${Math.random().toString(36).slice(2, 8)}`;
	const runRel = join(".foreman", "runs", runId);
	const runDir = join(deps.root, runRel);

	const tasks = new Map<string, Task>();
	const queue: Task[] = [];
	let seq = 0;
	let running = 0;
	let planSlug: string | undefined;
	let busy = false;
	let stopped = false;
	let batchSeq = 0;

	const changeListeners = new Set<() => void>();
	function emitChange() {
		for (const cb of [...changeListeners]) {
			try {
				cb();
			} catch {
				// UI/bus listeners must never break scheduling
			}
		}
	}

	let pending: Notification[] = [];
	let batchTimer: ReturnType<typeof setTimeout> | undefined;
	const inflight = new Map<string, Batch>();
	const idleWaiters: Array<() => void> = [];

	const outputRel = (taskId: string) => join(runRel, `${taskId}.md`);
	const metaPath = (taskId: string) => join(runDir, `${taskId}.json`);

	function ensureRunDir() {
		mkdirSync(runDir, { recursive: true });
		const runJson = join(runDir, "run.json");
		if (!existsSync(runJson)) {
			writeFileSync(runJson, JSON.stringify({ run_id: runId, started_at: new Date(now()).toISOString() }, null, 2));
		}
	}

	function writeRunJson() {
		writeFileSync(
			join(runDir, "run.json"),
			JSON.stringify({ run_id: runId, plan_slug: planSlug ?? null, updated_at: new Date(now()).toISOString() }, null, 2),
		);
	}

	function writeMeta(t: Task, extra: Record<string, unknown> = {}) {
		writeFileSync(
			metaPath(t.taskId),
			JSON.stringify(
				{
					task_id: t.taskId,
					run_id: runId,
					role: t.role,
					plan_step: t.planStep ?? null,
					plan_slug: t.planSlug ?? null,
					state: t.state,
					handoff_prompt: t.prompt,
					output: outputRel(t.taskId),
					...(t.chosen ? { model: t.chosen.model ?? null, thinking: t.chosen.thinking ?? null } : {}),
					updated_at: new Date(now()).toISOString(),
					...extra,
				},
				null,
				2,
			),
		);
	}

	function persist(t: Task, extra: Record<string, unknown> = {}) {
		deps.appendEntry(TASK_ENTRY_TYPE, {
			runId,
			taskId: t.taskId,
			role: t.role,
			planStep: t.planStep,
			planSlug: t.planSlug,
			state: t.state,
			output: outputRel(t.taskId),
			...extra,
		});
	}

	function checkIdle() {
		if (running === 0 && queue.length === 0 && pending.length === 0 && !batchTimer) {
			for (const w of idleWaiters.splice(0)) w();
		}
	}

	function startTask(t: Task) {
		running++;
		t.state = "running";
		t.startedAt = now();
		writeMeta(t, { started_at: new Date(now()).toISOString() });
		let handle: WorkerHandle;
		try {
			handle = deps.spawn({
				taskId: t.taskId,
				role: t.role,
				prompt: t.prompt,
				cwd: deps.root,
				runDir,
				model: t.model,
				thinkingLevel: t.thinkingLevel,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			handle = {
				kill() {},
				done: Promise.resolve({ code: null, signal: null, messages: [], stderr: "", spawnError: message }),
			};
		}
		t.handle = handle;
		if (handle.chosen) {
			t.chosen = handle.chosen;
			try {
				writeMeta(t, { started_at: new Date(now()).toISOString() });
			} catch {
				// meta is best-effort here; finishTask rewrites it
			}
		}
		if (timeoutMs > 0) {
			t.timer = setTimeout(() => {
				t.timedOut = true;
				handle.kill();
			}, timeoutMs);
			t.timer.unref?.();
		}
		handle.done.then(
			(r) => finishTask(t, r),
			(e) =>
				finishTask(t, {
					code: null,
					signal: null,
					messages: [],
					stderr: "",
					spawnError: e instanceof Error ? e.message : String(e),
				}),
		);
		persist(t);
		emitChange();
	}

	function pump() {
		while (!stopped && running < maxWorkers && queue.length > 0) {
			startTask(queue.shift()!);
		}
	}

	function finishTask(t: Task, r: WorkerResult) {
		if (t.timer) clearTimeout(t.timer);
		running--;
		if (stopped || t.killedByShutdown || t.aborted) {
			checkIdle();
			emitChange();
			return;
		}
		t.finishedAt = now();

		const report = finalReport(r.messages);
		let status: TaskStatus;
		let error: string | undefined;
		let parsed: ParsedReport | undefined;
		if (t.timedOut) {
			status = "failed";
			error = `timed out after ${timeoutMs}ms`;
		} else if (r.spawnError) {
			status = "failed";
			error = `failed to spawn worker: ${r.spawnError}`;
		} else if (r.signal) {
			status = "failed";
			error = `terminated by signal ${r.signal}`;
		} else if (r.code !== 0) {
			status = "failed";
			error = `exited with code ${r.code}`;
		} else if (r.stopReason === "error" || r.stopReason === "aborted") {
			status = "failed";
			error = r.errorMessage || `stop reason: ${r.stopReason}`;
		} else if (!report) {
			status = "failed";
			error = "(no output)";
		} else {
			parsed = parseFinalBlock(report);
			status = parsed.status ?? "completed";
			if (status === "failed") error = "worker reported Status: failed";
		}

		let body: string;
		if (status === "failed") {
			body = [
				`# ${t.taskId} FAILED`,
				"",
				`error: ${error}`,
				r.errorMessage && r.errorMessage !== error ? `stop-error: ${r.errorMessage}` : "",
				"",
				"## stderr",
				r.stderr.trim() || "(empty)",
				"",
				"## partial output",
				report || "(no output)",
				"",
			]
				.filter((l, i, a) => !(l === "" && a[i - 1] === ""))
				.join("\n");
		} else {
			body = `${report}\n`;
		}
		try {
			writeFileSync(join(deps.root, outputRel(t.taskId)), body);
		} catch {
			// Output file is best effort; the notification still goes out.
		}

		const fromContract = parsed?.contract === "ok";
		const summary = fromContract
			? truncate(parsed!.summary || collapse(report), SUMMARY_MAX)
			: status === "failed"
				? truncate(collapse(`${error}${report ? ` — ${report}` : r.stderr ? ` — ${r.stderr}` : ""}`), SUMMARY_MAX)
				: parsed?.summary ?? summarize(report);
		const contractInfo = parsed
			? { files: parsed.files, rulings: parsed.rulings, blockedOn: parsed.blockedOn, contract: parsed.contract }
			: {};
		t.state = status;
		try {
			writeMeta(t, {
				finished_at: new Date(now()).toISOString(),
				exit_code: r.code,
				signal: r.signal,
				error: error ?? null,
				summary,
				...contractInfo,
			});
		} catch {
			// ignore
		}
		persist(t, { summary });

		pending.push({
			taskId: t.taskId,
			role: t.role,
			status,
			planStep: t.planStep,
			planSlug: t.planSlug,
			summary,
			output: outputRel(t.taskId),
			...contractInfo,
		});
		scheduleFlush();
		pump();
		checkIdle();
		emitChange();
	}

	function scheduleFlush() {
		if (batchTimer) clearTimeout(batchTimer);
		batchTimer = setTimeout(() => {
			batchTimer = undefined;
			flush();
		}, batchMs);
	}

	function writeLedger(notifications: Notification[]) {
		const stamp = new Date(now()).toISOString();
		for (const n of notifications) {
			const line = `${stamp} — step ${n.planStep ?? "-"} ${n.status} — ${n.role} — ${truncate(n.summary, LEDGER_SUMMARY_MAX)} — ${n.output}\n`;
			try {
				appendFileSync(join(runDir, "ledger.log"), line);
				if (n.planSlug) {
					const dir = join(deps.root, ".foreman", "plan-runner", safeSlug(n.planSlug));
					mkdirSync(dir, { recursive: true });
					appendFileSync(join(dir, "progress.md"), line);
				}
			} catch {
				// Ledger is best effort; never block delivery.
			}
		}
	}

	function deliver(batch: Batch) {
		const content = batch.notifications.map(formatBlock).join("\n\n");
		const opts: SendOptions = busy ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: true };
		// Idle delivery starts a run; mark busy now so a second flush before the
		// agent_start event arrives queues as followUp instead of racing.
		if (!busy) busy = true;
		batch.attempts++;
		inflight.set(batch.batchId, batch);
		deps.sendMessage(
			{
				customType: NOTIFICATION_CUSTOM_TYPE,
				content,
				display: true,
				details: { batchId: batch.batchId, notifications: batch.notifications },
			},
			opts,
		);
	}

	function flush() {
		if (batchTimer) {
			clearTimeout(batchTimer);
			batchTimer = undefined;
		}
		if (stopped || pending.length === 0) {
			checkIdle();
			return;
		}
		const notifications = pending;
		pending = [];
		writeLedger(notifications);
		deliver({ batchId: `${runId}-b${++batchSeq}`, notifications, attempts: 0 });
		checkIdle();
	}

	function delegate(
		input: DelegateInput,
		opts: { model?: string; thinkingLevel?: string } = {},
	): DelegateAck {
		if (!isActive()) {
			throw new Error("foreman_delegate is only available in orchestrator mode: not in orchestrator mode, ask the user to run /foreman.");
		}
		if (!(ROLES as readonly string[]).includes(input.role)) {
			throw new Error(`Unknown role "${input.role}". Valid roles: ${ROLES.join(", ")}.`);
		}
		if (typeof input.handoff_prompt !== "string" || input.handoff_prompt.trim() === "") {
			throw new Error("handoff_prompt must be a non-empty string.");
		}
		stopped = false;
		ensureRunDir();
		const slug = input.plan_slug?.trim();
		if (!planSlug && slug) {
			planSlug = slug;
			writeRunJson();
		}
		const taskId = `t${++seq}-${input.role}`;
		const t: Task = {
			taskId,
			role: input.role as Role,
			prompt: input.handoff_prompt,
			planStep: typeof input.plan_step === "number" ? input.plan_step : undefined,
			planSlug: slug || planSlug,
			state: "queued",
			model: opts.model,
			thinkingLevel: opts.thinkingLevel,
		};
		tasks.set(taskId, t);
		writeMeta(t, { created_at: new Date(now()).toISOString() });
		if (running < maxWorkers) startTask(t);
		else {
			queue.push(t);
			persist(t);
			emitChange();
		}
		const state = t.state === "running" ? "running" : "queued";
		return {
			task_id: taskId,
			run_id: runId,
			state,
			ack:
				`Dispatched ${taskId} (${state}). END YOUR TURN now: you will be woken with a <task-notification> ` +
				`when it finishes (full report at ${outputRel(taskId)}). Do not poll or wait.`,
		};
	}

	/** Orchestrator run started (agent_start). */
	function onAgentStart() {
		busy = true;
	}

	/**
	 * Orchestrator settled (agent_settled). `deliveredBatchIds` are the batches
	 * visible in the session as custom messages; any inflight batch not among
	 * them was lost (e.g. followUp dropped at turn end) and is re-sent.
	 */
	function onAgentSettled(deliveredBatchIds: Iterable<string>) {
		busy = false;
		const delivered = new Set(deliveredBatchIds);
		for (const [id, batch] of [...inflight]) {
			if (delivered.has(id)) {
				inflight.delete(id);
				continue;
			}
			if (batch.attempts >= 3) {
				inflight.delete(id);
				console.error(
					`[foreman-coordination] WARNING: dropping undelivered notification batch ${id} after ${batch.attempts} attempts; ` +
						`the orchestrator was never woken for: ` +
						batch.notifications.map((n) => `${n.taskId} (${n.output})`).join(", "),
				);
				continue;
			}
			deliver(batch);
		}
		if (pending.length > 0 && !batchTimer) scheduleFlush();
	}

	/** Orchestrator is shutting down: kill children, record state, no notifications. */
	function shutdown() {
		stopped = true;
		if (batchTimer) clearTimeout(batchTimer);
		batchTimer = undefined;
		queue.length = 0;
		for (const t of tasks.values()) {
			if (t.state === "running" || t.state === "queued") {
				const wasRunning = t.state === "running";
				t.killedByShutdown = true;
				if (t.timer) clearTimeout(t.timer);
				if (wasRunning) {
					try {
						t.handle?.kill();
					} catch {
						// ignore
					}
				}
				t.state = "aborted";
				t.finishedAt = now();
				try {
					writeMeta(t, { finished_at: new Date(now()).toISOString(), error: "orchestrator shut down" });
				} catch {
					// ignore
				}
				persist(t);
			}
		}
		checkIdle();
		emitChange();
	}

	/**
	 * Abort every running and queued worker on request (/foreman off after the
	 * user's confirm). Running children get kill() (SIGTERM, SIGKILL after the
	 * grace period); the returned promise resolves once they have all exited.
	 * No notification is sent for aborted tasks.
	 */
	function abortAll(): Promise<number> {
		queue.length = 0;
		const exits: Promise<unknown>[] = [];
		let count = 0;
		for (const t of tasks.values()) {
			if (t.state !== "running" && t.state !== "queued") continue;
			count++;
			const wasRunning = t.state === "running";
			t.aborted = true;
			if (t.timer) clearTimeout(t.timer);
			t.state = "aborted";
			t.finishedAt = now();
			if (wasRunning && t.handle) {
				exits.push(t.handle.done.catch(() => undefined));
				try {
					t.handle.kill();
				} catch {
					// ignore
				}
			}
			try {
				writeMeta(t, { finished_at: new Date(now()).toISOString(), error: "aborted by user" });
			} catch {
				// ignore
			}
			persist(t);
		}
		emitChange();
		return Promise.all(exits).then(() => {
			checkIdle();
			emitChange();
			return count;
		});
	}

	/** Point-in-time view for the status bar, widget, /foreman-status and the `foreman:workers` event. */
	function snapshot(): WorkersSnapshot {
		const running: WorkersSnapshot["running"] = [];
		const finished: WorkersSnapshot["finished"] = [];
		let queuedCount = 0;
		for (const t of tasks.values()) {
			if (t.state === "running") {
				running.push({ taskId: t.taskId, role: t.role, planStep: t.planStep, startedAt: t.startedAt ?? now() });
			} else if (t.state === "queued") {
				queuedCount++;
			} else {
				finished.push({
					taskId: t.taskId,
					role: t.role,
					state: t.state as FinishedState,
					planStep: t.planStep,
					finishedAt: t.finishedAt ?? 0,
				});
			}
		}
		finished.reverse(); // stable sort below keeps newest first on equal timestamps
		finished.sort((a, b) => b.finishedAt - a.finishedAt);
		return { running, queued: queuedCount, finished: finished.slice(0, SNAPSHOT_FINISHED_MAX) };
	}

	/** Called after every state change; returns an unsubscribe. */
	function onChange(cb: () => void): () => void {
		changeListeners.add(cb);
		return () => changeListeners.delete(cb);
	}

	/**
	 * session_start recovery. `entries` are the session's `foreman-task` entry
	 * data blobs. A task from an earlier run whose latest state is
	 * running/queued/aborted never got a completion notification: notify now.
	 */
	function recover(entries: Array<Record<string, any>>): number {
		const latest = new Map<string, Record<string, any>>();
		for (const e of entries) {
			if (!e || typeof e.taskId !== "string" || typeof e.runId !== "string") continue;
			latest.set(`${e.runId}/${e.taskId}`, e);
		}
		const recovered: Notification[] = [];
		for (const e of latest.values()) {
			if (e.runId === runId) continue;
			if (!["running", "queued", "aborted"].includes(e.state)) continue;
			const outputRelPath: string = e.output ?? join(".foreman", "runs", e.runId, `${e.taskId}.md`);
			const outputAbs = join(deps.root, outputRelPath);
			let status: TaskStatus = "failed";
			let summary = "orphaned (orchestrator restarted)";
			let contractInfo: Partial<Notification> = {};
			if (existsSync(outputAbs)) {
				let report = "";
				try {
					report = readFileSync(outputAbs, "utf8");
				} catch {
					// fall through to orphaned
				}
				let metaStatus: string | undefined;
				try {
					metaStatus = JSON.parse(readFileSync(join(deps.root, ".foreman", "runs", e.runId, `${e.taskId}.json`), "utf8")).state;
				} catch {
					// no meta
				}
				if (report.trim()) {
					const isFailed = metaStatus === "failed" || report.startsWith(`# ${e.taskId} FAILED`);
					const body = report.replace(/^# .* FAILED\n+/, "");
					const parsed = parseFinalBlock(body);
					status = isFailed ? "failed" : (parsed.status ?? "completed");
					summary = parsed.contract === "ok" && parsed.summary ? truncate(parsed.summary, SUMMARY_MAX) : summarize(body);
					if (!isFailed) {
						contractInfo = { files: parsed.files, rulings: parsed.rulings, blockedOn: parsed.blockedOn, contract: parsed.contract };
					}
				}
			}
			recovered.push({
				taskId: e.taskId,
				role: e.role,
				status,
				planStep: e.planStep,
				planSlug: e.planSlug,
				summary,
				output: outputRelPath,
				...contractInfo,
			});
			deps.appendEntry(TASK_ENTRY_TYPE, { ...e, state: status, recovered: true });
		}
		if (recovered.length > 0) {
			pending.push(...recovered);
			scheduleFlush();
		}
		return recovered.length;
	}

	function whenIdle(): Promise<void> {
		return new Promise((resolve) => {
			idleWaiters.push(resolve);
			checkIdle();
		});
	}

	return {
		runId,
		delegate,
		onAgentStart,
		onAgentSettled,
		shutdown,
		abortAll,
		snapshot,
		onChange,
		recover,
		whenIdle,
		flush,
		/** Introspection for tests/UI. */
		stats: () => ({ running, queued: queue.length, pending: pending.length, inflight: inflight.size, busy }),
		getTask: (id: string) => tasks.get(id),
	};
}

export type Coordinator = ReturnType<typeof createCoordinator>;
