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
