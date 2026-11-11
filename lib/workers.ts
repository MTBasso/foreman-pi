/**
 * Worker snapshot shape, bus channel names, and the (localized) renderers for
 * the status bar, the widget and /foreman-status. Pure: no pi imports, so the
 * smoke tests can call the renderers directly.
 */
import { t } from "./i18n.ts";
import type { ModeSource } from "./mode.ts";

/** Coordination publishes a `WorkersSnapshot` on this channel after every change. */
export const WORKERS_EVENT = "foreman:workers";
/** foreman-mode emits `{ ack: () => void }`; coordination aborts all workers, then calls ack. */
export const WORKERS_ABORT_EVENT = "foreman:workers:abort";

export type FinishedState = "completed" | "failed" | "blocked" | "aborted";

export interface WorkersSnapshot {
	running: Array<{ taskId: string; role: string; planStep?: number; startedAt: number }>;
	queued: number;
	/** Most recent first, already capped. */
	finished: Array<{ taskId: string; role: string; state: FinishedState; planStep?: number; finishedAt: number }>;
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

/**
 * Status-bar text and widget lines. Both are undefined (cleared) when nothing
 * is running or queued; finished workers are listed only alongside live ones.
 */
export function renderWorkersUi(s: WorkersSnapshot, now: number): { status?: string; widget?: string[] } {
	if (activeCount(s) === 0) return {};
	const status = t("status.workers", { running: s.running.length, queued: s.queued });
	const widget = [t("widget.title")];
	for (const r of s.running) widget.push(`  ${runningLine(r, now)}`);
	if (s.queued > 0) widget.push(`  ${t("widget.queued", { count: s.queued })}`);
	for (const f of s.finished.slice(0, 3)) widget.push(`  ${finishedLine(f)}`);
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
		for (const r of s.running) lines.push(`  ${runningLine(r, now)}`);
	}
	if (s.finished.length > 0) {
		lines.push(t("report.recent"));
		for (const f of s.finished) lines.push(`  ${finishedLine(f)}`);
	}
	if (s.running.length === 0 && s.queued === 0 && s.finished.length === 0) lines.push(t("report.none"));
	return lines.join("\n");
}
