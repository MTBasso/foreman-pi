/**
 * Context filter — prunes stale `foreman-task-notification` results from the
 * orchestrator's LLM context (the `context` event; the runner hands handlers a
 * structuredClone of non-system messages and applies the returned list).
 *
 * Rules (docs/plans/foreman-pi-event-driven-coordinator.md, step 12):
 *  - only role "custom" + customType "foreman-task-notification" is in scope;
 *    user/assistant/tool/system and other custom messages are never touched
 *  - keep the latest FOREMAN_CONTEXT_KEEP_PER_ROLE (default 1) completed results
 *    per role, plus every block of the last notification message in the transcript
 *  - failed/blocked blocks are never pruned
 *  - older blocks are removed; one collapsed line
 *    `[pruned: K older <role> results — recover: <paths>]` per role is emitted in a
 *    single message placed where the first pruned content was
 *  - FOREMAN_CONTEXT_PRUNE=false disables; FOREMAN_CONTEXT_DEBUG=1 logs before/after counts
 *  - input is never mutated
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NOTIFICATION_CUSTOM_TYPE = "foreman-task-notification";
export const PRUNED_CUSTOM_TYPE = "foreman-context-pruned";

export interface PruneOptions {
	keepPerRole: number;
}

interface Entry {
	role: string;
	status: string;
	output: string;
	taskId: string;
	/** Raw `<task-notification>` block text, when recoverable from content. */
	block?: string;
}

const BLOCK_RE = /<task-notification>[\s\S]*?<\/task-notification>/g;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && (c as any).type === "text" ? String((c as any).text ?? "") : ""))
			.join("\n");
	}
	return "";
}

function field(block: string, name: string): string {
	const m = new RegExp(`^${name}:\\s*(.*)$`, "m").exec(block);
	return m ? m[1].trim() : "";
}

function isNotification(m: any): boolean {
	return m && m.role === "custom" && m.customType === NOTIFICATION_CUSTOM_TYPE;
}

/** details first (aligned with content blocks when counts match), regex fallback. */
function parseEntries(m: any): Entry[] {
	const blocks = textOf(m.content).match(BLOCK_RE) ?? [];
	const det = m.details?.notifications;
	if (Array.isArray(det) && det.length > 0 && (blocks.length === 0 || blocks.length === det.length)) {
		return det.map((d: any, i: number) => ({
			role: String(d?.role ?? ""),
			status: String(d?.status ?? ""),
			output: String(d?.output ?? ""),
			taskId: String(d?.taskId ?? d?.task_id ?? ""),
			block: blocks[i],
		}));
	}
	return blocks.map((b) => ({
		role: field(b, "role"),
		status: field(b, "status"),
		output: field(b, "output"),
		taskId: field(b, "task-id"),
		block: b,
	}));
}

export function pruneMessages<T = any>(messages: T[], opts: PruneOptions): T[] {
	const msgs = messages as any[];
	const keep = Math.max(0, Math.floor(opts.keepPerRole));
	let lastIdx = -1;
	const parsed = new Map<number, Entry[]>();
	msgs.forEach((m, i) => {
		if (!isNotification(m)) return;
		lastIdx = i;
		parsed.set(i, parseEntries(m));
	});
	if (parsed.size === 0) return messages;

	// Decide pruning, newest first.
	const seen = new Map<string, number>();
	const prune = new Map<number, boolean[]>();
	for (let i = msgs.length - 1; i >= 0; i--) {
		const entries = parsed.get(i);
		if (!entries) continue;
		const flags = new Array<boolean>(entries.length).fill(false);
		for (let j = entries.length - 1; j >= 0; j--) {
			const e = entries[j];
			if (e.status !== "completed" || !e.role) continue;
			const n = (seen.get(e.role) ?? 0) + 1;
			seen.set(e.role, n);
			if (i !== lastIdx && n > keep) flags[j] = true;
		}
		// A partially pruned message must be rebuildable from its content blocks.
		if (flags.some(Boolean) && !flags.every(Boolean) && entries.some((e) => e.block === undefined)) flags.fill(false);
		prune.set(i, flags);
	}

	const counts = new Map<string, number>();
	const paths = new Map<string, string[]>();
	const out: any[] = [];
	let stubAt = -1;
	let stubTemplate: any;
	msgs.forEach((m, i) => {
		const flags = prune.get(i);
		const entries = parsed.get(i);
		if (!flags || !entries || !flags.some(Boolean)) {
			out.push(m);
			return;
		}
		const alive = entries.filter((_, j) => !flags[j]);
		entries.forEach((e, j) => {
			if (!flags[j]) return;
			counts.set(e.role, (counts.get(e.role) ?? 0) + 1);
			const p = paths.get(e.role) ?? [];
			p.push(e.output || e.taskId || "?");
			paths.set(e.role, p);
		});
		if (stubAt < 0) {
			stubAt = out.length;
			stubTemplate = m;
		}
		// Mixed messages are rebuilt; fully pruned ones are dropped.
		if (alive.length > 0) {
			const rebuilt: any = { ...m, content: alive.map((e) => e.block).join("\n\n") };
			if (m.details && Array.isArray(m.details.notifications)) {
				const det = m.details.notifications as any[];
				rebuilt.details = { ...m.details, notifications: det.filter((_, j) => !flags[j]) };
			}
			out.push(rebuilt);
		}
	});

	if (counts.size === 0) return messages;
	const lines = [...counts].map(
		([role, k]) => `[pruned: ${k} older ${role} results — recover: ${(paths.get(role) ?? []).join(", ")}]`,
	);
	const stub: any = {
		role: "custom",
		customType: PRUNED_CUSTOM_TYPE,
		content: lines.join("\n"),
		display: false,
		timestamp: stubTemplate?.timestamp ?? Date.now(),
	};
	out.splice(stubAt, 0, stub);
	return out as T[];
}

function envKeep(): number {
	const raw = process.env.FOREMAN_CONTEXT_KEEP_PER_ROLE;
	if (raw === undefined || raw.trim() === "") return 1;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

export default function (pi: ExtensionAPI) {
	pi.on("context", (event) => {
		if (process.env.FOREMAN_CONTEXT_PRUNE === "false") return undefined;
		const before = event.messages;
		const after = pruneMessages(before, { keepPerRole: envKeep() });
		if (process.env.FOREMAN_CONTEXT_DEBUG === "1") {
			// A pruned message is replaced by one collapsed line, so after can equal before.
			const pruned = after === before ? 0 : before.filter((m) => !after.includes(m)).length;
			console.error(`[foreman-context-filter] messages before=${before.length} after=${after.length} pruned-or-rebuilt=${pruned}`);
		}
		return after === before ? undefined : { messages: after };
	});
}
