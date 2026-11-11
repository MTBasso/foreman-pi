/**
 * Mock/lint test: the shipped instructions must forbid parallel dependent
 * commands and writing secrets to disk. Run: npx tsx extensions/orchestrator-guardrail/instructions-test.ts
 */
import { readFileSync } from "node:fs";
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
check("foreman skill: subagent not for dispatch", /do not use\s+either for dispatch/.test(skill));
check("foreman skill no longer calls workflow tool for audit", !/Call the `workflow` tool/.test(skill));
check("plan-runner dispatches via foreman_delegate", /foreman_delegate/.test(pr));
check("plan-runner says extension writes the ledger", /extension writes that ledger/.test(pr));
check("plan-runner passes plan_slug and plan_step", /plan_slug/.test(pr) && /plan_step/.test(pr));
check("plan-runner ends turn and never polls", /END YOUR TURN/.test(pr) && /never poll/.test(pr));
check("plan-runner has no manual ledger append", !/append\s+one line/.test(pr));
if (failures) process.exit(1);
