/**
 * Mock/lint test: the shipped instructions must forbid parallel dependent
 * commands and writing secrets to disk. Run: npx tsx extensions/orchestrator-guardrail/instructions-test.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { ROLES } from "../../lib/roles.ts";
import { workerFooter } from "../../lib/handoff-footer.ts";

/** Ceiling for worker-common.md; the plan target is 900 (see docs/verification-log.md for the measured number). */
const WORKER_COMMON_TOKEN_CEILING = 900;
const root = new URL("../../", import.meta.url);
const skill = readFileSync(new URL("skills/foreman/SKILL.md", root), "utf8");
const pr = readFileSync(new URL("skills/plan-runner/SKILL.md", root), "utf8");
const readRef = (n: string): string => (existsSync(new URL(`references/${n}.md`, root)) ? readFileSync(new URL(`references/${n}.md`, root), "utf8") : "");
const delegationRef = readRef("foreman-delegation");
const auditRef = readRef("foreman-audit");
const shipper = readFileSync(new URL("agents/shipper.md", root), "utf8");
let failures = 0;
const check = (l: string, c: boolean, _detail?: string) => { console.log(`${c ? "ok " : "FAIL"} - ${l}`); if (!c) failures++; };
check("skill forbids parallel dependent steps", /Dependent steps are sequential, never parallel/.test(skill + delegationRef));
check("skill names git push + gh pr create example", /`git push` and\s+`gh pr create`/.test(skill + delegationRef));
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
check("worker-common names run-suites with a literal command", /node \{\{PACKAGE_ROOT\}\}\/scripts\/run-suites\.mjs .*(npm|node|py):/.test(common) && /--pyright/.test(common) && /qa-logs/.test(common));
check("worker-common: package root + language rule + no delegation", /Package root: \{\{PACKAGE_ROOT\}\}/.test(common) && /User language:/.test(common) && /cannot delegate/.test(common));
check("handoff template has Build instructions and names the coordinator footer", (() => { const t = readFileSync(new URL("templates/handoff-prompt.md", root), "utf8"); return /Build instructions:/.test(t) && /footer/.test(t) && !/^## User language/m.test(t); })());
check("plan-runner §2 names Build instructions and the footer", /Build instructions:/.test(pr) && /footer/.test(pr));
check("foreman skill has a Language section", /^## Language/m.test(skill) && /User language:/.test(skill) && /footer/.test(skill));
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
check("footer helper carries User language and the orchestrator-mode line", (() => { const f = workerFooter({ locale: "en", cwd: "/x" }); return /User language: en/.test(f) && /Orchestrator mode does not apply to you/.test(f); })());

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
check("review template: SHAs and User language", /BASE_SHA/.test(reviewTpl) && /HEAD_SHA/.test(reviewTpl) && /footer/.test(reviewTpl));
check("release template: Review section and User language", /^## Review/m.test(releaseTpl) && /Reviewer task id/.test(releaseTpl) && /Verdict: approve/.test(releaseTpl) && /footer/.test(releaseTpl));
check("foreman skill flow: reviewer -> qa-bugfix + re-review -> shipper", /Review, then ship/.test(delegationRef) && /changes-requested/.test(delegationRef) && /review-handoff-prompt\.md/.test(delegationRef) && /`shipper`/.test(skill + delegationRef));
check("foreman SKILL.md <= 14000 chars", skill.length <= 14000, String(skill.length));
check("SKILL.md keeps the role list sentence, not-in-mode, Never dispatch shipper, Language", /`role` is one of/.test(skill) && /not-in-mode/.test(skill) && /Never dispatch `shipper` without a `reviewer` pass/.test(skill) && /^## Language/m.test(skill));
check("SKILL.md points to foreman-audit.md and foreman-delegation.md with a condition", /(If|When|if|when)[^\n]*references\/foreman-audit\.md|references\/foreman-audit\.md[^\n]*(if|when)/i.test(skill) && /(when|if)[^\n]*references\/foreman-delegation\.md|references\/foreman-delegation\.md[^\n]*(when|if)/i.test(skill));
check("delegation reference holds Review, then ship, changes-requested, review-handoff-prompt.md", /Review, then ship/.test(delegationRef) && /changes-requested/.test(delegationRef) && /review-handoff-prompt\.md/.test(delegationRef));
check("audit reference holds the audit path and the existing-codebase audit", /codebase-auditor/.test(auditRef) && /improve-codebase-architecture/.test(auditRef));
check("no stray Portuguese in the new references", delegationRef !== "" && auditRef !== "" && strayPortuguese(delegationRef).length === 0 && strayPortuguese(auditRef).length === 0);
check("plan-runner flow: reviewer pass then shipper offer", /`reviewer`/.test(pr) && /review-handoff-prompt\.md/.test(pr) && /`shipper`/.test(pr));
check("never lists forbid shipper without an approved review", /Never dispatch `shipper` without a `reviewer` pass/.test(skill) && /Never dispatch `shipper` without a `reviewer` pass/.test(pr));
check("code-review-discipline names reviewer role and verdict", (() => { const t = readFileSync(new URL("references/code-review-discipline.md", root), "utf8"); return /`reviewer` role/.test(t) && /Verdict: changes-requested/.test(t) && /before `shipper`/.test(t); })());
// --- Phase C step 14: grilling reuse and loop rules -------------------------
const fallbackRef = readRef("grilling-fallback");
const optDeps = readRef("optional-dependencies");
check("skill §2 names grilling and the fallback reference", /`grilling`/.test(skill) && /grill-me/.test(skill) && /references\/grilling-fallback\.md/.test(skill));
check("grilling-fallback.md exists and has the interview prompts", /edge cases/.test(fallbackRef) && /scope boundaries/.test(fallbackRef) && /actual problem/.test(fallbackRef));
check("skill loop mentions report:, Attempt and verified:", /report: N lines/.test(skill) && /Attempt N/.test(skill) && /verified: yes/.test(skill) && /verified: no/.test(skill));
check("delegation spot-check rule counts verified: yes", /verified: yes/.test(delegationRef));
check("optional-dependencies lists grilling", /`grilling`/.test(optDeps) && /`grill-me`/.test(optDeps));
// --- Phase C step 15: plan-runner Status, preflight, baseline, Attempt ------
check("plan-runner names ## Status, preflight, baseline unavailable, Attempt, report:, verified:", /## Status/.test(pr) && /preflight/.test(pr) && /baseline unavailable/.test(pr) && /Attempt N/.test(pr) && /report: N lines/.test(pr) && /verified: yes/.test(pr) && /verified: no/.test(pr) && /plan_step: 0/.test(pr));
check("plan-runner still has Build instructions and Language", /Build instructions:/.test(pr) && /^## Language/m.test(pr));
const builderAgent = readFileSync(new URL("agents/plan-step-builder.md", root), "utf8");
check("builder agent mentions Status merged and baseline unavailable", /## Status/.test(builderAgent) && /`merged`/.test(builderAgent) && /baseline unavailable/.test(builderAgent));
check("never lists unchanged (plan-runner)", /Never build or edit a step yourself/.test(pr) && /Never dispatch `shipper` without a `reviewer` pass/.test(pr) && /Never dispatch a step without `plan_slug` and `plan_step`/.test(pr));
// --- Phase C step 16: planner pre-flight ------------------------------------
const plannerMd = readFileSync(new URL("agents/planner.md", root), "utf8");
check("planner: pre-flight names capture tool and runner existence, gaps under Risks", /Renders: yes/.test(plannerMd) && /capture tool/.test(plannerMd) && /command -v/.test(plannerMd) && /node_modules\/\.bin/.test(plannerMd) && /Risks/.test(plannerMd) && /Seams: prefer existing seams/.test(plannerMd));
// --- Phase C step 17: reviewer QA coverage ----------------------------------
check("review template has QA covered up to", /QA covered up to: <sha or none>/.test(reviewTpl));
check("reviewer.md names qa-needed and the diff --stat rule", /qa-needed: <QA_SHA>\.\.<HEAD_SHA>/.test(reviewer) && /git diff --stat <QA_SHA>\.\.HEAD/.test(reviewer) && /QA covered up to/.test(reviewer));
check("skills and delegation reference route qa-needed to qa", [pr, delegationRef].every((t) => /qa-needed/.test(t) && /`qa`/.test(t)));
check("reviewer stays read-only (tools line unchanged)", /^tools: read, grep, find, bash$/m.test(reviewer) && /writes? no files/.test(reviewer));
// B1 (phase C step 18): worker-common rewrite.
{
	const tokens = Math.ceil(common.length / 4);
	check("worker-common <= 900 tokens", tokens <= WORKER_COMMON_TOKEN_CEILING, `${tokens} tokens`);
	const gotchas = /^### Gotchas\n([\s\S]*?)(?=^### )/m.exec(common)?.[1] ?? "";
	check("worker-common has ## Gotchas with the five listed items", gotchas !== "" && [/literal/i, /one literal command/i, /`\.foreman\/`/, /python3 -c/, /Guard-denied:/].every((r) => r.test(gotchas)) && /nested/i.test(gotchas) && /git show <sha>:<path>/.test(gotchas));
	const neg = common.split("\n").filter((l) => /^- +\**(Never|Don't|Do not|No|Not)\b/.test(l));
	check("at most 3 negation-led bullets in worker-common (hard guardrails only)", neg.length <= 3, neg.join(" | "));
	check("report contract block and Guard-denied unchanged", /Status: completed \| failed \| blocked\nSummary: <≤400 chars, in the user's language>\nFiles: <comma-separated paths, or none>\nRulings: <"Ruling: what — why" lines, or none>\nBlocked-on: <what\/who, or none>\nGuard-denied: <each command the worker guard refused, one per line, or none>\nRendered: <screenshot paths under \.foreman\/, "unrendered", or "n\/a">/.test(common));
	check("run-suites command still literal", common.includes("node {{PACKAGE_ROOT}}/scripts/run-suites.mjs --cwd <repo> py:a.py npm:test"));
	const guardDoc = readFileSync(new URL("references/worker-guard.md", root), "utf8");
	const spot = ["Stuck twice", "baseline-diff.mjs", "Receiving a review", "git show <sha>:<path>", "python3 -c", "Review feedback"];
	check("no rule text duplicated between worker-common and worker-guard (spot list of 6 phrases)", spot.every((p) => common.includes(p) && !guardDoc.includes(p)), spot.filter((p) => !common.includes(p) || guardDoc.includes(p)).join(","));
	check("worker-guard points to worker-common and has nested-worktree and loop-rebinding notes", /worker-common\.md/.test(guardDoc) && /nested/i.test(guardDoc) && /innermost/i.test(guardDoc) && /printf -v/.test(guardDoc));
	check("worker-common: Package root line first and {{PACKAGE_ROOT}} used for scripts", /^Package root: \{\{PACKAGE_ROOT\}\}/m.test(common) && /\{\{PACKAGE_ROOT\}\}\/scripts\/baseline-diff\.mjs/.test(common));
}
if (failures) process.exit(1);
