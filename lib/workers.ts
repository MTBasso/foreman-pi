/**
 * Worker snapshot shape, bus channel names, and the (localized) renderers for
 * the status bar, the widget and /foreman-status. Pure: no pi imports, so the
 * smoke tests can call the renderers directly.
 */
import { t } from "./i18n.ts";
import type { ActivityView } from "./activity.ts";
import type { ModeSource } from "./mode.ts";

/** Coordination publishes a `WorkersSnapshot` on this channel after every change. */
export const WORKERS_EVENT = "foreman:workers";
/** foreman-mode emits `{ ack: () => void }`; coordination aborts all workers, then calls ack. */
export const WORKERS_ABORT_EVENT = "foreman:workers:abort";

export type FinishedState = "completed" | "failed" | "blocked" | "aborted";

export interface WorkersSnapshot {
	running: Array<{ taskId: string; role: string; planStep?: number; title?: string; startedAt: number; activity?: ActivityView }>;
	queued: number;
	/** Most recent first, already capped. */
	finished: Array<{ taskId: string; role: string; state: FinishedState; planStep?: number; title?: string; finishedAt: number }>;
}

export const EMPTY_SNAPSHOT: WorkersSnapshot = { running: [], queued: 0, finished: [] };

export const GLYPHS: Record<FinishedState, string> = { completed: "✓", failed: "✗", blocked: "!", aborted: "■" };
const RUNNING_GLYPH = "▶";

