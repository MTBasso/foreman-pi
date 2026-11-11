/**
 * Tests for lib/model-policy.ts and the frontmatter parsing of tier/thinking.
 * Run with: npx tsx lib/model-policy-test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "./agents.ts";
import { resolveModel, roleEnvKey } from "./model-policy.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
	console.log(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
}

const A = { name: "plan-step-builder", tier: "mid", thinking: "medium" } as const;

// [label, agent, env, session, expected]
const table: Array<[string, any, Record<string, string>, any, { model?: string; thinking?: string }]> = [
	["no env: inherit session model, frontmatter thinking", A, {}, { model: "foreman/hybrid", thinking: "low" }, { model: "foreman/hybrid", thinking: "medium" }],
	["no env, no session: nothing set except frontmatter thinking", A, {}, {}, { model: undefined, thinking: "medium" }],
	["tier env applies", A, { FOREMAN_MODEL_MID: "p/m" }, { model: "foreman/hybrid" }, { model: "p/m", thinking: "medium" }],
	["tier env of another tier ignored", A, { FOREMAN_MODEL_STRONG: "p/s" }, { model: "foreman/hybrid" }, { model: "foreman/hybrid", thinking: "medium" }],
	["frontmatter model beats tier env", { ...A, model: "p/fm" }, { FOREMAN_MODEL_MID: "p/m" }, {}, { model: "p/fm", thinking: "medium" }],
	["role env beats frontmatter model and tier env", { ...A, model: "p/fm" }, { FOREMAN_MODEL_MID: "p/m", FOREMAN_MODEL_PLAN_STEP_BUILDER: "p/r" }, {}, { model: "p/r", thinking: "medium" }],
	["role thinking env beats frontmatter", A, { FOREMAN_THINKING_PLAN_STEP_BUILDER: "high" }, { thinking: "off" }, { model: undefined, thinking: "high" }],
	["invalid role thinking env falls through to frontmatter", A, { FOREMAN_THINKING_PLAN_STEP_BUILDER: "bogus" }, {}, { model: undefined, thinking: "medium" }],
	["no frontmatter thinking: session level", { name: "x" }, {}, { thinking: "high" }, { model: undefined, thinking: "high" }],
	["empty env values ignored", A, { FOREMAN_MODEL_MID: "  ", FOREMAN_MODEL_PLAN_STEP_BUILDER: "" }, { model: "s/m" }, { model: "s/m", thinking: "medium" }],
	["no tier: tier env not consulted", { name: "x" }, { FOREMAN_MODEL_MID: "p/m" }, {}, { model: undefined, thinking: undefined }],
];
for (const [label, agent, env, session, exp] of table) {
	const got = resolveModel(agent, env, session);
	check(label, got.model === exp.model && got.thinking === exp.thinking, JSON.stringify(got));
}
check("roleEnvKey", roleEnvKey("qa-bugfix") === "QA_BUGFIX" && roleEnvKey("plan-step-builder") === "PLAN_STEP_BUILDER");

// Arg-building: model/thinking flags exactly as spawn-worker pushes them.
function buildArgs(r: { model?: string; thinking?: string }) {
	const a: string[] = [];
	if (r.model) a.push("--model", r.model);
	if (r.thinking) a.push("--thinking", r.thinking);
	return a;
}
check("args: inherit passes no --model", !buildArgs(resolveModel(A, {}, { model: undefined })).includes("--model"));
check(
	"args: foreman/hybrid session passes through unchanged",
	buildArgs(resolveModel(A, {}, { model: "foreman/hybrid" })).join(" ") === "--model foreman/hybrid --thinking medium",
);

// Frontmatter parsing + shipped agents.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-policy-test-"));
const prevDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
fs.mkdirSync(path.join(root, "agent", "agents"), { recursive: true });
fs.mkdirSync(path.join(root, "project"), { recursive: true });
try {
	fs.writeFileSync(
		path.join(root, "agent", "agents", "bad.md"),
		"---\nname: bad\ndescription: d\ntier: huge\nthinking: ludicrous\n---\nbody\n",
	);
	fs.writeFileSync(
		path.join(root, "agent", "agents", "good.md"),
		"---\nname: good\ndescription: d\ntier: cheap\nthinking: xhigh\n---\nbody\n",
	);
	const { agents } = discoverAgents(path.join(root, "project"), "user");
	const by = (n: string) => agents.find((a) => a.name === n)!;
	check("invalid tier/thinking ignored with notes", by("bad").tier === undefined && by("bad").thinking === undefined && by("bad").notes?.length === 2);
	check("valid tier/thinking parsed", by("good").tier === "cheap" && by("good").thinking === "xhigh" && !by("good").notes);

	const expected: Record<string, [string, string]> = {
		planner: ["strong", "high"],
		"frontend-dev": ["mid", "medium"],
		"backend-dev": ["mid", "medium"],
		"qa-bugfix": ["mid", "medium"],
		"plan-step-builder": ["mid", "medium"],
		qa: ["cheap", "low"],
		"codebase-auditor": ["cheap", "low"],
		reviewer: ["strong", "high"],
		shipper: ["mid", "low"],
	};
	for (const [n, [t, th]] of Object.entries(expected)) {
		const a = by(n);
		check(`shipped ${n}: ${t}/${th}, no model id, no notes`, a.tier === t && a.thinking === th && a.model === undefined && !a.notes);
	}
	check("FOREMAN_MODEL_STRONG changes only strong-tier roles", agents
		.filter((a) => a.source === "package")
		.every((a) => (resolveModel(a, { FOREMAN_MODEL_STRONG: "p/s" }, { model: "S" }).model === "p/s") === (a.tier === "strong")));
} finally {
	if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevDir;
	fs.rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall model-policy checks passed");
