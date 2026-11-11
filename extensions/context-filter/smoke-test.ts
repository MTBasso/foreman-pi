/**
 * Smoke test for the context filter (pure pruneMessages + the real `context`
 * handler against a fake ExtensionAPI). Run: npx tsx extensions/context-filter/smoke-test.ts
 */
import extension, { pruneMessages } from "./index.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
	if (cond) pass++;
	else fail++;
	console.log(`${cond ? "ok  " : "FAIL"} - ${name}`);
}

type N = { taskId: string; role: string; status: string; summary: string; output: string };
const note = (taskId: string, role: string, status = "completed"): N => ({
	taskId,
	role,
	status,
	summary: `summary of ${taskId}`,
	output: `.foreman/runs/r1/${taskId}.md`,
});
const block = (n: N) =>
	`<task-notification>\ntask-id: ${n.taskId}\nrole: ${n.role}\nstatus: ${n.status}\nplan-step: -\nsummary: ${n.summary}\noutput: ${n.output}\n</task-notification>`;
const notif = (ns: N[], withDetails = true): any => ({
	role: "custom",
	customType: "foreman-task-notification",
	content: ns.map(block).join("\n\n"),
	display: true,
	details: withDetails ? { batchId: "b", notifications: ns } : undefined,
	timestamp: 1,
});

const system = { role: "system", content: "SYSTEM PROMPT" };
const user = { role: "user", content: "do the thing", timestamp: 1 };
const asst = { role: "assistant", content: [{ type: "text", text: "dispatching" }], timestamp: 2 };
const asst2 = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 3 };
const tool = { role: "toolResult", toolCallId: "c1", toolName: "subagent", content: [{ type: "text", text: "old subagent result" }], isError: false, timestamp: 2 };
const otherCustom = { role: "custom", customType: "something-else", content: "keep me", display: true, timestamp: 2 };

const qa = [1, 2, 3, 4, 5, 6].map((i) => note(`t${i}-qa`, "qa"));
const fe = [1, 2].map((i) => note(`t${i}-frontend-dev`, "frontend-dev"));
const failedQa = note("tF-qa", "qa", "failed");
const blockedFe = note("tB-fe", "frontend-dev", "blocked");

