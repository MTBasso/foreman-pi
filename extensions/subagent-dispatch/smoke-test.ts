/**
 * Smoke test for the package-agent discovery patch in agents.ts.
 * Run with: npx tsx extensions/subagent-dispatch/smoke-test.ts
 *
 * Does not spawn any `pi` process (that part of index.ts is unmodified
 * upstream behavior, exercised by the real `pi` runtime, not here) — this
 * only checks that our one real change, loading agents/*.md bundled with
 * this package, actually finds foreman-pi's 8 ported agents.
 */
import { discoverAgents } from "./agents.ts";

const EXPECTED = [
	"backend-dev",
	"codebase-auditor",
	"frontend-dev",
	"plan-step-builder",
	"planner",
	"qa-bugfix",
	"qa",
	"release-manager",
];

const { agents } = discoverAgents(process.cwd(), "user");
const found = agents.filter((a) => a.source === "package").map((a) => a.name).sort();

let failures = 0;
for (const name of EXPECTED) {
	const ok = found.includes(name);
	console.log(`${ok ? "ok " : "FAIL"} - package agent discovered: ${name}`);
	if (!ok) failures++;
}

const extra = found.filter((n) => !EXPECTED.includes(n));
if (extra.length > 0) {
	console.log(`note - unexpected extra package agents found: ${extra.join(", ")}`);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log(`\nall ${EXPECTED.length} package agents discovered`);
