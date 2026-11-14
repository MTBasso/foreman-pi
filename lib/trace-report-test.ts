import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageTally } from "./usage.ts";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };

const script = new URL("../scripts/trace-report.mjs", import.meta.url).pathname;
const run = new URL("./testdata/trace/run", import.meta.url).pathname;
const base = new URL("./testdata/trace/baseline", import.meta.url).pathname;
const exec = (...a: string[]) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8" });

{
	const r = exec(run);
	const rows = r.stdout.split("\n").filter((l) => /^t\d-/.test(l));
	check("table lists one row per task", r.status === 0 && rows.length === 3 && rows[0].startsWith("t1-planner") && rows[2].startsWith("t3-qa"));
}
{
	const j = JSON.parse(exec(run, "--json").stdout);
	const t = j.tasks.find((x: any) => x.task_id === "t2-plan-step-builder");
	check("legacy run without usage is recomputed from events.jsonl", t?.usageSource === "events" && t.input === 6 && t.output === 8 && t.cacheRead === 10 && t.cacheWrite === 12 && t.turns === 2 && t.toolCalls === 1 && t.guardDenials.total === 1 && t.guardDenials.byReason["no eval"] === 1 && t.cost === 0.5);
}
{
	const d = mkdtempSync(join(tmpdir(), "trace-"));
	try {
		const lines = readFileSync(new URL("./testdata/worker-stream.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
		writeFileSync(join(d, "t1-x.events.jsonl"), lines.join("\n") + "\n");
		writeFileSync(join(d, "t1-x.json"), JSON.stringify({ task_id: "t1-x", role: "qa", plan_step: null, state: "completed", handoff_prompt: "" }));
		const tally = createUsageTally();
		for (const l of lines) tally.feed(JSON.parse(l));
		const s = tally.snapshot();
		const t = JSON.parse(exec(d, "--json").stdout).tasks[0];
		check("parity: script totals equal createUsageTally totals on the same events file",
			t.input === s.input && t.output === s.output && t.cacheRead === s.cacheRead && t.cacheWrite === s.cacheWrite && Math.abs(t.cost - s.cost) < 1e-12 && t.turns === s.turns && t.toolCalls === s.toolCalls && t.guardDenials.total === s.guardDenials.total);
	} finally { rmSync(d, { recursive: true, force: true }); }
}
{
	const r = exec(run, "--json");
	let ok = false;
	try { const j = JSON.parse(r.stdout); ok = Array.isArray(j.tasks) && j.totals.tasks === 3 && Array.isArray(j.topDenials); } catch { /* */ }
	check("--json output parses", ok);
}
{
	const d = mkdtempSync(join(tmpdir(), "trace-"));
	try {
		writeFileSync(join(d, "t1-x.json"), JSON.stringify({ task_id: "t1-x", role: "qa", plan_step: null, state: "completed", handoff_prompt: "x" }));
		mkdirSync(join(d, "t2-y.events.jsonl"));
		const r = exec(d);
		check("missing events file is skipped, exit 0", r.status === 0 && /skipped: .*t1-x\.events\.jsonl/.test(r.stdout));
	} finally { rmSync(d, { recursive: true, force: true }); }
}
{
	const r = exec(run, "--baseline", base);
	check("--baseline prints deltas", r.status === 0 && /t2-plan-step-builder plan-step-builder step 1: handoffTokens \+6, turns \+1, toolCalls \+1, input \+4, output \+6, cacheRead \+8, cacheWrite \+10, guardDenials \+1/.test(r.stdout));
}
{
	// handoff tokens: 2, 10, 1 -> median 2
	const j = JSON.parse(exec(run, "--json").stdout);
	check("median handoff tokens correct", j.medianHandoffTokens === 2 && j.tasks.map((t: any) => t.handoffTokens).join() === "2,10,1");
}

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("trace-report tests passed");
