/**
 * Tests for lib/agents.ts (agent discovery).
 * Run with: npx tsx lib/agents-test.ts
 *
 * Spawns no `pi` process. Uses temp dirs for PI_CODING_AGENT_DIR and cwd so the
 * real user config and any enclosing project's .pi/agents never leak in.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "./agents.ts";

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
