/**
 * Preflight block for /plan-runner: facts the orchestrator (which has no shell)
 * would otherwise have to probe, gathered once by the extension. Pure and
 * filesystem/PATH only: no subprocess, no npx (it would download).
 */
import { dirname, join, sep } from "node:path";
import { parseRendersYes, parseStatusSection, parseStepChecks } from "./plan-steps.ts";

const RENDER_PATH_TOOLS = ["playwright", "chromium", "chromium-browser", "google-chrome"];

export interface PreflightInput {
	planText: string;
	roots: string[];
	exists: (path: string) => boolean;
	onPath: (cmd: string) => boolean;
	/** Reads a text file, undefined when unreadable. Used for package.json scripts. */
	readFile?: (path: string) => string | undefined;
}

export function renderToolFound(roots: string[], exists: (p: string) => boolean, onPath: (c: string) => boolean): boolean {
	for (const r of roots) {
		if (exists(join(r, "node_modules", ".bin", "playwright")) || exists(join(r, ".venv", "bin", "playwright"))) return true;
	}
	return RENDER_PATH_TOOLS.some((c) => onPath(c));
}

/** The orchestrator cwd plus the plan's own repo root (two levels above docs/plans/), deduplicated. */
export function planRoots(cwd: string, planPath: string): string[] {
	const out = [cwd];
	const dir = dirname(planPath);
	if (dir.endsWith(`${sep}docs${sep}plans`) || dir.endsWith("/docs/plans")) {
		const repo = dirname(dirname(dir));
		if (repo !== cwd) out.push(repo);
	}
	return out;
}

function scriptsOf(root: string, readFile?: (p: string) => string | undefined): Set<string> | undefined {
	const text = readFile?.(join(root, "package.json"));
	if (text === undefined) return undefined;
	try {
		const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts;
		return new Set(Object.keys(scripts && typeof scripts === "object" ? scripts : {}));
	} catch {
		return undefined;
	}
}

export function planPreflight(input: PreflightInput): string {
	const { planText, roots, exists, onPath, readFile } = input;
	const problems: string[] = [];

	const status = parseStatusSection(planText);
	if (!status) {
		problems.push("- `## Status` section: missing (plan-runner needs one as its source of truth).");
	}

	const renders = parseRendersYes(planText);
	if (renders.length > 0 && !renderToolFound(roots, exists, onPath)) {
		problems.push(`- Renders: yes on step ${renders.join(", ")}; no render tool found (playwright/chromium under the roots or on PATH), so screenshots cannot be captured.`);
	}

	const known = roots.map((r) => scriptsOf(r, readFile)).filter((s): s is Set<string> => s !== undefined);
	if (known.length > 0) {
		const missing = new Map<string, number[]>();
		for (const m of planText.matchAll(/^\s*(\d+)\.\s+\*\*/gm)) {
			const n = Number(m[1]);
			for (const s of parseStepChecks(planText, n)?.npmScripts ?? []) {
				if (known.some((k) => k.has(s))) continue;
				const list = missing.get(s) ?? [];
				if (!list.includes(n)) list.push(n);
				missing.set(s, list);
			}
		}
		for (const [s, steps] of missing) problems.push(`- npm script \`${s}\` (Checks of step ${steps.join(", ")}) is not in package.json.`);
	}

	const lines = ["## Plan preflight"];
	if (problems.length === 0) {
		lines.push(status ? `No problems found (${statusCounts(status)}).` : "No problems found.");
	} else {
		if (status) lines.push(`Status: ${statusCounts(status)}.`);
		lines.push(...problems);
	}
	return lines.join("\n");
}

function statusCounts(status: Map<number, { state: string }>): string {
	const counts = new Map<string, number>();
	for (const { state } of status.values()) counts.set(state, (counts.get(state) ?? 0) + 1);
	return [...counts].map(([s, n]) => `${s} ${n}`).join(", ") || "no steps listed";
}
