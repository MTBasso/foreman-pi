import * as fs from "node:fs";
import * as path from "node:path";
import { PACKAGE_ROOT } from "./agents.ts";
import { buildForemanPrompt, readSkillBody, stripFrontmatter } from "../extensions/foreman-mode/prompts.ts";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };

function frontmatter(name: string): { raw: string; flag?: string } {
	const text = fs.readFileSync(path.join(PACKAGE_ROOT, "skills", name, "SKILL.md"), "utf8");
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const raw = m ? m[1] : "";
	const f = /^disable-model-invocation:\s*(\S+)\s*$/m.exec(raw);
	return { raw, flag: f?.[1] };
}

for (const n of ["foreman", "plan-runner"]) {
	check(`foreman and plan-runner have disable-model-invocation: true (${n})`, frontmatter(n).flag === "true");
}
for (const n of ["design-preview", "project-memory"]) {
	check(`design-preview and project-memory do not (${n})`, frontmatter(n).flag === undefined && /^name:/m.test(frontmatter(n).raw));
}
const body = readSkillBody("foreman");
check("skill body has no frontmatter", !body.startsWith("---") && !body.includes("disable-model-invocation") && body.startsWith("# Foreman"));
check("stripFrontmatter yields the body for every skill", ["foreman", "plan-runner", "design-preview", "project-memory"].every((n) => !readSkillBody(n).startsWith("---")));
const prompt = buildForemanPrompt("add a thing", PACKAGE_ROOT);
check("/foreman prompt still embeds the skill body without frontmatter", prompt.includes(body) && !prompt.includes("disable-model-invocation"));
check("stripFrontmatter on plain text is identity", stripFrontmatter("x") === "x");
if (failures) process.exit(1);
console.log("all checks passed");