const build = (): any[] => [
	system,
	user,
	asst,
	...qa.slice(0, 5).map((n) => notif([n])),
	notif([fe[0]]),
	tool,
	otherCustom,
	notif([fe[1]]),
	notif([failedQa]),
	notif([blockedFe]),
	asst2,
	notif([qa[5]]),
];
const text = (m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const stubOf = (arr: any[]) => arr.find((m) => m.customType === "foreman-context-pruned");
const allText = (arr: any[]) => arr.map(text).join("\n");

// keep=1
{
	const input = build();
	const snapshot = JSON.stringify(input);
	const out = pruneMessages(input, { keepPerRole: 1 });
	console.log(`keep=1: before=${input.length} after=${out.length}`);
	check("input not mutated", JSON.stringify(input) === snapshot);
	const stub = stubOf(out);
	check("stub exists", !!stub);
	check("stub says 5 older qa results", text(stub).includes("[pruned: 5 older qa results — recover: "));
	check("stub lists qa paths", qa.slice(0, 5).every((n) => text(stub).includes(n.output)));
	check("stub says 1 older frontend-dev result", text(stub).includes("[pruned: 1 older frontend-dev results — recover: .foreman/runs/r1/t1-frontend-dev.md]"));
	check("older qa text gone from notifications", qa.slice(0, 5).every((n) => !out.some((m) => m.customType === "foreman-task-notification" && text(m).includes(n.summary))));
	check("latest frontend-dev kept", out.some((m) => m.customType === "foreman-task-notification" && text(m).includes("t2-frontend-dev")));
	check("last notification untouched (same object)", out[out.length - 1] === input[input.length - 1]);
	check("failed survives", out.some((m) => text(m).includes("tF-qa") && m.customType === "foreman-task-notification"));
	check("blocked survives", out.some((m) => text(m).includes("tB-fe") && m.customType === "foreman-task-notification"));
	check("stub placed where first pruned message was", out.indexOf(stub) === 3);
	check("user/assistant/system byte-identical", [system, user, asst, asst2].every((m) => out.includes(m)));
	check("toolResult and other custom untouched", out.includes(tool) && out.includes(otherCustom));
	check("length = before - 6 pruned + 1 stub", out.length === input.length - 6 + 1);
}

// KEEP=2
{
	const input = build();
	const out = pruneMessages(input, { keepPerRole: 2 });
	console.log(`keep=2: before=${input.length} after=${out.length}`);
	const stub = stubOf(out);
	check("keep=2: 4 older qa pruned", text(stub).includes("[pruned: 4 older qa results"));
	check("keep=2: t5-qa kept", out.some((m) => m.customType === "foreman-task-notification" && text(m).includes("t5-qa")));
	check("keep=2: frontend-dev both kept, not mentioned in stub", !text(stub).includes("frontend-dev"));
}

// Batched message split
{
	const batched = notif([note("tx-qa", "qa"), note("ty-fe", "frontend-dev"), note("tz-qa-fail", "qa", "failed")]);
	const input: any[] = [user, batched, asst, notif([note("tq-qa", "qa")]), notif([note("tf-fe", "frontend-dev")])];
	const snapshot = JSON.stringify(input);
	const out = pruneMessages(input, { keepPerRole: 1 });
	console.log(`batched: before=${input.length} after=${out.length}`);
	check("batched: input not mutated", JSON.stringify(input) === snapshot);
	const rebuilt = out.find((m) => m.customType === "foreman-task-notification" && text(m).includes("tz-qa-fail"));
	check("batched: failed block retained in rebuilt message", !!rebuilt);
	check("batched: pruned blocks removed from rebuilt message", !text(rebuilt).includes("tx-qa") && !text(rebuilt).includes("ty-fe"));
	check("batched: rebuilt details filtered", rebuilt.details.notifications.length === 1 && rebuilt.details.notifications[0].taskId === "tz-qa-fail");
	check("batched: stub emitted before rebuilt message", out.indexOf(stubOf(out)) < out.indexOf(rebuilt));
}

// Regex fallback (no details)
{
	const input: any[] = [user, notif([qa[0]], false), notif([qa[1]], false)];
	const out = pruneMessages(input, { keepPerRole: 1 });
	console.log(`regex fallback: before=${input.length} after=${out.length}`);
	check("regex fallback prunes older", !allText(out).includes("summary of t1-qa") && allText(out).includes("summary of t2-qa"));
	check("regex fallback stub has path", text(stubOf(out)).includes(".foreman/runs/r1/t1-qa.md"));
}

// No notifications -> identity
{
	const input: any[] = [system, user, asst];
	check("no notifications -> same array", pruneMessages(input, { keepPerRole: 1 }) === input);
}

// Handler: PRUNE=false identity, debug logging, env KEEP
{
	const handlers: Record<string, any> = {};
	extension({ on: (ev: string, h: any) => void (handlers[ev] = h) } as any);
	check("registers a context handler", typeof handlers.context === "function");

	const errors: string[] = [];
	const origErr = console.error;
	console.error = (...a: any[]) => void errors.push(a.join(" "));
	try {
		process.env.FOREMAN_CONTEXT_DEBUG = "1";
		process.env.FOREMAN_CONTEXT_PRUNE = "false";
		let input = build();
		check("PRUNE=false -> no-op (undefined)", handlers.context({ type: "context", messages: input }) === undefined);

		delete process.env.FOREMAN_CONTEXT_PRUNE;
		input = build();
		const r = handlers.context({ type: "context", messages: input });
		check("default prunes via handler", !!r && r.messages.length === input.length - 5);
		check("debug logs before/after counts", errors.some((e) => e.includes(`before=${input.length} after=${input.length - 5} pruned-or-rebuilt=`)));

		process.env.FOREMAN_CONTEXT_KEEP_PER_ROLE = "2";
		const r2 = handlers.context({ type: "context", messages: build() });
		check("KEEP_PER_ROLE=2 via env", !!r2 && text(stubOf(r2.messages)).includes("4 older qa"));
	} finally {
		console.error = origErr;
		delete process.env.FOREMAN_CONTEXT_DEBUG;
		delete process.env.FOREMAN_CONTEXT_KEEP_PER_ROLE;
	}
	console.log(errors.join("\n"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
