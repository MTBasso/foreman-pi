/**
 * State for `/foreman resume`: everything the extension can read from disk so
 * the user does not have to retype it. Best effort and read-only: any
 * unreadable piece is left out, never thrown.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseStatusSection, readPlanText } from "./plan-steps.ts";

export interface ResumeOrphan {
	taskId: string;
	role: string;
	planStep?: number;
	state: string;
	/** Relative report path as written by the coordinator. */
	output?: string;
	/** "last action: ..." summary from <task>.status.json, when present. */
	lastAction?: string;
}

export interface ResumeState {
	runId: string;
	planSlug?: string;
	/** Last 20 lines of .foreman/plan-runner/<slug>/progress.md. */
	progressTail: string[];
	/** "N: state (note)" lines from the plan's `## Status`; undefined without a plan or section. */
	statusLines?: string[];
	orphans: ResumeOrphan[];
	/** workdir of the newest task json that has one. */
	workdir?: string;
}

const UNFINISHED = new Set(["running", "queued", "aborted"]);
const TAIL_LINES = 20;

function readJson(file: string): any {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function runDirs(root: string): string[] {
	try {
		return readdirSync(join(root, ".foreman", "runs"))
			.filter((d) => existsSync(join(root, ".foreman", "runs", d, "run.json")))
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

function lastAction(file: string): string | undefined {
	const v = readJson(file)?.view;
	if (!v || typeof v !== "object") return undefined;
	const recent = Array.isArray(v.recent) ? v.recent : [];
	const action = v.label ? [v.phase, v.label].filter(Boolean).join(" ") : (recent.length ? recent[recent.length - 1]?.label : "") || v.phase || "";
	return action ? String(action).replace(/\s+/g, " ").trim() : undefined;
}

interface TaskJson {
	file: string;
	json: any;
	mtime: number;
}

function tasksOf(dir: string): TaskJson[] {
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: TaskJson[] = [];
	for (const n of names) {
		if (!n.endsWith(".json") || n === "run.json" || n.endsWith(".status.json")) continue;
		const file = join(dir, n);
		const json = readJson(file);
		if (!json || typeof json !== "object" || typeof json.task_id !== "string") continue;
		let mtime = 0;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			// keep 0
		}
		const at = Date.parse(json.updated_at);
		out.push({ file, json, mtime: Number.isFinite(at) ? at : mtime });
	}
	return out;
}

/** undefined when there is no run dir with a run.json. */
export function gatherResumeState(root: string): ResumeState | undefined {
	try {
		const runs = runDirs(root);
		if (runs.length === 0) return undefined;
		const newest = runs[0];
		const newestDir = join(root, ".foreman", "runs", newest);
		const slug = readJson(join(newestDir, "run.json"))?.plan_slug;
		const planSlug = typeof slug === "string" && slug ? slug : undefined;

		let progressTail: string[] = [];
		let statusLines: string[] | undefined;
		if (planSlug) {
			if (!/[\\/]|\.\./.test(planSlug)) {
				try {
					const text = readFileSync(join(root, ".foreman", "plan-runner", planSlug, "progress.md"), "utf8");
					progressTail = text.split("\n").filter((l) => l.trim()).slice(-TAIL_LINES);
				} catch {
					// no ledger yet
				}
			}
			const status = parseStatusSection(readPlanText(root, planSlug) ?? "");
			if (status) statusLines = [...status].map(([n, s]) => `${n}: ${s.state}${s.note ? ` (${s.note})` : ""}`);
		}

		const orphans: ResumeOrphan[] = [];
		let workdir: string | undefined;
		for (const [i, run] of runs.slice(0, 2).entries()) {
			const dir = join(root, ".foreman", "runs", run);
			const tasks = tasksOf(dir).sort((a, b) => b.mtime - a.mtime);
			if (i === 0) workdir = tasks.find((t) => typeof t.json.workdir === "string" && t.json.workdir)?.json.workdir;
			for (const t of tasks) {
				const j = t.json;
				if (!UNFINISHED.has(String(j.state))) continue;
				orphans.push({
					taskId: j.task_id,
					role: String(j.role ?? ""),
					...(typeof j.plan_step === "number" ? { planStep: j.plan_step } : {}),
					state: String(j.state),
					...(typeof j.output === "string" && j.output ? { output: j.output } : {}),
					...(lastAction(join(dir, `${j.task_id}.status.json`)) ? { lastAction: lastAction(join(dir, `${j.task_id}.status.json`)) } : {}),
				});
			}
		}
		return { runId: newest, ...(planSlug ? { planSlug } : {}), progressTail, ...(statusLines ? { statusLines } : {}), orphans, ...(workdir ? { workdir } : {}) };
	} catch {
		return undefined;
	}
}

/** Pre-assembled state block for the resume prompt. */
export function formatResumeState(s: ResumeState): string {
	const out = [`## Resume state (gathered by the extension)`, `Run: ${s.runId}${s.planSlug ? `; plan: ${s.planSlug}` : ""}`];
	if (s.workdir) out.push(`Latest task workdir: ${s.workdir}`);
	if (s.statusLines) out.push("", "Plan Status:", ...s.statusLines.map((l) => `- Step ${l}`));
	if (s.progressTail.length) out.push("", `Ledger tail (last ${TAIL_LINES} lines of progress.md):`, ...s.progressTail);
	out.push("", "Unfinished tasks (running, queued or aborted):");
	if (s.orphans.length === 0) out.push("- none");
	for (const o of s.orphans) {
		out.push(`- ${o.taskId} (${o.role}${o.planStep !== undefined ? `, step ${o.planStep}` : ""}): ${o.state}${o.lastAction ? `; ${o.lastAction}` : ""}${o.output ? `; report: ${o.output}` : ""}`);
	}
	return out.join("\n");
}
