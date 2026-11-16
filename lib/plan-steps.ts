/**
 * Plan-step titles for the worker widget. A plan under docs/plans/<slug>.md
 * lists steps as `N. **Title** (Touches: ...)`; the widget shows that title so
 * a running worker is recognisable without opening its output. Best effort:
 * every failure yields undefined and the widget falls back to the bare step number.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const TITLE_MAX = 44;

/** First `N. **Title**` line in the markdown, cleaned for one-line display. */
export function parseStepTitle(markdown: string, step: number): string | undefined {
	const re = new RegExp(`^\\s*${step}\\.\\s+\\*\\*(.+?)\\*\\*`, "m");
	const m = re.exec(markdown);
	if (!m) return undefined;
	let title = m[1].replace(/`/g, "").replace(/[\s:.]+$/, "").trim();
	if (!title) return undefined;
	if (title.length > TITLE_MAX) title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
	return title;
}

export function readStepTitle(root: string, slug: string | undefined, step: number | undefined): string | undefined {
	if (!slug || step === undefined || /[\\/]|\.\./.test(slug)) return undefined;
	try {
		const file = path.join(root, "docs", "plans", slug.endsWith(".md") ? slug : `${slug}.md`);
		return parseStepTitle(fs.readFileSync(file, "utf8"), step);
	} catch {
		return undefined;
	}
}

/** `(Touches: a, b)` of the first `N. **Title**` line, backticks stripped. undefined when absent. */
export function parseTouches(markdown: string, step: number): string[] | undefined {
	const re = new RegExp(`^\\s*${step}\\.\\s+\\*\\*.+$`, "m");
	const line = re.exec(markdown)?.[0];
	if (!line) return undefined;
	const m = /\(Touches:\s*(.+)\)\s*$/.exec(line);
	if (!m) return undefined;
	const list = m[1].split(",").map((p) => p.replace(/`/g, "").trim().replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
	return list.length ? list : undefined;
}

export interface PlanOverlap {
	a: number;
	b: number;
	paths: string[];
}

const sharesPath = (x: string, y: string) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);

/**
 * Pairs of steps inside the `## Parallel` section that share a Touches path
 * (exact match or directory prefix). No `## Parallel` heading or no Touches
 * on a step: nothing is reported (never a false positive).
 */
export function findParallelOverlaps(markdown: string): PlanOverlap[] {
	const wave: Array<{ n: number; touches: string[] }> = [];
	let inWave = false;
	for (const line of markdown.split("\n")) {
		if (/^##\s/.test(line)) {
			inWave = /^##\s+Parallel\b/i.test(line);
			continue;
		}
		if (!inWave) continue;
		const m = /^\s*(\d+)\.\s+\*\*/.exec(line);
		if (!m) continue;
		const touches = parseTouches(line, Number(m[1]));
		if (touches) wave.push({ n: Number(m[1]), touches });
	}
	const out: PlanOverlap[] = [];
	for (let i = 0; i < wave.length; i++) {
		for (let j = i + 1; j < wave.length; j++) {
			const paths = new Set<string>();
			for (const x of wave[i].touches) {
				for (const y of wave[j].touches) if (sharesPath(x, y)) paths.add(x.length >= y.length ? x : y);
			}
			if (paths.size) out.push({ a: wave[i].n, b: wave[j].n, paths: [...paths] });
		}
	}
	return out;
}

/** Overlaps involving `step` in docs/plans/<slug>.md, as `{ other, paths }`. Best effort: [] on any failure. */
export function readOverlapsFor(root: string, slug: string | undefined, step: number | undefined): Array<{ other: number; paths: string[] }> {
	if (!slug || step === undefined || /[\\/]|\.\./.test(slug)) return [];
	try {
		const file = path.join(root, "docs", "plans", slug.endsWith(".md") ? slug : `${slug}.md`);
		return findParallelOverlaps(fs.readFileSync(file, "utf8"))
			.filter((o) => o.a === step || o.b === step)
			.map((o) => ({ other: o.a === step ? o.b : o.a, paths: o.paths }));
	} catch {
		return [];
	}
}

/** docs/plans/<slug>.md text, same slug validation as readStepTitle. undefined on any failure. */
export function readPlanText(root: string, slug: string | undefined): string | undefined {
	if (!slug || /[\\/]|\.\./.test(slug)) return undefined;
	try {
		return fs.readFileSync(path.join(root, "docs", "plans", slug.endsWith(".md") ? slug : `${slug}.md`), "utf8");
	} catch {
		return undefined;
	}
}

export interface StepStatus {
	state: string;
	note?: string;
}

/** Lines `- Step N: <state> (note)` under `## Status`. undefined when the heading is missing. */
export function parseStatusSection(markdown: string): Map<number, StepStatus> | undefined {
	const out = new Map<number, StepStatus>();
	let found = false;
	let inStatus = false;
	for (const line of markdown.split("\n")) {
		if (/^##\s/.test(line)) {
			inStatus = /^##\s+Status\s*$/i.test(line);
			if (inStatus) found = true;
			continue;
		}
		if (!inStatus) continue;
		const m = /^\s*-\s+Step\s+(\d+)\s*:\s*([^(]*?)\s*(?:\((.*)\))?\s*$/i.exec(line);
		if (!m || !m[2]) continue;
		const entry: StepStatus = { state: m[2].toLowerCase() };
		if (m[3]?.trim()) entry.note = m[3].trim();
		out.set(Number(m[1]), entry);
	}
	return found ? out : undefined;
}

/** Text of step `step`: from its `N. **` line up to the next numbered bold line or `## ` heading. */
function stepBlock(markdown: string, step: number): string | undefined {
	const lines = markdown.split("\n");
	const head = new RegExp(`^\\s*${step}\\.\\s+\\*\\*`);
	const start = lines.findIndex((l) => head.test(l));
	if (start < 0) return undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s*\d+\.\s+\*\*/.test(lines[i]) || /^##\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join("\n");
}

export interface StepChecks {
	npmScripts: string[];
	other: string[];
}

/** Backticked spans of the step's `- Checks:` bullet: `npm run X` gives X, `npm test` gives `test`, the rest is `other`. */
export function parseStepChecks(markdown: string, step: number): StepChecks | undefined {
	const block = stepBlock(markdown, step);
	if (block === undefined) return undefined;
	const line = block.split("\n").find((l) => /^\s*-\s+Checks:/.test(l));
	const out: StepChecks = { npmScripts: [], other: [] };
	if (!line) return out;
	for (const m of line.matchAll(/`([^`]+)`/g)) {
		const span = m[1].trim();
		const run = /^npm\s+run\s+([\w:.-]+)$/.exec(span);
		if (run) out.npmScripts.push(run[1]);
		else if (/^npm\s+test$/.test(span)) out.npmScripts.push("test");
		else out.other.push(span);
	}
	return out;
}

/** Steps whose block carries `Renders: yes`. */
export function parseRendersYes(markdown: string): number[] {
	const out: number[] = [];
	for (const m of markdown.matchAll(/^\s*(\d+)\.\s+\*\*/gm)) {
		const n = Number(m[1]);
		if (out.includes(n)) continue;
		const block = stepBlock(markdown, n);
		if (block && /^\s*-\s+Renders:\s*yes\b/im.test(block)) out.push(n);
	}
	return out;
}
