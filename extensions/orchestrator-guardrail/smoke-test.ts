/**
 * Standalone smoke test for the guardrail logic, run with:
 *   npx tsx extensions/orchestrator-guardrail/smoke-test.ts
 *
 * Does not spin up a real Pi session (no live runtime available in this
 * environment) — it fakes just enough of ExtensionAPI/ExtensionContext to
 * exercise the tool_call handler directly against the real type contract.
 * This is Phase 0's "does the logic actually block/allow the right things"
 * check; a real `pi --extension` run is the next step once Pi itself is
 * available (see README.md "Status").
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

function makeFakeApi() {
	const handlers: Record<string, Handler[]> = {};
	let activeTools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
	const api = {
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
	};
	return { api, handlers, getActiveTools: () => activeTools };
}

async function fire(handlers: Record<string, Handler[]>, event: string, payload: any, ctx: any) {
	let result: any;
	for (const h of handlers[event] ?? []) {
		result = (await h(payload, ctx)) ?? result;
	}
	return result;
}

async function main() {
	const dir = mkdtempSync(join(tmpdir(), "foreman-pi-smoke-"));
	const ctx = { cwd: dir };
	const { api, handlers, getActiveTools } = makeFakeApi();
	await extension(api as any);

	let failures = 0;
	const check = (label: string, cond: boolean) => {
		console.log(`${cond ? "ok " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};

	// 1. No marker: everything allowed, tools untouched.
	let r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("write allowed with no marker", r === undefined);

	// 2. Marker present: write/edit blocked.
	writeFileSync(join(dir, ".orchestrator-active"), "");
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("write blocked with marker", r?.block === true);

	r = await fire(handlers, "tool_call", { toolName: "edit", input: { path: "src/app.js", edits: [] } }, ctx);
	check("edit blocked with marker", r?.block === true);

	// 3. FOREMAN_MEMORY.md exception still allowed.
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "FOREMAN_MEMORY.md", content: "x" } }, ctx);
	check("FOREMAN_MEMORY.md write allowed with marker", r === undefined);

	// 4. Bash write-pattern blocked, read-only bash allowed.
	r = await fire(handlers, "tool_call", { toolName: "bash", input: { command: "sed -i s/a/b/ src/app.js" } }, ctx);
	check("sed -i blocked with marker", r?.block === true);

	r = await fire(handlers, "tool_call", { toolName: "bash", input: { command: "npm test" } }, ctx);
	check("plain bash allowed with marker", r === undefined);

	r = await fire(handlers, "tool_call", { toolName: "bash", input: { command: "npm test > out.log 2>&1" } }, ctx);
	check("bash redirect to .log allowed with marker", r === undefined);

	// 5. turn_start proactively drops write/edit from active tools.
	await fire(handlers, "turn_start", {}, ctx);
	const active = getActiveTools();
	check("write removed from active tools", !active.includes("write"));
	check("edit removed from active tools", !active.includes("edit"));
	check("bash kept in active tools", active.includes("bash"));

	rmSync(dir, { recursive: true, force: true });

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main();
