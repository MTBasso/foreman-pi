import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatResumeState, gatherResumeState } from "./resume-state.ts";
import { en } from "./i18n/en.ts";
import { ptBR } from "./i18n/pt-BR.ts";

let failures = 0;
const check = (n: string, ok: boolean) => {
	console.log(`${ok ? "ok " : "FAIL"} - ${n}`);
	if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "resume-state-"));
check("no .foreman/runs returns undefined", gatherResumeState(root) === undefined);

const runs = join(root, ".foreman", "runs");
const old = join(runs, "20260101-000000-aaaaaa");
const cur = join(runs, "20260102-000000-bbbbbb");
mkdirSync(old, { recursive: true });
mkdirSync(cur, { recursive: true });
mkdirSync(join(root, "docs", "plans"), { recursive: true });
mkdirSync(join(root, ".foreman", "plan-runner", "p"), { recursive: true });
writeFileSync(join(root, "docs", "plans", "p.md"), "## Steps\n\n1. **A** (Touches: a)\n\n## Status\n\n- Step 1: merged\n- Step 2: not started\n");
const lines = Array.from({ length: 30 }, (_, i) => `ledger line ${i}`);
writeFileSync(join(root, ".foreman", "plan-runner", "p", "progress.md"), lines.join("\n") + "\n");
writeFileSync(join(old, "run.json"), JSON.stringify({ run_id: "old", plan_slug: "p" }));
writeFileSync(join(cur, "run.json"), JSON.stringify({ run_id: "cur", plan_slug: "p" }));
const task = (dir: string, id: string, state: string, at: string, extra: object = {}) =>
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ task_id: id, role: "plan-step-builder", plan_step: 2, state, updated_at: at, output: `.foreman/runs/x/${id}.md`, ...extra }));
task(old, "t1-plan-step-builder", "running", "2026-01-01T00:00:00Z", { workdir: "/old/wt" });
task(cur, "t2-plan-step-builder", "completed", "2026-01-02T00:00:00Z", { workdir: "/older/wt" });
task(cur, "t3-plan-step-builder", "aborted", "2026-01-02T01:00:00Z", { workdir: "/new/wt" });
writeFileSync(join(cur, "t3-plan-step-builder.status.json"), JSON.stringify({ view: { phase: "tool", label: "edit foo.ts" } }));

const s = gatherResumeState(root)!;
check("state lists Status table, ledger tail and orphans", s.runId.endsWith("bbbbbb") && s.planSlug === "p" && s.statusLines?.length === 2 && s.progressTail.length === 20 && s.progressTail.at(-1) === "ledger line 29" && s.orphans.length === 2);
check("orphans carry the last action", s.orphans.some((o) => o.taskId === "t3-plan-step-builder" && /edit foo\.ts/.test(o.lastAction ?? "")) && !s.orphans.some((o) => o.taskId === "t2-plan-step-builder"));
check("workdir comes from the newest task json", s.workdir === "/new/wt");
const text = formatResumeState(s);
check("formatted state names status, ledger and orphan", /Step 1: merged/.test(text) && text.includes("ledger line 29") && text.includes("t3-plan-step-builder"));
check("en and pt-BR catalogs have the same keys", JSON.stringify(Object.keys(en).sort()) === JSON.stringify(Object.keys(ptBR).sort()) && "cmd.resume.none" in en);
rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
