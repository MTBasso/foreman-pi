/**
 * Mock/lint test: the shipped instructions must forbid parallel dependent
 * commands and writing secrets to disk. Run: npx tsx extensions/orchestrator-guardrail/instructions-test.ts
 */
import { readFileSync } from "node:fs";
const root = new URL("../../", import.meta.url);
const skill = readFileSync(new URL("skills/foreman/SKILL.md", root), "utf8");
const rm = readFileSync(new URL("agents/release-manager.md", root), "utf8");
let failures = 0;
const check = (l: string, c: boolean) => { console.log(`${c ? "ok " : "FAIL"} - ${l}`); if (!c) failures++; };
check("skill forbids parallel dependent steps", /Dependent steps are sequential, never parallel/.test(skill));
check("skill names git push + gh pr create example", /`git push` and\s+`gh pr create`/.test(skill));
check("release-manager forbids parallel push/PR", /Never issue `git push`\s+and `gh pr create`/.test(rm));
check("skill forbids writing secrets to disk", /Never write a file containing secrets to disk/.test(skill));
check("skill says deliver secrets in chat", /in the chat/.test(skill) && /copy/.test(skill));
if (failures) process.exit(1);
