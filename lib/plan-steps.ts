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
