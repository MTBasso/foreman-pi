import { planPreflight, planRoots, renderToolFound } from "./plan-preflight.ts";
import { buildPlanRunnerPrompt } from "../extensions/foreman-mode/prompts.ts";

let failures = 0;
const check = (n: string, ok: boolean) => {
	console.log(`${ok ? "ok " : "FAIL"} - ${n}`);
	if (!ok) failures++;
};

const plan = [
	"## Steps",
	"",
	"1. **Shot** (Touches: a)",
	"   - Checks: `npm run test:a`",
	"   - Renders: yes",
	"2. **Plain** (Touches: b)",
	"   - Checks: `npm run test:missing`, `npm test`",
	"   - Renders: no",
	"",
	"## Status",
	"",
	"- Step 1: merged",
	"- Step 2: not started",
	"",
].join("\n");

const pkg = JSON.stringify({ scripts: { "test:a": "x", test: "y" } });
const deps = (o: { files?: string[]; path?: string[]; pkg?: string } = {}) => ({
	exists: (p: string) => (o.files ?? []).includes(p),
	onPath: (c: string) => (o.path ?? []).includes(c),
	readFile: (p: string) => (p.endsWith("package.json") ? (o.pkg ?? pkg) : undefined),
});

{
	const out = planPreflight({ planText: plan, roots: ["/r"], ...deps() });
	check("Renders: yes steps with no render tool are listed", /Renders: yes.*step 1/.test(out) && /no render tool/i.test(out));
	check("missing npm script is listed", out.includes("test:missing") && !out.includes("test:a`") );
	check("status counts by state are reported", /merged 1/.test(out) && /not started 1/.test(out));
}
{
	const out = planPreflight({ planText: plan, roots: ["/r"], ...deps({ files: ["/r/node_modules/.bin/playwright"] }) });
	check("render tool found under node_modules/.bin counts", !/no render tool/i.test(out));
	const venv = planPreflight({ planText: plan, roots: ["/a", "/b"], ...deps({ files: ["/b/.venv/bin/playwright"] }) });
	check("render tool found under .venv/bin of any root counts", !/no render tool/i.test(venv));
	const onp = planPreflight({ planText: plan, roots: ["/r"], ...deps({ path: ["chromium"] }) });
	check("render tool on PATH counts", !/no render tool/i.test(onp));
	check("renderToolFound false with nothing", renderToolFound(["/r"], deps().exists, deps().onPath) === false);
}
{
	const out = planPreflight({ planText: "## Steps\n\n1. **A** (Touches: a)\n   - Checks: `npm test`\n   - Renders: no\n", roots: ["/r"], ...deps() });
	check("missing Status heading is reported", /Status.*missing/i.test(out));
	const ok = planPreflight({ planText: plan.replace("test:missing", "test:a").replace("Renders: yes", "Renders: no"), roots: ["/r"], ...deps() });
	check("no problems prints a one-line all-clear", ok.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length === 1 && /no problems/i.test(ok));
	const nopkg = planPreflight({ planText: plan, roots: ["/r"], exists: () => false, onPath: () => false, readFile: () => undefined });
	check("no package.json: scripts are not judged", !nopkg.includes("test:missing"));
}
check("planRoots: cwd and the plan's repo root", JSON.stringify(planRoots("/cwd", "/repo/docs/plans/p.md")) === JSON.stringify(["/cwd", "/repo"]) && planRoots("/repo", "/repo/docs/plans/p.md").length === 1);

{
	const base = buildPlanRunnerPrompt("/p.md", true);
	check("prompt without preflight is byte-identical to today's", buildPlanRunnerPrompt("/p.md", true, undefined, undefined) === base && !base.includes("--- preflight"));
	const withPf = buildPlanRunnerPrompt("/p.md", true, undefined, "BLOCK");
	check("preflight appended under its marker", withPf.startsWith(base) && withPf.endsWith("--- preflight (gathered by the extension; do not re-run) ---\nBLOCK"));
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
