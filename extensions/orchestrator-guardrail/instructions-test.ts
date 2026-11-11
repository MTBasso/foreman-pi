/**
 * Mock/lint test: the shipped instructions must forbid parallel dependent
 * commands and writing secrets to disk. Run: npx tsx extensions/orchestrator-guardrail/instructions-test.ts
 */
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const skill = readFileSync(new URL("skills/foreman/SKILL.md", root), "utf8");
const pr = readFileSync(new URL("skills/plan-runner/SKILL.md", root), "utf8");
const rm = readFileSync(new URL("agents/release-manager.md", root), "utf8");
let failures = 0;
const check = (l: string, c: boolean) => { console.log(`${c ? "ok " : "FAIL"} - ${l}`); if (!c) failures++; };
check("skill forbids parallel dependent steps", /Dependent steps are sequential, never parallel/.test(skill));
check("skill names git push + gh pr create example", /`git push` and\s+`gh pr create`/.test(skill));
check("release-manager forbids parallel push/PR", /Never issue `git push`\s+and `gh pr create`/.test(rm));
check("skill forbids writing secrets to disk", /Never write a file containing secrets to disk/.test(skill));
check("skill says deliver secrets in chat", /in the chat/.test(skill) && /copy/.test(skill));
check("foreman skill dispatches via foreman_delegate", /foreman_delegate/.test(skill));
check("foreman skill says END YOUR TURN", /END YOUR TURN/.test(skill));
check("foreman skill says never poll", /[Nn]ever poll/.test(skill));
check("foreman skill names <task-notification>", /<task-notification>/.test(skill));
check("foreman skill: no 'either for dispatch' leftover", !/do not use\s+either for dispatch/.test(skill));
// Lint: no line may instruct using subagent/workflow to dispatch. Lines saying
// it is unavailable/not available are fine.
const dispatchLint = (name: string, text: string) => {
	const bad = text.split("\n").filter((l) => {
		if (!/`(subagent|workflow)`/.test(l)) return false;
		if (/unavailable|not available|never use|do not use|isn't available/i.test(l)) return false;
		return true;
	});
	check(`${name}: no subagent/workflow dispatch instruction${bad.length ? " -> " + bad[0].trim() : ""}`, bad.length === 0);
	check(`${name}: no 'subagent tool' / 'workflow tool' calls`, !/(call|use|invoke|via)\s+(the\s+)?`?(subagent|workflow)`?(\s+tool)?/i.test(text.replace(/(never|not|n't)\s+(call|use|invoke)\s+(the\s+)?`?(subagent|workflow)/gi, "")));
};
dispatchLint("foreman skill", skill);
dispatchLint("plan-runner", pr);
check("lint is precise: catches a bad line", (() => { let hit = false; const t = "Dispatch with `subagent` for each task."; hit = t.split("\n").some((l) => /`(subagent|workflow)`/.test(l) && !/unavailable|not available|never use|do not use|isn't available/i.test(l)); return hit; })());
check("foreman skill requires role and plan_step on every dispatch", /Every dispatch must carry `role` and `plan_step`/.test(skill));
check("plan-runner requires role, plan_step, plan_slug", /carries `role`, `plan_step` and `plan_slug`/.test(pr));
check("foreman skill no longer calls workflow tool for audit", !/Call the `workflow` tool/.test(skill));
check("plan-runner dispatches via foreman_delegate", /foreman_delegate/.test(pr));
check("plan-runner says extension writes the ledger", /extension writes that ledger/.test(pr));
check("plan-runner passes plan_slug and plan_step", /plan_slug/.test(pr) && /plan_step/.test(pr));
check("plan-runner ends turn and never polls", /END YOUR TURN/.test(pr) && /never poll/.test(pr));
check("plan-runner has no manual ledger append", !/append\s+one line/.test(pr));

// --- Phase 4: prompt cleanup lints -----------------------------------------
const mdFiles = (dir: string): string[] =>
	readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? mdFiles(`${dir}${e.name}/`) : e.name.endsWith(".md") ? [`${dir}${e.name}`] : [],
	);
const agentFiles = mdFiles("agents/");
for (const f of agentFiles) {
	const t = readFileSync(new URL(f, root), "utf8");
	check(`${f}: no 'hand off to'`, !/hand off to/i.test(t));
	check(`${f}: no 'claude plugin'`, !/claude plugin/i.test(t));
	check(`${f}: no 'npm install -g'`, !/npm install -g/.test(t));
	check(`${f}: no '.claude/skills'`, !/\.claude\/skills/.test(t));
	check(`${f}: no copied 'Working discipline' block`, !/^## Working discipline/m.test(t));
	check(`${f}: description says dispatched via foreman_delegate`, /^description:.*foreman_delegate/m.test(t));
}
const allProse = [...agentFiles, ...mdFiles("skills/"), ...mdFiles("references/"), ...mdFiles("templates/")];
for (const f of allProse.filter((x) => !x.startsWith("agents/"))) {
	const t = readFileSync(new URL(f, root), "utf8");
	check(`${f}: no 'claude plugin' / '.claude/skills'`, !/claude plugin|\.claude\/skills/i.test(t));
}
const common = readFileSync(new URL("references/worker-common.md", root), "utf8");
check("worker-common: contract markers", /--- foreman-report ---/.test(common) && /--- end foreman-report ---/.test(common));
check("worker-common: package root + language rule + no delegation", /Package root: \{\{PACKAGE_ROOT\}\}/.test(common) && /User language:/.test(common) && /cannot delegate/.test(common));
check("handoff template has Build instructions and User language", (() => { const t = readFileSync(new URL("templates/handoff-prompt.md", root), "utf8"); return /Build instructions:/.test(t) && /User language:/.test(t); })());
check("plan-runner §2 names Build instructions and User language", /Build instructions:/.test(pr) && /User language:/.test(pr));
check("foreman skill has a Language section", /^## Language/m.test(skill) && /User language:/.test(skill));
check("plan-runner has a Language section", /^## Language/m.test(pr));
// Stray-Portuguese lint: pt-BR diacritics or stopwords outside `[pt-BR]`-tagged lines.
const PT_DIACRITICS = /[áàâãéêíóôõúç]/i;
const PT_STOPWORDS = /\b(você|voce|não|uma|para|isso|está|pra|esse|muito|obrigado|também|então|ótimo|quer)\b/i;
const strayPortuguese = (text: string): string[] =>
	text
		.split("\n")
		.filter((l) => !l.includes("[pt-BR]"))
		.map((l) => l.replace(/https?:\/\/\S+/g, "").replace(/\/[\w.\/-]+/g, ""))
		.filter((l) => PT_DIACRITICS.test(l) || PT_STOPWORDS.test(l));
check("pt lint is precise: flags untagged Portuguese", strayPortuguese("Diga: você está certo").length === 1 && strayPortuguese("Diga ação").length === 1);
check("pt lint ignores [pt-BR]-tagged lines", strayPortuguese("`[pt-BR]` \"Você está certo!\"").length === 0);
check("pt lint ignores plain English and URLs", strayPortuguese("Use https://example.com/ção and the plan.").length === 0 && strayPortuguese("This is fine.").length === 0);
for (const f of allProse) {
	const bad = strayPortuguese(readFileSync(new URL(f, root), "utf8"));
	check(`${f}: no stray Portuguese${bad.length ? " -> " + bad[0].trim() : ""}`, bad.length === 0);
}
if (failures) process.exit(1);