export function activeCount(s: WorkersSnapshot | undefined): number {
	return s ? s.running.length + s.queued : 0;
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

function stateLabel(state: FinishedState): string {
	switch (state) {
		case "completed":
			return t("widget.state.completed");
		case "failed":
			return t("widget.state.failed");
		case "blocked":
			return t("widget.state.blocked");
		default:
			return t("widget.state.aborted");
	}
}

function stepSuffix(step: number | undefined): string {
	return step === undefined ? "" : ` · ${t("widget.step", { step })}`;
}

function runningLine(r: WorkersSnapshot["running"][number], now: number): string {
	return `${RUNNING_GLYPH} ${r.taskId} (${r.role})${stepSuffix(r.planStep)} · ${formatElapsed(now - r.startedAt)}`;
}

function finishedLine(f: WorkersSnapshot["finished"][number]): string {
	return `${GLYPHS[f.state]} ${f.taskId} (${f.role})${stepSuffix(f.planStep)} · ${stateLabel(f.state)}`;
}

/** Compact widget label: "step 13 · Carousel UI", or the role when the worker has no plan step. */
function workerLabel(w: { role: string; planStep?: number; title?: string }): string {
	if (w.planStep === undefined) return w.role;
	const step = t("widget.step", { step: w.planStep });
	return w.title ? `${step} · ${w.title}` : step;
}

const HEALTH_GLYPHS: Record<ActivityView["health"], string> = { active: "●", waiting: "◐", silent: "⚠", repeating: "⟳", denied: "✖" };

const cpLen = (s: string): number => Array.from(s).length;

/** Shorten to `max` code points with a trailing ellipsis (never cuts below one char plus the ellipsis). */
function ellipsize(s: string, max: number): string {
	const cps = Array.from(s);
	if (cps.length <= max) return s;
	if (max <= 0) return "";
	return `${cps.slice(0, max - 1).join("")}…`;
}

/** No activity yet: nothing has been seen on the stream. */
function hasActivity(a: ActivityView | undefined): a is ActivityView {
	return !!a && !(a.phase === "idle" && a.turns === 0 && a.toolCalls === 0 && !a.label && a.outTokens === 0);
}

function phaseWord(p: ActivityView["phase"]): string {
	switch (p) {
		case "thinking":
			return t("activity.phase.thinking");
		case "writing":
			return t("activity.phase.writing");
		case "tool":
			return t("activity.phase.tool");
		case "reporting":
			return t("activity.phase.reporting");
		case "waiting":
			return t("activity.phase.waiting");
		default:
			return t("activity.phase.idle");
	}
}

function healthWord(h: ActivityView["health"]): string {
	switch (h) {
		case "active":
			return t("activity.health.active");
		case "waiting":
			return t("activity.health.waiting");
		case "silent":
			return t("activity.health.silent");
		case "repeating":
			return t("activity.health.repeating");
		default:
			return t("activity.health.denied");
	}
}

function compactTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Current-action text: phase word plus label (the tool name is dropped while a call is being written). */
function actionText(a: ActivityView): string {
	let label = a.label;
	if (a.phase === "writing") label = label.replace(/^\S+\s*/, "");
	return [phaseWord(a.phase), label].filter(Boolean).join(" ");
}

function runningWidgetLine(r: WorkersSnapshot["running"][number], now: number, columns: number): string {
	const base = `${RUNNING_GLYPH} ${workerLabel(r)} · ${formatElapsed(now - r.startedAt)}`;
	const a = r.activity;
	if (!hasActivity(a)) return base;
	const head = `${HEALTH_GLYPHS[a.health]} ${workerLabel(r)} · ${formatElapsed(now - r.startedAt)}`;
	const tail = [actionText(a), t("widget.tools", { count: a.toolCalls }), t("widget.out", { tokens: compactTokens(a.outTokens) })].join(" · ");
	const room = columns - cpLen(head) - 3; // " · "
	if (room < 2) return head;
	return `${head} · ${ellipsize(tail, room)}`;
}

/**
 * Status-bar text and widget lines. Both are undefined (cleared) when nothing
 * is running or queued; only the latest finished worker rides along, and only next to live ones.
 */
export function renderWorkersUi(s: WorkersSnapshot, now: number, columns = 100): { status?: string; widget?: string[] } {
	if (activeCount(s) === 0) return {};
	const status = t("status.workers", { running: s.running.length, queued: s.queued });
	const widget: string[] = [];
	for (const r of s.running) widget.push(runningWidgetLine(r, now, columns));
	if (s.queued > 0) widget.push(`… ${t("widget.queued", { count: s.queued })}`);
	const last = s.finished[0];
	if (last) widget.push(`${GLYPHS[last.state]} ${workerLabel(last)}${last.state === "completed" ? "" : ` · ${stateLabel(last.state)}`}`);
	return { status, widget };
}

/** Multi-line /foreman-status report. */
export function renderReport(s: WorkersSnapshot, mode: { active: boolean; source: ModeSource }, now: number): string {
	const source =
		mode.source === "subagent"
			? t("report.source.subagent")
			: mode.source === "env"
				? t("report.source.env")
				: mode.source === "entry"
					? t("report.source.entry")
					: mode.source === "event"
						? t("report.source.event")
						: t("report.source.default");
	const lines = [
		t("report.title"),
		t("report.mode", { state: mode.active ? t("mode.on") : t("mode.off"), source }),
		t("report.workers", { running: s.running.length, queued: s.queued }),
	];
	if (s.running.length > 0) {
		lines.push(t("report.running"));
		for (const r of s.running) {
			lines.push(`  ${runningLine(r, now)}`);
			if (hasActivity(r.activity)) lines.push(...activityLines(r.activity, now));
		}
	}
	if (s.finished.length > 0) {
		lines.push(t("report.recent"));
		for (const f of s.finished) lines.push(`  ${finishedLine(f)}`);
	}
	if (s.running.length === 0 && s.queued === 0 && s.finished.length === 0) lines.push(t("report.none"));
	return lines.join("\n");
}

function activityLines(a: ActivityView, now: number): string[] {
	const out = [`    ${t("report.activity.health", { health: healthWord(a.health), reason: healthReason(a, now) })}`];
	out.push(`    ${t("report.activity.now", { action: actionText(a) })}`);
	out.push(`    ${t("report.activity.usage", { tools: a.toolCalls, tokens: compactTokens(a.outTokens), cost: a.cost.toFixed(2) })}`);
	if (a.denials > 0) out.push(`    ${t("report.activity.denials", { count: a.denials, last: a.lastDenial })}`);
	const recent = a.recent.slice(-5);
	if (recent.length > 0) {
		out.push(`    ${t("report.activity.recent")}`);
		for (const x of recent) out.push(`      ${x.isError ? "✗" : "✓"} ${x.label} · ${formatElapsed(x.durationMs)}`);
	}
	return out;
}

function healthReason(a: ActivityView, now: number): string {
	const secs = Math.max(0, Math.floor((now - a.lastEventAt) / 1000));
	switch (a.health) {
		case "active":
			return t("activity.reason.active");
		case "waiting":
			return t("activity.reason.waiting", { secs });
		case "silent":
			return t("activity.reason.silent", { secs });
		case "repeating":
			return t("activity.reason.repeating");
		default:
			return t("activity.reason.denied", { count: a.denials });
	}
}

// --- stuck / repeating notices ------------------------------------------------

export interface StuckNotice {
	kind: "stuck" | "recovered";
	taskId: string;
	label: string;
	health: ActivityView["health"];
	/** Last action: the newest recent action, else the current label. */
	action: string;
	silentSecs: number;
	denials: number;
}

/** Minimum gap between two stuck notices for the same worker. */
export const STUCK_REPEAT_MS = 60_000;

const FLAGGED = new Set<ActivityView["health"]>(["silent", "repeating", "denied"]);

function lastAction(a: ActivityView): string {
	return a.recent.length > 0 ? a.recent[a.recent.length - 1].label : a.label;
}

/**
 * Pure watcher over successive snapshots: one `stuck` notice per transition into
 * silent/repeating/denied (at most one per worker per 60 s), one `recovered` notice when
 * the worker returns to active. Holds no timers; state for finished workers is dropped.
 */
export function createHealthWatcher(opts: { minGapMs?: number } = {}) {
	const minGap = opts.minGapMs ?? STUCK_REPEAT_MS;
	const state = new Map<string, { flagged?: ActivityView["health"]; lastNoticeAt?: number }>();
	return {
		check(s: WorkersSnapshot, now: number): StuckNotice[] {
			const out: StuckNotice[] = [];
			const live = new Set<string>();
			for (const r of s.running) {
				live.add(r.taskId);
				const a = r.activity;
				if (!a) continue;
				const st = state.get(r.taskId) ?? {};
				state.set(r.taskId, st);
				const base = { taskId: r.taskId, label: workerLabel(r), health: a.health, action: lastAction(a), silentSecs: Math.max(0, Math.round((now - a.lastEventAt) / 1000)), denials: a.denials };
				if (FLAGGED.has(a.health)) {
					if (st.flagged === a.health) continue;
					if (st.lastNoticeAt !== undefined && now - st.lastNoticeAt < minGap) continue;
					st.flagged = a.health;
					st.lastNoticeAt = now;
					out.push({ kind: "stuck", ...base });
				} else if (a.health === "active" && st.flagged) {
					st.flagged = undefined;
					out.push({ kind: "recovered", ...base });
				}
			}
			for (const id of [...state.keys()]) if (!live.has(id)) state.delete(id);
			return out;
		},
		/** Tracked workers (for leak tests). */
		size: () => state.size,
	};
}

export function renderStuckNotice(n: StuckNotice): string {
	const vars = { label: n.label, secs: n.silentSecs, action: n.action || "-", count: n.denials };
	if (n.kind === "recovered") return t("stuck.recovered", vars);
	if (n.health === "repeating") return t("stuck.repeating", vars);
	if (n.health === "denied") return t("stuck.denied", vars);
	return t("stuck.silent", vars);
}
