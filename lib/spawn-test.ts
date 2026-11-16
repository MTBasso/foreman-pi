/**
 * Tests for lib/spawn.ts. Run with: npx tsx lib/spawn-test.ts
 *
 * Uses `node -e` as the injected invocation instead of a real `pi`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_INLINE_PROMPT_BYTES, inlineOrPointerPrompt, runPiJson, workerBaseArgs } from "./spawn.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
	console.log(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
}

const node = (script: string) => ({ command: process.execPath, args: ["-e", script] });
const cwd = os.tmpdir();

async function main() {
	// message_end events are collected; other events and junk lines are ignored.
	{
		const script = `
			const e = (m) => console.log(JSON.stringify({ type: "message_end", message: m }));
			console.log("not json");
			console.log(JSON.stringify({ type: "agent_start" }));
			e({ role: "user", content: [{ type: "text", text: "hi" }] });
			e({ role: "system", content: "ignored" });
			e({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] });
			process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } }));
		`;
		const r = await runPiJson([], { cwd, invocation: node(script) }).done;
		check("clean exit: code 0, no signal, no spawnError", r.code === 0 && r.signal === null && r.spawnError === undefined);
		check("collects user/assistant message_end, skips others", r.messages.length === 3, String(r.messages.length));
		check("unterminated last line is still parsed", r.messages[2]?.role === "assistant");
		check("stopReason recorded from assistant message", r.stopReason === "stop");
	}

	// logFile receives the raw event stream.
	{
		const lf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spawn-log-")), "ev.jsonl");
		const r = await runPiJson([], { cwd, logFile: lf, invocation: node(`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[]}}))`) }).done;
		check("logFile captures raw stdout", r.messages.length === 1 && fs.readFileSync(lf, "utf-8").includes("message_end"));
	}

	// onEvent sees every parsed event; messages and the log keep their filters.
	{
		const script = `
			const out = (o) => console.log(JSON.stringify(o));
			out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
			out({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } });
			out({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
		`;
		const seen: any[] = [];
		const lf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spawn-ev-")), "ev.jsonl");
		const r = await runPiJson([], { cwd, logFile: lf, invocation: node(script), onEvent: (e) => seen.push(e) }).done;
		const types = seen.map((e) => e.type);
		check("onEvent receives message_update and tool events that the messages array drops", types.includes("message_update") && types.includes("tool_execution_start") && types.includes("message_end"), types.join(","));
		const plain = await runPiJson([], { cwd, invocation: node(script) }).done;
		check("messages array is unchanged by onEvent", JSON.stringify(r.messages) === JSON.stringify(plain.messages) && r.messages.length === 1);
		const log = fs.readFileSync(lf, "utf-8").trim().split("\n");
		check("events log keeps only message_end lines with onEvent set", log.length === 1 && log[0].includes("message_end"));
		const thrower = await runPiJson([], { cwd, invocation: node(script), onEvent: () => { throw new Error("boom"); } }).done;
		check("a throwing onEvent does not break message collection", thrower.messages.length === 1 && thrower.code === 0);
	}

	// Error stopReason is surfaced.
	{
		const script = `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "boom", content: [] } }));`;
		const r = await runPiJson([], { cwd, invocation: node(script) }).done;
		check("errorMessage + stopReason surfaced", r.stopReason === "error" && r.errorMessage === "boom");
	}

	// Nonzero exit + stderr.
	{
		const r = await runPiJson([], { cwd, invocation: node(`console.error("bad thing"); process.exit(3);`) }).done;
		check("nonzero exit code reported", r.code === 3);
		check("stderr captured", r.stderr.includes("bad thing"));
		check("no messages on silent failure", r.messages.length === 0);
	}

	// Spawn error (command does not exist).
	{
		const r = await runPiJson([], {
			cwd,
			invocation: { command: "/nonexistent/definitely-not-a-binary", args: [] },
		}).done;
		check("spawn error reported, not thrown", typeof r.spawnError === "string" && r.spawnError.length > 0, String(r.spawnError));
		check("spawn error leaves code null", r.code === null);
	}

	// Env: merged over process.env.
	{
		const script = `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: process.env.FOREMAN_PI_SUBAGENT + ":" + (process.env.PATH ? "path" : "nopath") } }));`;
		const r = await runPiJson([], { cwd, env: { FOREMAN_PI_SUBAGENT: "1" }, invocation: node(script) }).done;
		check("env var passed and process.env inherited", r.messages[0]?.content === "1:path", String(r.messages[0]?.content));
	}

	// kill(): SIGTERM is enough for a well-behaved child.
	{
		const h = runPiJson([], { cwd, invocation: node(`setInterval(() => {}, 1000); console.log("ready");`), killGraceMs: 5000 });
		await new Promise((r) => setTimeout(r, 400));
		const t0 = Date.now();
		h.kill();
		const r = await h.done;
		check("kill -> SIGTERM terminates a normal child quickly", r.signal === "SIGTERM" && Date.now() - t0 < 3000, `${r.signal} ${Date.now() - t0}ms`);
	}

	// kill(): escalates to SIGKILL when SIGTERM is ignored.
	{
		const script = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready");`;
		const h = runPiJson([], { cwd, invocation: node(script), killGraceMs: 300 });
		await new Promise((r) => setTimeout(r, 500));
		const t0 = Date.now();
		h.kill();
		const r = await h.done;
		const dt = Date.now() - t0;
		check("kill escalates to SIGKILL when SIGTERM is ignored", r.signal === "SIGKILL", String(r.signal));
		check("escalation waited for the grace period", dt >= 250, `${dt}ms`);
	}

	// kill() after exit and before spawn are harmless.
	{
		const h = runPiJson([], { cwd, invocation: node(`process.exit(0)`) });
		await h.done;
		h.kill();
		check("kill after exit is a no-op", true);
	}

	// Oversized prompt -> pointer file.
	{
		const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-spawn-test-"));
		try {
			const small = "small prompt";
			check("small prompt passes through inline", inlineOrPointerPrompt(small, runDir, "t1-qa") === small);
			check("small prompt writes no file", fs.readdirSync(runDir).length === 0);

			const exactly = "x".repeat(MAX_INLINE_PROMPT_BYTES);
			check("prompt at exactly the limit stays inline", inlineOrPointerPrompt(exactly, runDir, "t1-qa") === exactly);

			const big = "é".repeat(MAX_INLINE_PROMPT_BYTES); // 2 bytes each -> over the limit in bytes, not chars
			const nested = path.join(runDir, "nested", "run");
			const pointer = inlineOrPointerPrompt(big, nested, "t2-planner");
			const file = path.join(nested, "t2-planner.prompt.md");
			check("oversized prompt replaced by a pointer", pointer !== big && pointer.includes(file));
			check("pointer file holds the full prompt", fs.existsSync(file) && fs.readFileSync(file, "utf-8") === big);
			check("pointer is short", Buffer.byteLength(pointer) < 1024);
		} finally {
			fs.rmSync(runDir, { recursive: true, force: true });
		}
	}

	// Step 9: the events log is always on; only the herdr pane depends on panesEnabled().
	{
		const src = fs.readFileSync(new URL("../extensions/coordination/spawn-worker.ts", import.meta.url), "utf-8");
		const m = /const logFile\s*=([^;]*);/.exec(src);
		check("events log is written without herdr", !!m && !m[1].includes("panesEnabled") && m[1].includes("events.jsonl"), m?.[1]);
		check("herdr pane stays conditional on panesEnabled()", /if \(panesEnabled\(\)\)/.test(src));
	}

	// Step 10: workers start without the user's global skills.
	{
		const base = workerBaseArgs("builder", {});
		check("workerBaseArgs includes --no-skills by default", base.includes("--no-skills"));
		check("FOREMAN_WORKER_SKILLS=1 removes it", !workerBaseArgs("builder", { FOREMAN_WORKER_SKILLS: "1" }).includes("--no-skills"));
		check("args still contain --mode json -p --no-session", base.slice(0, 4).join(" ") === "--mode json -p --no-session");
		check("no --no-extensions and no --no-context-files", !base.includes("--no-extensions") && !base.includes("--no-context-files"));

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-"));
		try {
			const dir = path.join(root, ".agents", "skills", "impeccable");
			const noHome = path.join(root, "nohome");
			const withDirOpts = { cwd: root, home: noHome };
			const emptyOpts = { cwd: path.join(root, "empty"), home: noHome };
			fs.mkdirSync(dir, { recursive: true });
			let ok = true;
			for (const role of ["qa", "frontend-dev", "codebase-auditor"]) {
				const a = workerBaseArgs(role, {}, withDirOpts);
				const i = a.indexOf("--skill");
				ok = ok && i >= 0 && a[i + 1] === dir;
			}
			check("impeccable --skill is added only for qa/frontend-dev/codebase-auditor when the dir exists", ok);
			check("no --skill when the dir is missing", !workerBaseArgs("qa", {}, emptyOpts).includes("--skill"));
			check("no --skill for other roles", !workerBaseArgs("builder", {}, withDirOpts).includes("--skill"));
			check("no --skill when FOREMAN_WORKER_SKILLS=1", !workerBaseArgs("qa", { FOREMAN_WORKER_SKILLS: "1" }, withDirOpts).includes("--skill"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
}

await main();
if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall spawn checks passed");
