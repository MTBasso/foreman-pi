/**
 * Mock/lint test: the shipped instructions must forbid parallel dependent
 * commands and writing secrets to disk. Run: npx tsx extensions/orchestrator-guardrail/instructions-test.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { ROLES } from "../../lib/roles.ts";

const root = new URL("../../", import.meta.url);
const skill = readFileSync(new URL("skills/foreman/SKILL.md", root), "utf8");
const pr = readFileSync(new URL("skills/plan-runner/SKILL.md", root), "utf8");
const shipper = readFileSync(new URL("agents/shipper.md", root), "utf8");
let failures = 0;
const check = (l: string, c: boolean, _detail?: string) => { console.log(`${c ? "ok " : "FAIL"} - ${l}`); if (!c) failures++; };
check("skill forbids parallel dependent steps", /Dependent steps are sequential, never parallel/.test(skill));
check("skill names git push + gh pr create example", /`git push` and\s+`gh pr create`/.test(skill));
check("shipper forbids parallel push/PR", /Never issue `git push`\s+and `gh pr create`/.test(shipper));
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

// --- Phase 7: the marker file is gone everywhere ----------------------------
// Needles are built from pieces so this test file does not contain them itself.
const needleMarker = [".orchestrator", "active"].join("-");
const needleRenamed = ["orchestrator", "marker"].join("-");
const gateFiles = (dir: string): string[] =>
	readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((e) => {
		if (e.name === "node_modules" || e.name === ".git" || e.name === ".foreman") return [];
		return e.isDirectory() ? gateFiles(`${dir}${e.name}/`) : [`${dir}${e.name}`];
	});
// README.md is rewritten in Phase 10; PLAN.md, docs/plans/ and CHANGELOG are historical.
const gated = ["extensions/", "lib/", "scripts/", "skills/", "references/", "templates/", "agents/"].flatMap(gateFiles).concat([".gitignore", "package.json"]);
const hits = gated.filter((f) => {
	const t = readFileSync(new URL(f, root), "utf8");
	return t.includes(needleMarker) || t.includes(needleRenamed);
});
check(`grep gate: no '${needleMarker}' or '${needleRenamed}' in code, skills, references, templates${hits.length ? " -> " + hits.join(", ") : ""}`, hits.length === 0);
check("grep gate scans a meaningful number of files", gated.length > 40, String(gated.length));
check("references/orchestrator-mode.md exists, the marker doc is gone", existsSync(new URL("references/orchestrator-mode.md", root)) && !existsSync(new URL(`references/${needleRenamed}.md`, root)));
const modeDoc = readFileSync(new URL("references/orchestrator-mode.md", root), "utf8");
check("orchestrator-mode.md: commands, env var, /foreman off, only the user leaves", /\/foreman off/.test(modeDoc) && /FOREMAN_PI_MODE/.test(modeDoc) && /\/foreman`/.test(modeDoc) && /Only the user leaves/.test(modeDoc));
check("skills §0 point at orchestrator-mode.md and the commands, with no touch/gitignore step", /orchestrator-mode\.md/.test(skill) && /orchestrator-mode\.md/.test(pr) && /\/foreman`/.test(skill) && /\/plan-runner/.test(pr) && !/touch \./.test(skill + pr) && !/touch \S*orchestrator/.test(skill + pr));
check("skills tell the model to ask for /foreman on a not-in-mode refusal", /not-in-mode/.test(skill) && /not-in-mode/.test(pr));
check(".gitignore no longer lists the marker", !readFileSync(new URL(".gitignore", root), "utf8").includes(needleMarker));
check("templates/handoff-prompt.md says orchestrator mode does not apply to workers", /About orchestrator mode/.test(readFileSync(new URL("templates/handoff-prompt.md", root), "utf8")));

// --- Phase 8: reviewer and shipper roles ------------------------------------
const readme = readFileSync(new URL("README.md", root), "utf8");
const dropped = ["release", "manager"].join("-");
const reviewer = readFileSync(new URL("agents/reviewer.md", root), "utf8");
check("ROLES has reviewer and shipper, not the dropped role", ROLES.includes("reviewer") && ROLES.includes("shipper") && !(ROLES as readonly string[]).includes(dropped));
check("every ROLES entry has an agents/<role>.md and nothing else is there", ROLES.every((r) => existsSync(new URL(`agents/${r}.md`, root))) && agentFiles.length === ROLES.length);
check("agents/ has no dropped-role file", !existsSync(new URL(`agents/${dropped}.md`, root)));
const foremanRoleList = skill.match(/`role` is one of\s+((?:`[a-z-]+`,?\s*)+)/)?.[1].match(/[a-z-]+/g) ?? [];
check("drift: foreman skill role list equals ROLES", JSON.stringify([...foremanRoleList].sort()) === JSON.stringify([...ROLES].sort()), foremanRoleList.join(","));
const readmeRoles = readme.match(/\| `role` \| enum \| ([^|]+)\|/)?.[1].match(/`([a-z-]+)`/g)?.map((x) => x.replace(/`/g, "")) ?? [];
check("drift: README foreman_delegate role table equals ROLES", JSON.stringify([...readmeRoles].sort()) === JSON.stringify([...ROLES].sort()), readmeRoles.join(","));
check("README agents row names every role", ROLES.every((r) => readme.split("\n").some((l) => l.includes("agents/") && l.includes(`\`${r}\``))));
const roleGate = [...gated, "README.md"].filter((f) => readFileSync(new URL(f, root), "utf8").includes(dropped));
check(`drift: the dropped role name appears nowhere in code, agents, skills, templates, README${roleGate.length ? " -> " + roleGate.join(", ") : ""}`, roleGate.length === 0);
check("reviewer: tier strong, thinking high, tools read/grep/find/bash", /^tier: strong$/m.test(reviewer) && /^thinking: high$/m.test(reviewer) && /^tools: read, grep, find, bash$/m.test(reviewer));
check("reviewer: reads git diff BASE..HEAD, writes no files, English verdict tokens", /git diff BASE\.\.HEAD/.test(reviewer) && /writes? no files/.test(reviewer) && /Verdict: approve/.test(reviewer) && /Verdict: changes-requested/.test(reviewer) && /User language/.test(reviewer));
check("reviewer: Status completed/blocked/failed rules", /`Status: completed`/.test(reviewer) && /`Status: blocked`/.test(reviewer) && /`Status: failed`/.test(reviewer));
check("shipper: tier mid, thinking low", /^tier: mid$/m.test(shipper) && /^thinking: low$/m.test(shipper));
check("shipper: requires review reference, blocked otherwise", /## Review/.test(shipper) && /Status: blocked/.test(shipper) && /changes-requested/.test(shipper) && /Blocked-on: review reference/.test(shipper));
check("shipper: AgentShield optional, never installed", /optional/.test(shipper) && /never install it/.test(shipper));
check("shipper: no push/PR without explicit instruction", /Do not push and do not open a PR unless the handoff explicitly says to/.test(shipper));
const reviewTpl = readFileSync(new URL("templates/review-handoff-prompt.md", root), "utf8");
const releaseTpl = readFileSync(new URL("templates/release-handoff-prompt.md", root), "utf8");
check("review template: SHAs and User language", /BASE_SHA/.test(reviewTpl) && /HEAD_SHA/.test(reviewTpl) && /User language:/.test(reviewTpl));
check("release template: Review section and User language", /^## Review/m.test(releaseTpl) && /Reviewer task id/.test(releaseTpl) && /Verdict: approve/.test(releaseTpl) && /User language:/.test(releaseTpl));
check("foreman skill flow: reviewer -> qa-bugfix + re-review -> shipper", /Review, then ship/.test(skill) && /changes-requested/.test(skill) && /review-handoff-prompt\.md/.test(skill) && /`shipper`/.test(skill));
check("plan-runner flow: reviewer pass then shipper offer", /`reviewer`/.test(pr) && /review-handoff-prompt\.md/.test(pr) && /`shipper`/.test(pr));
check("never lists forbid shipper without an approved review", /Never dispatch `shipper` without a `reviewer` pass/.test(skill) && /Never dispatch `shipper` without a `reviewer` pass/.test(pr));
check("code-review-discipline names reviewer role and verdict", (() => { const t = readFileSync(new URL("references/code-review-discipline.md", root), "utf8"); return /`reviewer` role/.test(t) && /Verdict: changes-requested/.test(t) && /before `shipper`/.test(t); })());
if (failures) process.exit(1);
