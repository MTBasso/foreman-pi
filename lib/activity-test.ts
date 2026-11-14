import { readFileSync } from "node:fs";
import { createActivityTracker } from "./activity.ts";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };

const ame = (e: Record<string, unknown>, usage?: Record<string, unknown>) => ({ type: "message_update", usage, assistantMessageEvent: e });
const toolStart = (toolName: string, args: Record<string, unknown>) => ({ type: "tool_execution_start", toolCallId: "c", toolName, args });
const toolEnd = (toolName: string, o: { isError?: boolean; text?: string; durationMs?: number } = {}) => ({
	type: "tool_execution_end", toolCallId: "c", toolName, isError: o.isError ?? false, durationMs: o.durationMs,
	result: { content: [{ type: "text", text: o.text ?? "ok" }] },
});

// recorded stream (real pi 1.5.2 output; the model had no thinking block, so thinking is covered synthetically below)
{
	const lines = readFileSync(new URL("./testdata/worker-stream.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
	const t = createActivityTracker({});
	t.reset(0);
	const phases: string[] = [];
	let now = 0;
	for (const l of lines) { now += 10; t.feed(JSON.parse(l), now); const p = t.view(now).phase; if (phases[phases.length - 1] !== p) phases.push(p); }
	const iw = phases.indexOf("writing"), it = phases.indexOf("tool"), ir = phases.lastIndexOf("reporting");
	check(`recorded stream phases writing < tool < reporting (${phases.join(">")})`, iw >= 0 && it > iw && ir > it);
	const v = t.view(now);
	check("recorded stream: 1 tool call, 2 turns, tokens and cost counted", v.toolCalls === 1 && v.turns === 2 && v.outTokens === 84 && v.cost > 0);
	check("recorded stream: recent has the bash call and health is active", v.recent.length === 1 && v.recent[0].label.startsWith("bash ls -la") && v.health === "active" && v.denials === 0);
}
{
	const t = createActivityTracker({});
	t.reset(0);
	t.feed(ame({ type: "thinking_start" }), 1);
	check("thinking with no text: phase only, empty label", t.view(1).phase === "thinking" && t.view(1).label === "");
	t.feed(ame({ type: "thinking_delta", delta: "x".repeat(100) + "the end" }), 2);
	const v = t.view(2);
	check("thinking label is the last 70 chars", v.phase === "thinking" && v.label.length === 70 && v.label.endsWith("the end"));
	t.feed(ame({ type: "toolcall_start", toolName: "write" }), 3);
	check("phase order thinking then writing", t.view(3).phase === "writing");
	t.feed(ame({ type: "text_delta", delta: "hi" }), 4);
	check("text_delta is reporting", t.view(4).phase === "reporting");
	t.feed({ type: "turn_end" }, 5);
	check("turn_end is waiting and counts the turn", t.view(5).phase === "waiting" && t.view(5).turns === 1);
}

// toolcall_delta bytes
{
	const t = createActivityTracker({});
	t.reset(0);
	t.feed(ame({ type: "toolcall_start", toolName: "write" }), 1);
	t.feed(ame({ type: "toolcall_delta", delta: '{"path":"app/static/js/builder.js","content":"' }), 2);
	t.feed(ame({ type: "toolcall_delta", delta: "y".repeat(2000) }), 3);
	const v = t.view(3);
	check("toolcall_delta bytes accumulate into the label", v.phase === "writing" && v.bytes > 2000 && v.label.startsWith("write app/static/js/builder.js") && v.label.endsWith("2 KB"));
	t.feed(ame({ type: "toolcall_delta", delta: "y".repeat(2000) }), 4);
	check("label grows with more bytes", t.view(4).label.endsWith("4 KB"));
}

// silent / waiting
{
	const t = createActivityTracker({});
	t.reset(0);
	t.feed(ame({ type: "text_delta", delta: "a" }), 1000);
	check("fresh event is active", t.view(10_000).health === "active");
	check("20-90 s is waiting", t.view(30_000).health === "waiting");
	check("silent stream flips to silent after the threshold", t.view(1000 + 91_000).health === "silent");
	const t2 = createActivityTracker({ stuckAfterMs: 0 });
	t2.reset(0);
	t2.feed(ame({ type: "text_delta", delta: "a" }), 0);
	check("stuckAfterMs 0 disables silent", t2.view(600_000).health === "waiting");
	const t3 = createActivityTracker({ stuckAfterMs: 30_000 });
	t3.reset(0);
	t3.feed(ame({ type: "text_delta", delta: "a" }), 0);
	check("custom stuckAfterMs is honoured", t3.view(29_000).health === "waiting" && t3.view(31_000).health === "silent");
}
{
	const t = createActivityTracker({});
	t.reset(0);
	t.feed(toolStart("bash", { command: "npm test" }), 0);
	check("tool running 70 s is waiting, not silent", t.view(70_000).health === "waiting");
	check("tool running 300 s is still waiting, not silent", t.view(300_000).health === "waiting");
	check("tool phase label is the command head", t.view(1000).phase === "tool" && t.view(1000).label === "npm test");
	t.feed(toolEnd("bash", { durationMs: 70_000 }), 70_000);
	const v = t.view(70_000);
	check("tool end clears the tool and records the duration", v.recent.length === 1 && v.recent[0].durationMs === 70_000 && v.phase !== "tool");
	const t2 = createActivityTracker({});
	t2.reset(0);
	t2.feed(toolStart("bash", { command: "npm test" }), 0);
	check("tool running 10 s is active", t2.view(10_000).health === "active");
}

// repeating
{
	const t = createActivityTracker({});
	t.reset(0);
	for (let i = 0; i < 2; i++) { t.feed(toolStart("bash", { command: "npm test" }), i * 10); t.feed(toolEnd("bash"), i * 10 + 5); }
	check("two identical calls are not yet repeating", t.view(30).health === "active");
	t.feed(toolStart("bash", { command: "npm test" }), 30); t.feed(toolEnd("bash"), 35);
	check("three identical bash calls flip to repeating", t.view(40).health === "repeating");
	t.feed(toolStart("bash", { command: "ls" }), 50); t.feed(toolEnd("bash"), 55);
	check("a different target resets the repeat count", t.view(60).health === "active");
	for (let i = 0; i < 2; i++) { t.feed(toolStart("bash", { command: "npm test" }), 70 + i); t.feed(toolEnd("bash"), 71 + i); }
	check("repeat count restarted after a different target", t.view(80).health === "active");
	const t2 = createActivityTracker({});
	t2.reset(0);
	for (let i = 0; i < 3; i++) { t2.feed(toolStart("read", { path: "a.ts" }), i); t2.feed(toolEnd("read"), i); }
	check("repeat is keyed by tool and path too", t2.view(5).health === "repeating");
	const t3 = createActivityTracker({});
	t3.reset(0);
	for (const [n, p] of [["read", "a"], ["write", "a"], ["read", "a"]] as const) { t3.feed(toolStart(n, { path: p }), 1); t3.feed(toolEnd(n), 1); }
	check("different tool same target does not repeat", t3.view(5).health === "active");
}

// denial
{
	const t = createActivityTracker({});
	t.reset(0);
	t.feed(toolStart("bash", { command: "rm -rf x" }), 1);
	t.feed(toolEnd("bash", { isError: true, text: "Blocked by the foreman worker guard: rm outside the sandbox. Stop that command" }), 2);
	let v = t.view(3);
	check("guard denial sets denied and counts", v.health === "denied" && v.denials === 1 && v.lastDenial.startsWith("Blocked by the foreman worker guard"));
	t.feed(toolStart("bash", { command: "ls" }), 4); t.feed(toolEnd("bash", { isError: true, text: "exit 1" }), 5);
	v = t.view(6);
	check("a non-guard error is not a denial", v.denials === 1 && v.health === "active");
	t.feed(toolStart("bash", { command: "ls" }), 7); t.feed(toolEnd("bash", { isError: false, text: "Blocked by the foreman worker guard: x" }), 8);
	check("denial text without isError is not a denial", t.view(9).denials === 1);
	t.feed(toolStart("bash", { command: "rm y" }), 10);
	t.feed(toolEnd("bash", { isError: true, text: "Blocked by the foreman worker guard: again" }), 11);
	check("second denial counts", t.view(12).denials === 2);
}

// reset
{
	const t = createActivityTracker({});
	t.reset(0);
	t.feed(ame({ type: "thinking_delta", delta: "abc" }, { output: 50, cost: { total: 1 } }), 1);
	t.feed(toolStart("bash", { command: "x" }), 2); t.feed(toolEnd("bash", { isError: true, text: "Blocked by the foreman worker guard: z" }), 3);
	t.feed({ type: "turn_end" }, 4);
	t.reset(100_000);
	const v = t.view(100_000);
	check("reset clears everything for a retry attempt", v.phase === "idle" && v.label === "" && v.turns === 0 && v.toolCalls === 0 && v.outTokens === 0 && v.cost === 0 && v.recent.length === 0 && v.denials === 0 && v.lastDenial === "" && v.health === "active" && v.lastEventAt === 100_000);
}

// unknown / malformed
{
	const t = createActivityTracker({});
	t.reset(0);
	let threw = false;
	try {
		for (const e of [null, undefined, 5, "x", {}, { type: 7 }, { type: "wat" }, { type: "message_update" }, ame({ type: "mystery" }), ame({ type: "thinking_delta" }), { type: "tool_execution_start" }, { type: "tool_execution_end" }, { type: "message_update", usage: "x", assistantMessageEvent: 3 }])
			t.feed(e, 5);
	} catch { threw = true; }
	check("unknown events are ignored without throwing", !threw);
	check("unknown event does not touch lastEventAt", createActivityTracker({}).view(0).lastEventAt === 0);
	const u = createActivityTracker({});
	u.reset(0);
	u.feed({ type: "wat" }, 500);
	check("unknown event leaves lastEventAt alone", u.view(600).lastEventAt === 0);
}

// ring
{
	const t = createActivityTracker({});
	t.reset(0);
	for (let i = 0; i < 8; i++) { t.feed(toolStart("bash", { command: `cmd${i}` }), i); t.feed(toolEnd("bash"), i); }
	const v = t.view(10);
	check("ring keeps only the last 5 actions", v.recent.length === 5 && v.recent[0].label === "bash cmd3" && v.recent[4].label === "bash cmd7" && v.toolCalls === 8);
}

// tokens across messages
{
	const t = createActivityTracker({});
	t.reset(0);
	t.feed({ type: "message_start", message: { role: "assistant" } }, 1);
	t.feed(ame({ type: "text_delta", delta: "a" }, { output: 10, cost: { total: 0.5 } }), 2);
	t.feed(ame({ type: "text_delta", delta: "a" }, { output: 30, cost: { total: 0.75 } }), 3);
	t.feed({ type: "message_start", message: { role: "assistant" } }, 4);
	t.feed(ame({ type: "text_delta", delta: "a" }, { output: 5, cost: { total: 0.25 } }), 5);
	const v = t.view(5);
	check("cumulative usage per message is summed across messages", v.outTokens === 35 && v.cost === 1);
}

if (failures) { console.log(`${failures} activity check(s) failed`); process.exit(1); }
console.log("activity ok");
