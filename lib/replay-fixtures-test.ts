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

// --- A2 slim-handoff gate ---
const slim = names.map((n) => { try { return readFileSync(join(dir, n.replace(/\.json$/, ".slim.md")), "utf8"); } catch { return ""; } });
const tok = (t: string) => Math.ceil(t.length / 4);
const tokens = slim.map(tok);
const sorted = [...tokens].sort((a, b) => a - b);
const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : Infinity;
console.log(`slim handoff tokens: ${tokens.join(", ")} (originals: ${fixtures.map((f) => f?.baseline.handoffTokens).join(", ")}); median ${med} vs target 350`);
check("slim fixtures: median tokens <= 350", slim.length === 3 && slim.every((s) => s.length > 0) && med <= 350);
const pathsOf = (t: string) => new Set((t.match(/(?:\/|\.\.\/)?[\w.\-]+(?:\/[\w.\-]+)+|\b[\w\-]+\.(?:py|md|html|js|css|json|txt|sqlite)\b/g) ?? []).filter((p) => p.includes(".") || p.startsWith("/")));
check("slim fixtures keep every path named in the original",
	slim.length === 3 && fixtures.every((f, i) => f && slim[i] && [...pathsOf(f.handoff_prompt)].every((p) => slim[i].includes(p))));
const tplDir = new URL("../templates/", import.meta.url).pathname;
const tpl = (n: string) => { try { return readFileSync(join(tplDir, n), "utf8"); } catch { return ""; } };
const allTpl = ["handoff-prompt.md", "review-handoff-prompt.md", "release-handoff-prompt.md"].map(tpl);
check("templates no longer contain About orchestrator mode", allTpl.every((t) => t && !/About orchestrator mode/.test(t) && !/^## User language/m.test(t)));
check("handoff template still has Build instructions", /Build instructions:/.test(allTpl[0]));
const skDir = new URL("../skills/", import.meta.url).pathname;
const sk = (n: string) => { try { return readFileSync(join(skDir, n, "SKILL.md"), "utf8"); } catch { return ""; } };
check("skills reference the footer", /footer/i.test(sk("foreman")) && /footer/i.test(sk("plan-runner")));

if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log("replay fixtures tests passed");
