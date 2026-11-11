/**
 * Standalone smoke test for the guardrail logic, run with:
 *   npx tsx extensions/orchestrator-guardrail/smoke-test.ts
 *
 * Does not spin up a real Pi session — it fakes just enough of
 * ExtensionAPI/ExtensionContext (including a real `pi.events` bus) to drive the
 * handlers. Orchestrator mode is driven through the `foreman:mode` event, the
 * session entry and FOREMAN_PI_MODE, never through a file.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { MODE_ENTRY_TYPE, MODE_EVENT } from "../../lib/mode.ts";
import extension from "./index.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

const ALL_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "subagent", "foreman_delegate"];

function makeFakeApi(initial: string[] = ALL_TOOLS) {
	const handlers: Record<string, Handler[]> = {};
	let activeTools = [...initial];
	const events = createEventBus();
	const api = {
		events,
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
		getActiveTools: () => activeTools,
		getAllTools: () => ALL_TOOLS.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
	};
	return { api, handlers, events, getActiveTools: () => activeTools };
}

async function fire(handlers: Record<string, Handler[]>, event: string, payload: any, ctx: any) {
	let result: any;
	for (const h of handlers[event] ?? []) {
		result = (await h(payload, ctx)) ?? result;
	}
	return result;
}

async function main() {
	const savedSubagentEnv = process.env.FOREMAN_PI_SUBAGENT;
	const savedModeEnv = process.env.FOREMAN_PI_MODE;
	delete process.env.FOREMAN_PI_SUBAGENT;
	delete process.env.FOREMAN_PI_MODE;
	const dir = mkdtempSync(join(tmpdir(), "foreman-pi-smoke-"));
	const ctx = { cwd: dir };
	const { api, handlers, events, getActiveTools } = makeFakeApi();
	await extension(api as any);

	let failures = 0;
	const check = (label: string, cond: boolean, _detail?: string) => {
		console.log(`${cond ? "ok " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};

	// 1. Mode off: everything allowed, tools untouched.
	let r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("write allowed when orchestrator mode is off", r === undefined);

	// A leftover marker file from an older version changes nothing.
	writeFileSync(join(dir, [".orchestrator", "active"].join("-")), "");
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("a stray leftover marker file has no effect (still allowed)", r === undefined);

	// 2. Mode on (via the foreman:mode event): write/edit blocked.
	events.emit(MODE_EVENT, { active: true });
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("write blocked while orchestrator mode is on", r?.block === true && /\/foreman off/.test(r.reason) && !/marker/i.test(r.reason));

	r = await fire(handlers, "tool_call", { toolName: "edit", input: { path: "src/app.js", edits: [] } }, ctx);
	check("edit blocked while orchestrator mode is on", r?.block === true);

	// 3. FOREMAN_MEMORY.md exception still allowed.
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "FOREMAN_MEMORY.md", content: "x" } }, ctx);
	check("FOREMAN_MEMORY.md write allowed while orchestrator mode is on", r === undefined);
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: join(dir, "FOREMAN_MEMORY.md"), content: "x" } }, ctx);
	check("absolute root FOREMAN_MEMORY.md write allowed while orchestrator mode is on", r === undefined);
	r = await fire(handlers, "tool_call", { toolName: "edit", input: { path: "FOREMAN_MEMORY.md", edits: [] } }, ctx);
	check("FOREMAN_MEMORY.md edit allowed while orchestrator mode is on", r === undefined);
	for (const path of ["sub/FOREMAN_MEMORY.md", "/tmp/FOREMAN_MEMORY.md"]) {
		r = await fire(handlers, "tool_call", { toolName: "write", input: { path, content: "x" } }, ctx);
		check(`non-root ${path} write blocked while orchestrator mode is on`, r?.block === true);
	}

	// 4. bash is blocked outright, read-only or not.
	for (const command of ["sed -i s/a/b/ src/app.js", "npm test", "cat package.json", "echo x > a.txt"]) {
		r = await fire(handlers, "tool_call", { toolName: "bash", input: { command } }, ctx);
		check(`bash blocked while orchestrator mode is on: ${command}`, r?.block === true);
	}

	// 5. turn_start proactively drops write/edit from active tools.
	await fire(handlers, "turn_start", {}, ctx);
	const active = getActiveTools();
	check("write removed from active tools", !active.includes("write"));
	check("edit removed from active tools", !active.includes("edit"));
	check("bash removed from active tools", !active.includes("bash"));
	check("read kept in active tools", active.includes("read"));
	check("active tools are exactly the allowlist", active.every((t: string) => ["read", "grep", "find", "ls", "foreman_delegate"].includes(t)));
	check("foreman_delegate kept in active tools", active.includes("foreman_delegate"));
	check("subagent removed from active tools at turn_start", !active.includes("subagent"));

	// Re-enabling bash/write/edit mid-session is re-stripped next turn and still blocked.
	api.setActiveTools([...getActiveTools(), "bash", "write", "edit", "subagent", "foreman_delegate"]);
	await fire(handlers, "turn_start", {}, ctx);
	check("re-enabled bash/write/edit stripped again", !["bash", "write", "edit"].some((t) => getActiveTools().includes(t)));
	check("subagent removed (not an orchestrator tool)", !getActiveTools().includes("subagent"));
	check("foreman_delegate survives turn_start", getActiveTools().includes("foreman_delegate"));
	check("active tools never include bash/write/edit", !["bash", "write", "edit"].some((t) => getActiveTools().includes(t)));
	r = await fire(handlers, "tool_call", { toolName: "foreman_delegate", input: { role: "qa", handoff_prompt: "x" } }, ctx);
	check("foreman_delegate call not blocked while orchestrator mode is on", r === undefined);
	r = await fire(handlers, "tool_call", { toolName: "subagent", input: { agent: "qa", task: "x" } }, ctx);
	check("hand-crafted subagent call blocked", r?.block === true && /foreman_delegate/.test(r.reason));
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "a.js", content: "x" } }, ctx);
	check("write still blocked", r?.block === true);
	r = await fire(handlers, "tool_call", { toolName: "edit", input: { path: "a.js", edits: [] } }, ctx);
	check("edit still blocked", r?.block === true);
	r = await fire(handlers, "tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
	check("bash call still blocked after re-enable", r?.block === true);

	// The mode switch itself restricted the tools at once (no turn needed).
	// Tools restore: turn the mode off, everything saved comes back.
	events.emit(MODE_EVENT, { active: false });
	check("off: bash/write/edit/subagent return after the mode turns off", ["bash", "write", "edit", "subagent"].every((t) => getActiveTools().includes(t)));
	check("off: previously active tools all restored", ALL_TOOLS.every((t) => getActiveTools().includes(t)));
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("off: write allowed again", r === undefined);
	r = await fire(handlers, "tool_call", { toolName: "bash", input: { command: "ls" } }, ctx);
	check("off: bash allowed again", r === undefined);
	await fire(handlers, "turn_start", {}, ctx);
	check("off: turn_start leaves the tools alone", ["bash", "write", "edit"].every((t) => getActiveTools().includes(t)));
	events.emit(MODE_EVENT, { active: true });
	check("on again: restricted immediately", getActiveTools().join() === "read,grep,find,ls,foreman_delegate", getActiveTools().join());
	events.emit(MODE_EVENT, { active: true });

	// Regression: a live `pi` session confirmed that when foreman-pi is
	// installed as a package, this extension auto-loads into subagent-dispatch's
	// child `pi` processes too (default extension discovery), not just the
	// orchestrator. subagent-dispatch sets FOREMAN_PI_SUBAGENT=1 on each child
	// specifically so this extension can tell the two apart and exempt the child.
	process.env.FOREMAN_PI_SUBAGENT = "1";
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("write allowed in subagent child despite orchestrator mode", r === undefined);
	r = await fire(handlers, "tool_call", { toolName: "bash", input: { command: "sed -i s/a/b/ src/app.js" } }, ctx);
	check("bash allowed in subagent child despite orchestrator mode", r === undefined);
	r = await fire(handlers, "tool_call", { toolName: "subagent", input: {} }, ctx);
	check("subagent call not blocked in child (exempt)", r === undefined);
	delete process.env.FOREMAN_PI_SUBAGENT;

	// A parent's FOREMAN_PI_MODE inherited by a child cannot override the exemption.
	process.env.FOREMAN_PI_SUBAGENT = "1";
	process.env.FOREMAN_PI_MODE = "orchestrator";
	r = await fire(handlers, "tool_call", { toolName: "write", input: { path: "src/app.js", content: "x" } }, ctx);
	check("child with inherited FOREMAN_PI_MODE=orchestrator is still exempt", r === undefined);
	{
		const child = makeFakeApi();
		await extension(child.api as any);
		await fire(child.handlers, "session_start", { reason: "startup" }, { cwd: dir, sessionManager: { getBranch: () => [{ type: "custom", customType: MODE_ENTRY_TYPE, data: { active: true } }] } });
		await fire(child.handlers, "turn_start", {}, ctx);
		check("child never has its tools restricted", child.getActiveTools().length === ALL_TOOLS.length);
	}
	delete process.env.FOREMAN_PI_SUBAGENT;
	delete process.env.FOREMAN_PI_MODE;

	// State from the session entry (restore) and the env override.
	{
		const a = makeFakeApi();
		await extension(a.api as any);
		const branch = [{ type: "custom", customType: MODE_ENTRY_TYPE, data: { active: true } }];
		await fire(a.handlers, "session_start", { reason: "resume" }, { cwd: dir, sessionManager: { getBranch: () => branch } });
		check("entry active (resume): tools restricted and bash blocked", a.getActiveTools().join() === "read,grep,find,ls,foreman_delegate" && (await fire(a.handlers, "tool_call", { toolName: "bash", input: { command: "ls" } }, ctx))?.block === true);

		const b = makeFakeApi();
		await extension(b.api as any);
		await fire(b.handlers, "session_start", { reason: "startup" }, { cwd: dir, sessionManager: { getBranch: () => [] } });
		check("fresh startup (no entry): inactive, tools untouched", b.getActiveTools().length === ALL_TOOLS.length && (await fire(b.handlers, "tool_call", { toolName: "write", input: { path: "a", content: "x" } }, ctx)) === undefined);

		process.env.FOREMAN_PI_MODE = "orchestrator";
		const c = makeFakeApi();
		await extension(c.api as any);
		check("FOREMAN_PI_MODE=orchestrator: blocks with no entry or event", (await fire(c.handlers, "tool_call", { toolName: "write", input: { path: "a", content: "x" } }, ctx))?.block === true);
		await fire(c.handlers, "turn_start", {}, ctx);
		check("FOREMAN_PI_MODE=orchestrator: turn_start restricts tools", c.getActiveTools().join() === "read,grep,find,ls,foreman_delegate");
		process.env.FOREMAN_PI_MODE = "off";
		c.events.emit(MODE_EVENT, { active: true });
		check("FOREMAN_PI_MODE=off beats an active event", (await fire(c.handlers, "tool_call", { toolName: "write", input: { path: "a", content: "x" } }, ctx)) === undefined);
		delete process.env.FOREMAN_PI_MODE;
	}

	// Tools restore after a simulated /reload: no saved list in the new instance.
	{
		// Entry says "off" now, but the old instance left the tool set restricted.
		const reloaded = makeFakeApi(["read", "grep", "find", "ls", "foreman_delegate"]);
		await extension(reloaded.api as any);
		await fire(reloaded.handlers, "session_start", { reason: "reload" }, { cwd: dir, sessionManager: { getBranch: () => [{ type: "custom", customType: MODE_ENTRY_TYPE, data: { active: false } }] } });
		const t = reloaded.getActiveTools();
		check("reload while off: bash/write/edit restored from built-in defaults", ["bash", "write", "edit", "read"].every((x) => t.includes(x)) && t.includes("foreman_delegate") && t.includes("grep"), t.join());

		// Turning off with no saved list (mode was entered, then the extension reloaded): union with defaults.
		const r2 = makeFakeApi(["read", "grep", "find", "ls", "foreman_delegate"]);
		await extension(r2.api as any);
		await fire(r2.handlers, "session_start", { reason: "reload" }, { cwd: dir, sessionManager: { getBranch: () => [{ type: "custom", customType: MODE_ENTRY_TYPE, data: { active: true } }] } });
		check("reload while on: stays restricted", r2.getActiveTools().join() === "read,grep,find,ls,foreman_delegate");
		r2.events.emit(MODE_EVENT, { active: false });
		const t2 = r2.getActiveTools();
		check("off with no saved list: union of current tools and defaults (bash/write/edit return)", ["bash", "write", "edit", "read", "grep", "find", "ls", "foreman_delegate"].every((x) => t2.includes(x)), t2.join());

		// A user's deliberately reduced tool set is not widened on reload when delegation is absent.
		const custom = makeFakeApi(["read", "grep"]);
		await extension(custom.api as any);
		await fire(custom.handlers, "session_start", { reason: "reload" }, { cwd: dir, sessionManager: { getBranch: () => [] } });
		check("reload: a custom reduced tool set without foreman_delegate is left alone", custom.getActiveTools().join() === "read,grep");
	}

	rmSync(dir, { recursive: true, force: true });
	if (savedModeEnv !== undefined) process.env.FOREMAN_PI_MODE = savedModeEnv;
	if (savedSubagentEnv !== undefined) process.env.FOREMAN_PI_SUBAGENT = savedSubagentEnv;

	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main();
