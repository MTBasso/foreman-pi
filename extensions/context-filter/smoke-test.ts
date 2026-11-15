/**
 * Smoke test for the context filter (pure pruneMessages + the real `context`
 * handler against a fake ExtensionAPI). Run: npx tsx extensions/context-filter/smoke-test.ts
 */
import { buildRunState } from "./compaction.ts";
import extension, { pruneHandoffs, pruneMessages } from "./index.ts";

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

// Handoff pruning (A1)
{
	const big = (n: number) => `handoff ${n} ` + "x".repeat(400);
	const call = (n: number, over: any = {}) => ({
		type: "toolCall",
		id: `c${n}`,
		name: "foreman_delegate",
		arguments: { role: "plan-step-builder", plan_slug: "p", plan_step: n, handoff_prompt: big(n), ...over },
	});
	const aMsg = (parts: any[]) => ({ role: "assistant", content: parts, timestamp: 5 });
	const res = (n: number, over: any = {}): any => ({
		role: "toolResult",
		toolCallId: `c${n}`,
		toolName: "foreman_delegate",
		content: [{ type: "text", text: JSON.stringify({ task_id: `t${n}-plan-step-builder`, run_id: "r1", state: "running" }) }],
		details: { run_id: "r1", task_id: `t${n}-plan-step-builder` },
		isError: false,
		timestamp: 5,
		...over,
	});
	const hp = (m: any, k = 0) => m.content.filter((p: any) => p.type === "toolCall")[k].arguments.handoff_prompt as string;
	const turns = (): any[] => {
		const m: any[] = [system, user];
		for (let n = 1; n <= 5; n++) m.push(aMsg([call(n)]), res(n), notif([note(`t${n}-plan-step-builder`, "plan-step-builder")]));
		m.pop(); // the 5th dispatch is the latest turn (no notification yet)
		return m;
	};

	{
		const input = turns();
		const snap = JSON.stringify(input);
		const out = pruneHandoffs(input);
		const as = out.filter((m) => m.role === "assistant");
		check("5 dispatches over 5 turns: only the last turn keeps full handoff", as.slice(0, 4).every((m) => hp(m).startsWith("[handoff pruned:")) && hp(as[4]) === big(5));
		check("input messages not mutated", JSON.stringify(input) === snap);
		check("pruned stub names run, task, chars, role and step", hp(as[1]) === `[handoff pruned: ${big(2).length} chars; full text in .foreman/runs/r1/t2-plan-step-builder.json (handoff_prompt); role=plan-step-builder step=2]`);
		check("pruned call keeps role/plan_slug/plan_step", as[0].content[0].arguments.plan_slug === "p" && as[0].content[0].arguments.plan_step === 1);
		const again = pruneHandoffs(out);
		check("pruning twice yields identical output (idempotent)", JSON.stringify(again) === JSON.stringify(out));
		check("unchanged messages keep identity", out[0] === input[0] && out[1] === input[1]);
	}
	{
		const input: any[] = [user, aMsg([call(1)]), res(1), aMsg([call(2)]), res(2)];
		const out = pruneHandoffs(input);
		check("dispatches in the same latest turn all keep full text", out === input);
		const two: any[] = [user, aMsg([call(1), call(2)]), res(1), res(2), notif([note("t1", "qa")]), aMsg([call(3)]), res(3)];
		const o2 = pruneHandoffs(two);
		check("same older message: both calls pruned, latest kept", hp(o2[1], 0).startsWith("[handoff") && hp(o2[1], 1).startsWith("[handoff") && hp(o2[5]) === big(3));
	}
	{
		const input: any[] = [
			user,
			aMsg([call(1)]), // no result
			aMsg([call(2)]), res(2, { isError: true }),
			aMsg([call(3)]), res(3, { details: undefined, content: [{ type: "text", text: "not json" }] }),
			notif([note("t1", "qa")]),
			aMsg([call(4)]), res(4),
		];
		check("call without result or with error result is untouched", pruneHandoffs(input) === input);
		const viaText: any[] = [user, aMsg([call(1)]), res(1, { details: undefined }), notif([note("t1", "qa")])];
		check("ids fall back to result text JSON", hp(pruneHandoffs(viaText)[1]).includes("r1/t1-plan-step-builder.json"));
	}
	{
		const short: any[] = [user, aMsg([call(1, { handoff_prompt: "y".repeat(300) })]), res(1), notif([note("t1", "qa")])];
		check("short handoff (<=300 chars) untouched", pruneHandoffs(short) === short);
	}
	{
		const handlers: Record<string, any> = {};
		extension({ on: (ev: string, h: any) => void (handlers[ev] = h) } as any);
		const r = handlers.context({ type: "context", messages: turns() });
		check("handler prunes handoffs by default", !!r && hp(r.messages.filter((m: any) => m.role === "assistant")[0]).startsWith("[handoff"));
		process.env.FOREMAN_CONTEXT_PRUNE_HANDOFFS = "false";
		const nm = turns().concat([]);
		const r2 = handlers.context({ type: "context", messages: nm });
		check("FOREMAN_CONTEXT_PRUNE_HANDOFFS=false disables", !r2 || r2.messages.filter((m: any) => m.role === "assistant").every((m: any) => !hp(m).startsWith("[handoff")));
		delete process.env.FOREMAN_CONTEXT_PRUNE_HANDOFFS;
		process.env.FOREMAN_CONTEXT_PRUNE = "false";
		check("FOREMAN_CONTEXT_PRUNE=false still disables everything", handlers.context({ type: "context", messages: turns() }) === undefined);
		delete process.env.FOREMAN_CONTEXT_PRUNE;
	}
	{
		// notification pruning unchanged when handoffs are also present
		const out = pruneMessages(build(), { keepPerRole: 1 });
		check("notification pruning still behaves as before", out.length === build().length - 6 + 1 && !!stubOf(out));
	}
}

