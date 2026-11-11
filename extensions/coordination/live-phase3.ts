/**
 * Live Phase 3 check over `pi --mode rpc` in a temp dir with the marker.
 *  1. Runs one orchestrator turn that asks the model to call `subagent`.
 *  2. Runs a probe extension command (/probe-tools) that dumps pi.getActiveTools()
 *     and pi.getAllTools() names (there is no RPC command for the tool list).
 *  Expect: foreman_delegate active, subagent absent from the active set; any
 *  `subagent` tool call is denied/unavailable. Prints the evidence.
 * Env: LIVE_TIMEOUT_MS (default 240000), LIVE_PI (default "pi").
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 240_000);
const dir = mkdtempSync(join(tmpdir(), "foreman-live3-"));
writeFileSync(join(dir, ".orchestrator-active"), "");
const out = join(dir, "probe-out.json");
const probe = join(dir, "probe-ext.ts");
writeFileSync(
	probe,
	`import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("probe-tools", { description: "dump tools", handler: async () => {
    writeFileSync(${JSON.stringify(out)}, JSON.stringify({ active: pi.getActiveTools(), all: pi.getAllTools().map((t) => t.name) }));
  } });
}
`,
);

const events: string[] = [];
const t0 = Date.now();
const note = (s: string) => { const l = `+${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`; events.push(l); console.log(l); };

const proc = spawn(process.env.LIVE_PI ?? "pi", ["--mode", "rpc", "--no-session", "-e", probe], {
	cwd: dir,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, FOREMAN_PI_SUBAGENT: undefined as unknown as string },
});
let stderr = "";
proc.stderr.on("data", (d) => (stderr += d.toString()));

let settled = 0;
const subagentCalls: string[] = [];
const subagentErrors: boolean[] = [];
let assistantText = "";
let buf = "";
proc.stdout.on("data", (d) => {
	buf += d.toString();
	const lines = buf.split("\n");
	buf = lines.pop() ?? "";
	for (const l of lines) {
		let ev: any;
		try { ev = JSON.parse(l.replace(/\r$/, "")); } catch { continue; }
		if (ev.type === "agent_settled") { settled++; note("agent_settled"); }
		else if (ev.type === "tool_execution_start") { note(`tool_execution_start ${ev.toolName}`); if (ev.toolName === "subagent") subagentCalls.push("start"); }
		else if (ev.type === "tool_execution_end") { if (ev.toolName === "subagent") subagentErrors.push(!!ev.isError);
			note(`tool_execution_end ${ev.toolName} isError=${ev.isError} ${JSON.stringify(ev.result?.content?.[0]?.text ?? "").slice(0, 200)}`); }
		else if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const t = (ev.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
			if (t) { assistantText += t + "\n"; note(`assistant: ${t.slice(0, 300).replace(/\n/g, " ")}`); }
		} else if (ev.type === "response" && !ev.success) note(`response error: ${ev.error}`);
	}
});

const send = (o: object) => proc.stdin.write(`${JSON.stringify(o)}\n`);
const waitSettled = async (n: number) => {
	const deadline = Date.now() + TIMEOUT_MS;
	while (settled < n && Date.now() < deadline && proc.exitCode === null) await new Promise((r) => setTimeout(r, 300));
	return settled >= n;
};

send({ id: "p1", type: "prompt", message: "Orchestrator test. Call the `subagent` tool right now with agent \"qa\" and task \"say hi\". If you have no such tool or the call is denied, say exactly which, in one line, and stop. Do not use any other tool." });
note("prompt 1 sent (ask for subagent)");
const ok1 = await waitSettled(1);
send({ id: "p2", type: "prompt", message: "/probe-tools" });
note("probe command sent");
await new Promise((r) => setTimeout(r, 4000));
proc.stdin.end();
await new Promise((r) => setTimeout(r, 1500));
if (proc.exitCode === null) proc.kill("SIGTERM");

let probeData: { active: string[]; all: string[] } | undefined;
if (existsSync(out)) probeData = JSON.parse(readFileSync(out, "utf8"));
console.log("\n--- tool lists ---");
console.log(JSON.stringify(probeData, null, 1));
if (stderr.trim()) console.log(`--- stderr (tail) ---\n${stderr.slice(-600)}`);
const checks: Record<string, boolean> = {
	"prompt 1 settled": ok1,
	"probe produced tool lists": !!probeData,
	"active tools include foreman_delegate": !!probeData?.active.includes("foreman_delegate"),
	"active tools exclude subagent": !!probeData && !probeData.active.includes("subagent"),
	"active tools exclude bash/write/edit": !!probeData && !["bash", "write", "edit"].some((t) => probeData!.active.includes(t)),
	"any subagent call was denied/not-found (isError), none succeeded": subagentErrors.every((e) => e),
};
console.log(`\nsubagent tool_execution_start count: ${subagentCalls.length}`);
console.log("--- checks ---");
let pass = true;
for (const [k, v] of Object.entries(checks)) { console.log(`${v ? "ok " : "FAIL"} - ${k}`); if (!v) pass = false; }
rmSync(dir, { recursive: true, force: true });
console.log(pass ? "\nLIVE PASS" : "\nLIVE FAIL");
process.exit(pass ? 0 : 1);
