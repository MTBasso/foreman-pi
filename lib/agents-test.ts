/**
 * Tests for lib/agents.ts (agent discovery).
 * Run with: npx tsx lib/agents-test.ts
 *
 * Spawns no `pi` process. Uses temp dirs for PI_CODING_AGENT_DIR and cwd so the
 * real user config and any enclosing project's .pi/agents never leak in.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "./agents.ts";
import { parseStatusSection, parseStepChecks, parseTouches, parseStepTitle } from "./plan-steps.ts";

const EXPECTED = [
	"backend-dev",
	"codebase-auditor",
	"frontend-dev",
	"plan-step-builder",
	"planner",
	"qa-bugfix",
	"qa",
	"reviewer",
	"shipper",
];

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
	console.log(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-agents-test-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
const prevDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

check(
	"worker-common.md documents Guard-denied",
	/Guard-denied:/.test(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "references", "worker-common.md"), "utf8")),
);

{
	const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
	for (const n of ["qa", "qa-bugfix", "plan-step-builder"]) {
		const t = fs.readFileSync(path.join(dir, "agents", `${n}.md`), "utf8");
		check(`${n} references run-suites`, /run-suites\.mjs/.test(t));
	}
	const now = fs.readFileSync(path.join(dir, "references", "worker-common.md"), "utf8").split("\n").length;
	const before = execFileSync("git", ["show", "4f44754:references/worker-common.md"], { cwd: dir, encoding: "utf8" }).split("\n").length;
	check("worker-common.md grew by at most 6 lines", now - before <= 6, `${before} -> ${now}`);
}

{
	const planner = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agents", "planner.md"), "utf8");
	const tools = /^tools:\s*(.*)$/m.exec(planner)?.[1]?.split(",").map((t) => t.trim()).join(",");
	check("planner tools include edit and still exclude nothing else changed", tools === "read,grep,find,bash,write,edit", String(tools));
}

{
	const planner = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agents", "planner.md"), "utf8");
	const fmt = /```markdown\n([\s\S]*?)\n```/.exec(planner)?.[1] ?? "";
	check("planner.md has Seams, Out of scope and Status in its format", /Seams:/.test(fmt) && /^## Out of scope/m.test(fmt) && /^## Status/m.test(fmt) && /- Step N: not started/.test(fmt));
	check("planner step line uses Touches and Checks", /\(Touches:/.test(fmt) && !/\(File:/.test(fmt) && /^\s*- Checks:/m.test(fmt) && /^\s*- Renders:/m.test(fmt));
	const fixture = fmt
		.replace(/<step name>/, "Do thing")
		.replace(/\(Touches:[^)]*\)/, "(Touches: `a.ts`, `b.ts`)")
		.replace(/^(\s*- Checks:).*$/m, "$1 `npm run test:a`, `npm test`")
		.replace(/^(\s*- Renders:).*$/m, "$1 no")
		.replace(/- Step N: not started/, "- Step 1: not started");
	const st = parseStatusSection(fixture);
	const ck = parseStepChecks(fixture, 1);
	check(
		"a plan following the template parses: title, touches, status, checks",
		parseStepTitle(fixture, 1) === "Do thing" &&
			JSON.stringify(parseTouches(fixture, 1)) === JSON.stringify(["a.ts", "b.ts"]) &&
			st?.get(1)?.state === "not started" &&
			JSON.stringify(ck?.npmScripts) === JSON.stringify(["test:a", "test"]),
		`${parseStepTitle(fixture, 1)} ${JSON.stringify(parseTouches(fixture, 1))} ${JSON.stringify([...(st ?? [])])} ${JSON.stringify(ck)}`,
	);
	const fm = /^---\n([\s\S]*?)\n---/.exec(planner)?.[1] ?? "";
	check(
		"planner frontmatter unchanged",
		fm === "name: planner\ndescription: Dispatched via `foreman_delegate`. Receives grilled requirements and project context from the foreman session and produces an implementation plan only. Never writes or edits code.\ntools: read, grep, find, bash, write, edit\ntier: strong\nthinking: high",
	);
}

{
	// Phase C step 19: negation-led lines per agent/template (body only, frontmatter excluded) vs. the counts before the rewrite.
	const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
	const BEFORE: Record<string, number> = {
		"agents/backend-dev.md": 1,
		"agents/codebase-auditor.md": 9,
		"agents/frontend-dev.md": 4,
		"agents/plan-step-builder.md": 3,
		"agents/planner.md": 4,
		"agents/qa-bugfix.md": 4,
		"agents/qa.md": 8,
		"agents/reviewer.md": 5,
		"agents/shipper.md": 11,
		"templates/handoff-prompt.md": 5,
		"templates/handoff-summary.md": 0,
		"templates/release-handoff-prompt.md": 1,
		"templates/review-handoff-prompt.md": 3,
	};
	const neg = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n").filter((l) => /\b(never|don't|do not|must not)\b/i.test(l)).length;
	let before = 0;
	let after = 0;
	let each = true;
	for (const [f, n] of Object.entries(BEFORE)) {
		const c = neg(fs.readFileSync(path.join(dir, f), "utf8"));
		before += n;
		after += c;
		if (c > n) each = false;
	}
	console.log(`note - negation-led lines: ${before} -> ${after}`);
	check("negation-led lines per agent file do not increase and total drops", each && after < before, `${before} -> ${after}`);
	let fmSame = true;
	for (const n of EXPECTED) {
		const fm = (t: string) => /^---\n([\s\S]*?)\n---/.exec(t)?.[1];
		const old = execFileSync("git", ["show", `0747448:agents/${n}.md`], { cwd: dir, encoding: "utf8" });
		if (fm(old) !== fm(fs.readFileSync(path.join(dir, "agents", `${n}.md`), "utf8"))) fmSame = false;
	}
	check("agent frontmatter equals the recorded snapshot", fmSame);
	const rd = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
	const reviewer = rd("agents/reviewer.md");
	const shipper = rd("agents/shipper.md");
	const auditor = rd("agents/codebase-auditor.md");
	check(
		"contract strings still present (Verdict tokens, Blocked-on: review reference, no push without instruction)",
		/Verdict: approve/.test(reviewer) && /Verdict: changes-requested/.test(reviewer) && /writes? no files/.test(reviewer) &&
			/Blocked-on: review reference/.test(shipper) && /Blocked-on: review verdict changes-requested/.test(shipper) && /Blocked-on: stale review/.test(shipper) &&
			/Do not push and do not open a PR unless the handoff explicitly says to/.test(shipper) && /Never issue `git push`\s+and `gh pr create`/.test(shipper) && /never install it/.test(shipper) &&
			/Never force-push/.test(shipper) && /FOREMAN_AUDIT\.md/.test(auditor) && /Commit only/.test(rd("templates/release-handoff-prompt.md")) && /Verdict: approve/.test(rd("templates/release-handoff-prompt.md")),
	);
	check(
		"no copied Working discipline block (agents and templates)",
		EXPECTED.every((n) => !/Working discipline|Stuck twice|Edit over Bash/i.test(rd(`agents/${n}.md`))) &&
			!/Working discipline/i.test(rd("templates/handoff-prompt.md")),
	);
}

try {
	// 1. Package agents are all discovered.
	{
		const { agents } = discoverAgents(cwd, "user");
		const found = agents.filter((a) => a.source === "package").map((a) => a.name).sort();
		for (const name of EXPECTED) check(`package agent discovered: ${name}`, found.includes(name));
		const extra = found.filter((n) => !EXPECTED.includes(n));
		if (extra.length > 0) console.log(`note - extra package agents: ${extra.join(", ")}`);
		const qa = agents.find((a) => a.name === "qa");
		check("package agent filePath is inside the package agents/ dir", !!qa && path.basename(path.dirname(qa.filePath)) === "agents" && fs.existsSync(qa.filePath));
		check("package agent has a non-empty system prompt", !!qa && qa.systemPrompt.trim().length > 0);
	}

	// 2. Frontmatter edge cases (user dir).
	{
		const w = (file: string, text: string) => fs.writeFileSync(path.join(agentDir, "agents", file), text);
		w("tools-string.md", "---\nname: t-string\ndescription: d\ntools: read, bash\n---\nbody\n");
		w("tools-array.md", "---\nname: t-array\ndescription: d\ntools: [read, grep]\n---\nbody\n");
		w("tools-bad.md", "---\nname: t-bad\ndescription: d\ntools: 42\n---\nbody\n");
		w("tools-none.md", "---\nname: t-none\ndescription: d\n---\nbody\n");
		w("no-name.md", "---\ndescription: d\n---\nbody\n");
		w("no-desc.md", "---\nname: no-desc\n---\nbody\n");
		w("model.md", "---\nname: with-model\ndescription: d\nmodel: some/model\n---\nbody\n");
		w("not-md.txt", "---\nname: not-md\ndescription: d\n---\nbody\n");
		const { agents } = discoverAgents(cwd, "user");
		const by = (n: string) => agents.find((a) => a.name === n);
		check("tools as comma string", JSON.stringify(by("t-string")?.tools) === JSON.stringify(["read", "bash"]));
		check("tools as array", JSON.stringify(by("t-array")?.tools) === JSON.stringify(["read", "grep"]));
		check("tools of wrong type -> undefined", by("t-bad") !== undefined && by("t-bad")?.tools === undefined);
		check("tools missing -> undefined", by("t-none") !== undefined && by("t-none")?.tools === undefined);
		check("missing name -> skipped", !agents.some((a) => a.filePath.endsWith("no-name.md")));
		check("missing description -> skipped", by("no-desc") === undefined);
		check("model parsed", by("with-model")?.model === "some/model");
		check("non-.md file ignored", by("not-md") === undefined);
		check("user agent tagged source=user", by("t-string")?.source === "user");
		check("body excludes frontmatter", by("t-string")?.systemPrompt.trim() === "body");
	}

	// 3. A user agent overrides a package agent of the same name.
	{
		fs.writeFileSync(
			path.join(agentDir, "agents", "qa-override.md"),
			"---\nname: qa\ndescription: user override\ntools: read\n---\nuser body\n",
		);
		const { agents } = discoverAgents(cwd, "user");
		const qas = agents.filter((a) => a.name === "qa");
		check("exactly one qa agent after override", qas.length === 1);
		check("user agent wins over package agent", qas[0]?.source === "user" && qas[0]?.description === "user override");
		const both = discoverAgents(cwd, "both").agents.find((a) => a.name === "qa");
		check("override also holds with scope=both", both?.source === "user");
	}

	// 4. Project agents: found upwards from cwd, scope gating.
	{
		const projAgents = path.join(cwd, ".pi", "agents");
		fs.mkdirSync(projAgents, { recursive: true });
		fs.writeFileSync(path.join(projAgents, "p.md"), "---\nname: proj-only\ndescription: d\n---\nbody\n");
		const sub = path.join(cwd, "a", "b");
		fs.mkdirSync(sub, { recursive: true });
		const r = discoverAgents(sub, "both");
		check("nearest project agents dir found from a subdirectory", r.projectAgentsDir === projAgents);
		check("project agent included with scope=both", r.agents.some((a) => a.name === "proj-only" && a.source === "project"));
		check("project agent excluded with scope=user", !discoverAgents(sub, "user").agents.some((a) => a.name === "proj-only"));
		check("package agents still load with scope=project", discoverAgents(sub, "project").agents.some((a) => a.name === "planner"));
	}
} finally {
	if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevDir;
	fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall agent discovery checks passed");
