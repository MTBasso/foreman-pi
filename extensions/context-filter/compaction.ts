/**
 * Run-state summary for custom compaction (A3, first half). Pure: every input
 * (branch entries, file reader, git probe, clock) is passed in, nothing throws
 * on missing or unreadable sources (the section is dropped instead).
 */

export const TOTAL_CAP = 12000;
const TERMINAL = new Set(["completed", "failed", "blocked", "aborted"]);

export interface RunStateInput {
	branchEntries: unknown[];
	cwd: string;
	/** Absolute path -> file text, or undefined when missing/unreadable. May throw. */
	readFile: (absPath: string) => string | undefined;
	/** Current git branch for a directory, or undefined. May throw. */
	gitBranch: (dir: string) => string | undefined;
	now: number;
}

interface TaskEntry {
	runId?: string;
	taskId: string;
	role?: string;
	planStep?: number;
	planSlug?: string;
	state: string;
	output?: string;
	summary?: string;
}

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);
const safe = <T>(f: () => T | undefined): T | undefined => {
	try {
		return f();
	} catch {
		return undefined;
	}
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p: any) => (p && p.type === "text" && typeof p.text === "string" ? p.text : ""))
		.filter(Boolean)
		.join("\n");
}

export function buildRunState(input: RunStateInput): string {
	const entries = Array.isArray(input.branchEntries) ? (input.branchEntries as any[]) : [];
	const tasks: TaskEntry[] = [];
	const notes: any[] = [];
	const userTexts: string[] = [];
	for (const e of entries) {
		if (!e || typeof e !== "object") continue;
		if (e.type === "custom" && e.customType === "foreman-task" && e.data && typeof e.data.taskId === "string") {
			tasks.push(e.data as TaskEntry);
		} else if (e.customType === "foreman-task-notification" && Array.isArray(e.details?.notifications)) {
			for (const n of e.details.notifications) if (n && typeof n === "object") notes.push(n);
		} else if (e.type === "message" && e.message?.role === "user") {
			const t = textOf(e.message.content).trim();
			if (t) userTexts.push(t);
		}
	}

	// newest entry per task id (in-order => last wins)
	const latest = new Map<string, TaskEntry>();
	for (const t of tasks) latest.set(t.taskId, t);
	const newest = tasks.length ? tasks[tasks.length - 1] : undefined;
	const runIds = [...new Set(tasks.map((t) => t.runId).filter((r): r is string => !!r))];

	const metaOf = (t: TaskEntry | undefined): any => {
		if (!t?.runId) return undefined;
		const raw = safe(() => input.readFile(`${input.cwd}/.foreman/runs/${t.runId}/${t.taskId}.json`));
		return raw ? safe(() => JSON.parse(raw)) : undefined;
	};
	const meta = metaOf(newest);
	const workdir: string = typeof meta?.workdir === "string" && meta.workdir ? meta.workdir : input.cwd;
	const branch = safe(() => input.gitBranch(workdir));
	const slug = [...tasks].reverse().find((t) => t.planSlug)?.planSlug;
	const planRel = slug ? `docs/plans/${slug}.md` : undefined;
	const planText = planRel ? safe(() => input.readFile(`${workdir}/${planRel}`)) : undefined;

	const sections: string[] = [];

	// (a) header
	sections.push(
		cap(
			`[foreman run state — built by the foreman extension at ${new Date(input.now).toISOString()}, not an LLM summary. It replaces the earlier conversation; trust the files it points to over memory.]`,
			600,
		),
	);

	// (b) run
	{
		const lines = ["## Run"];
		if (runIds.length) lines.push(`run: ${runIds.slice(-3).join(", ")}`);
		if (slug) lines.push(`plan: ${slug}${planRel ? ` (${workdir}/${planRel})` : ""}`);
		lines.push(`workdir: ${workdir}`);
		if (branch) lines.push(`branch: ${branch}`);
		sections.push(cap(lines.join("\n"), 800));
	}

	// (c) step table
	{
		const statusLines = planText ? planText.split("\n").filter((l) => /^\s*-\s*Step\s+\d+\s*:/.test(l)) : [];
		let rows: string[] = [];
		let src = "";
		if (statusLines.length) {
			rows = statusLines.map((l) => oneLine(l.replace(/^\s*-\s*/, "")));
			src = "plan ## Status";
		} else {
			const byStep = new Map<number, TaskEntry>();
			for (const t of tasks) if (typeof t.planStep === "number") byStep.set(t.planStep, t);
			rows = [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([n, t]) => `Step ${n}: ${t.state} (${t.role ?? "?"}, ${t.taskId})`);
			src = "newest task entry per step";
		}
		if (rows.length) sections.push(cap(`## Steps (${src})\n${rows.join("\n")}`, 2500));
	}

	// (d) in flight / queued, then blocked/failed
	{
		const live: string[] = [];
		const bad: string[] = [];
		for (const t of latest.values()) {
			if (!TERMINAL.has(t.state)) live.push(`- ${t.taskId} [${t.state}] ${t.role ?? "?"}${t.planStep !== undefined ? ` step ${t.planStep}` : ""}`);
			else if (t.state === "failed" || t.state === "blocked") {
				const sum = notes.find((n) => n.taskId === t.taskId)?.summary ?? t.summary ?? "";
				bad.push(`- ${t.taskId} [${t.state}] ${t.role ?? "?"}${t.planStep !== undefined ? ` step ${t.planStep}` : ""} output: ${t.output ?? "?"}${sum ? ` — ${cap(oneLine(String(sum)), 200)}` : ""}`);
			}
		}
		const lines: string[] = [];
		if (live.length) lines.push("## In flight / queued", ...live.slice(0, 30));
		if (bad.length) lines.push("## Blocked / failed", ...bad.slice(-20));
		if (lines.length) sections.push(cap(lines.join("\n"), 3000));
	}

	// (e) rulings and unresolved
	{
		const seen = new Set<string>();
		const rulings: string[] = [];
		for (const n of notes) {
			if (Array.isArray(n.rulings)) {
				for (const r of n.rulings) {
					if (typeof r !== "string") continue;
					const k = oneLine(r);
					if (k && !seen.has(k)) {
						seen.add(k);
						rulings.push(k);
					}
				}
			}
		}
		const unresolved: string[] = [];
		for (const n of notes) {
			if (n.status === "completed") continue;
			if (typeof n.blockedOn === "string" && n.blockedOn.trim()) unresolved.push(`- ${n.taskId}: blocked on ${cap(oneLine(n.blockedOn), 200)}`);
			if (Array.isArray(n.guardDenied) && n.guardDenied.length) unresolved.push(`- ${n.taskId}: guard denied ${cap(n.guardDenied.map(String).join("; "), 200)}`);
		}
		const lines: string[] = [];
		if (rulings.length) lines.push("## Rulings", ...rulings.slice(-20).map((r) => `- ${cap(r, 300)}`));
		if (unresolved.length) lines.push("## Unresolved", ...unresolved.slice(-20));
		if (lines.length) sections.push(cap(lines.join("\n"), 3000));
	}

	// (f) memory
	{
		const memPath = `${workdir}/FOREMAN_MEMORY.md`;
		const mem = safe(() => input.readFile(memPath));
		if (mem) {
			const m = /^#{1,6}[ \t]*Decisions log[ \t]*$/im.exec(mem);
			if (m) {
				const rest = mem.slice(m.index + m[0].length);
				const next = /^#{1,6}[ \t]/m.exec(rest);
				const body = (next ? rest.slice(0, next.index) : rest).trim();
				if (body) sections.push(`## Decisions log (${memPath})\n${cap(body, 2000)}`);
				else sections.push(`## Memory\nsee ${memPath}`);
			} else sections.push(`## Memory\nsee ${memPath}`);
		}
	}

	// (g) user messages
	if (userTexts.length) {
		const last = userTexts.slice(-8).map((t) => `- ${cap(oneLine(t), 300)}`);
		sections.push(cap(`## Last user messages\n${last.join("\n")}`, 2800));
	}

	// (h) recovery
	{
		const run = runIds.length ? runIds[runIds.length - 1] : "<run>";
		sections.push(`## Recovery\nRead the plan ## Status${planRel ? ` (${planRel})` : ""} and .foreman/runs/${run}/ledger.log. Do not re-dispatch merged steps.`);
	}

	// the recovery line is last and must survive the total cap
	const recovery = sections.pop() as string;
	let body = sections.join("\n\n");
	const room = TOTAL_CAP - recovery.length - 2;
	if (body.length > room) body = `${body.slice(0, room - 1)}…`;
	return `${body}\n\n${recovery}`;
}