// ---- A3: buildRunState ----
{
	const te = (data: any) => ({ type: "custom", customType: "foreman-task", id: "x", data });
	const um = (t: string) => ({ type: "message", id: "u", message: { role: "user", content: t } });
	const nm = (ns: any[]) => ({ type: "custom_message", customType: "foreman-task-notification", content: "", display: true, details: { notifications: ns } });
	const files: Record<string, string> = {};
	const mk = (entries: any[], extra: Partial<Parameters<typeof buildRunState>[0]> = {}) =>
		buildRunState({
			branchEntries: entries,
			cwd: "/proj",
			readFile: (p) => files[p],
			gitBranch: () => "feat/x",
			now: Date.UTC(2026, 0, 1),
			...extra,
		});
	const base = [
		te({ runId: "r1", taskId: "t1-b", role: "plan-step-builder", planStep: 1, planSlug: "demo", state: "running", output: ".foreman/runs/r1/t1-b.md" }),
		te({ runId: "r1", taskId: "t1-b", role: "plan-step-builder", planStep: 1, planSlug: "demo", state: "completed", output: ".foreman/runs/r1/t1-b.md" }),
		te({ runId: "r1", taskId: "t2-b", role: "plan-step-builder", planStep: 2, planSlug: "demo", state: "blocked", output: ".foreman/runs/r1/t2-b.md" }),
		te({ runId: "r1", taskId: "t3-b", role: "qa", planStep: 3, planSlug: "demo", state: "running", output: ".foreman/runs/r1/t3-b.md" }),
	];
	files["/proj/.foreman/runs/r1/t3-b.json"] = JSON.stringify({ workdir: "/wt" });
	files["/wt/docs/plans/demo.md"] = "# P\n\n## Status\n\n- Step 1: merged\n- Step 2: blocked\n- Step 3: not started\n\n## Out\n";
	const s1 = mk([...base, nm([{ taskId: "t2-b", status: "blocked", summary: "needs the db", blockedOn: "db creds", rulings: ["use sqlite", "use sqlite", "r2"] }])]);
	check("summary names plan, workdir, branch and step table", s1.includes("demo") && s1.includes("workdir: /wt") && s1.includes("branch: feat/x") && s1.includes("Step 1: merged") && s1.includes("Step 3: not started"));
	check("plan Status wins over entries; entries used when no Status", s1.includes("plan ## Status") && !s1.includes("newest task entry") && (() => { delete files["/wt/docs/plans/demo.md"]; const s = mk(base); files["/wt/docs/plans/demo.md"] = "x"; return s.includes("newest task entry per step") && s.includes("Step 2: blocked"); })());
	check("blocked task listed with output path", s1.includes("t2-b [blocked]") && s1.includes(".foreman/runs/r1/t2-b.md") && s1.includes("needs the db"));
	check("in-flight task listed, finished one not", s1.includes("- t3-b [running]") && !s1.includes("- t1-b ["));
	check("rulings deduplicated and capped", (s1.match(/- use sqlite/g) ?? []).length === 1 && s1.includes("- r2") && s1.includes("blocked on db creds") && (() => { const many = [nm(Array.from({ length: 30 }, (_, i) => ({ taskId: "t", status: "completed", summary: "", rulings: [`ruling-${i}`] })))]; const s = mk([...base, ...many]); return !s.includes("ruling-9\n") && s.includes("ruling-29") && (s.match(/- ruling-/g) ?? []).length === 20; })());
	{
		const users = Array.from({ length: 12 }, (_, i) => um(`user message ${i}`));
		const s = mk([...users, ...base]);
		check("user messages survive a second compaction (taken from branchEntries)", s.includes("user message 11") && s.includes("user message 4") && !s.includes("user message 3\n") && !s.includes("user message 3 "));
	}
	{
		const big: any[] = [];
		for (let i = 0; i < 500; i++) big.push(i % 2 ? te({ runId: "r1", taskId: `t${i}`, role: "qa", planStep: i, planSlug: "demo", state: i % 4 === 1 ? "blocked" : "running", output: `.foreman/runs/r1/t${i}.md` }) : um("u".repeat(2000)));
		files["/wt/docs/plans/demo.md"] = "## Status\n" + Array.from({ length: 300 }, (_, i) => `- Step ${i}: merged`).join("\n");
		files["/wt/FOREMAN_MEMORY.md"] = "## Decisions log\n" + "d".repeat(9000);
		const s = mk(big);
		check("output length <= 12000 chars on a 500-entry fixture", s.length <= 12000 && s.includes("Do not re-dispatch merged steps"));
		delete files["/wt/FOREMAN_MEMORY.md"];
	}
	{
		files["/wt/docs/plans/demo.md"] = "## Status\n- Step 1: merged\n";
		files["/wt/FOREMAN_MEMORY.md"] = "# M\n## Decisions log\n- chose A\n## Other\nzzz";
		const full = mk(base);
		delete files["/wt/docs/plans/demo.md"];
		const noPlan = mk(base);
		files["/wt/docs/plans/demo.md"] = "## Status\n- Step 1: merged\n";
		delete files["/wt/FOREMAN_MEMORY.md"];
		const noMem = mk(base);
		check("missing plan or memory file drops only that section", full.includes("- chose A") && !full.includes("zzz") && !noPlan.includes("Steps (plan ## Status)") && noPlan.includes("- chose A") && noPlan.includes("## Run") && !noMem.includes("Decisions log") && noMem.includes("Step 1: merged"));
		const thrower = buildRunState({ branchEntries: base, cwd: "/proj", readFile: () => { throw new Error("x"); }, gitBranch: () => { throw new Error("y"); }, now: 0 });
		check("throwing readers never throw", thrower.includes("## Run") && thrower.includes("workdir: /proj"));
		check("same input yields identical output", mk(base) === mk(base));
	}
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
