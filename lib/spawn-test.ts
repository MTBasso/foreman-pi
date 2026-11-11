/**
 * Tests for lib/spawn.ts. Run with: npx tsx lib/spawn-test.ts
 *
 * Uses `node -e` as the injected invocation instead of a real `pi`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_INLINE_PROMPT_BYTES, inlineOrPointerPrompt, runPiJson } from "./spawn.ts";

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
}

await main();
if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall spawn checks passed");
