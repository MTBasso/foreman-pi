import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };

const dir = new URL("./testdata/replay", import.meta.url).pathname;
const names = (() => { try { return readdirSync(dir).filter((n) => /^readme-gap-step-\d+\.json$/.test(n)).sort(); } catch { return []; } })();
const fixtures = names.map((n) => { try { return JSON.parse(readFileSync(join(dir, n), "utf8")); } catch { return undefined; } });
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

check("each fixture parses and has role, plan_step, handoff_prompt, baseline",
	fixtures.length === 3 && fixtures.every((f) => f && typeof f.role === "string" && num(f.plan_step)
		&& typeof f.handoff_prompt === "string" && f.handoff_prompt.length > 0
		&& f.source && typeof f.source.run_id === "string" && typeof f.source.task_id === "string"
		&& f.baseline && ["handoffTokens", "turns", "toolCalls", "input", "output", "cacheRead", "cacheWrite"].every((k) => num(f.baseline[k]))
		&& f.baseline.guardDenials && num(f.baseline.guardDenials.total) && typeof f.baseline.guardDenials.byReason === "object"));
check("fixture handoff token counts equal baseline.handoffTokens",
	fixtures.length === 3 && fixtures.every((f) => f && Math.ceil(f.handoff_prompt.length / 4) === f.baseline.handoffTokens));
check("fixtures cover steps 0, 6 and 15", fixtures.map((f) => f?.plan_step).sort((a, b) => a - b).join() === "0,6,15");

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("replay fixtures tests passed");
