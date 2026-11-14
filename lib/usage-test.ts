import { readFileSync } from "node:fs";
import { createUsageTally, median, tokensOf } from "./usage.ts";
import { DENIAL_PREFIX } from "./activity.ts";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };

const asst = (u: Record<string, unknown>, content: unknown[] = [{ type: "text", text: "x" }]) => ({ type: "message_end", message: { role: "assistant", content, usage: u } });
const use = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) => ({ input, output, cacheRead, cacheWrite, cost: { total } });
const denied = (text: string) => ({ type: "message_end", message: { role: "toolResult", isError: true, content: [{ type: "text", text }] } });

{
	const t = createUsageTally();
	t.feed(asst(use(1, 2, 3, 4, 0.5)));
	t.feed(asst(use(10, 20, 30, 40, 0.25), [{ type: "toolCall", name: "bash" }, { type: "toolCall", name: "read" }]));
	const s = t.snapshot();
	check("tally sums usage across two assistant messages", s.input === 11 && s.output === 22 && s.cacheRead === 33 && s.cacheWrite === 44 && s.cost === 0.75 && s.turns === 2 && s.toolCalls === 2 && s.firstRequestTokens === 8);
}
{
	const t = createUsageTally();
	for (const e of [null, undefined, 5, "x", {}, { type: "message_update" }, { type: "message_end" }, { type: "message_end", message: 3 }, { type: "message_end", message: { role: "user" } }, { type: "turn_end" }]) t.feed(e);
	t.feed(asst({ input: "bad" }));
	const s = t.snapshot();
	check("tally ignores non-message_end and malformed events", s.turns === 1 && s.input === 0 && s.output === 0 && s.toolCalls === 0 && s.guardDenials.total === 0);
}
{
	const t = createUsageTally();
	t.feed(denied(`${DENIAL_PREFIX}: rm outside the sandbox. Stop that command`));
	t.feed(denied(`${DENIAL_PREFIX}: rm outside the sandbox. Other tail`));
	t.feed(denied(`${DENIAL_PREFIX}: no eval.`));
	t.feed(denied("some other error"));
	t.feed({ type: "message_end", message: { role: "toolResult", isError: false, content: [{ type: "text", text: `${DENIAL_PREFIX}: x` }] } });
	const g = t.snapshot().guardDenials;
	check("tally counts guard denials by reason", g.total === 3 && g.byReason["rm outside the sandbox"] === 2 && g.byReason["no eval"] === 1 && Object.keys(g.byReason).length === 2);
}
{
	const t = createUsageTally();
	t.noteAttempt();
	t.feed(asst(use(1, 1, 1, 1, 0.1)));
	t.noteAttempt();
	t.feed(asst(use(2, 2, 2, 2, 0.1)));
	const s = t.snapshot();
	check("tally accumulates across attempts", s.attempts === 2 && s.turns === 2 && s.input === 3 && s.firstRequestTokens === 3);
}
{
	const t = createUsageTally();
	for (const l of readFileSync(new URL("./testdata/worker-stream.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean)) t.feed(JSON.parse(l));
	const s = t.snapshot();
	check("usage tally on lib/testdata/worker-stream.jsonl matches hand-counted totals",
		s.input === 6 && s.output === 184 && s.cacheRead === 10249 && s.cacheWrite === 7656 && s.turns === 2 && s.toolCalls === 1 && s.firstRequestTokens === 8822 && Math.abs(s.cost - 0.0220169) < 1e-9);
}
check("tokensOf is ceil(chars/4)", tokensOf("") === 0 && tokensOf("abcde") === 2);
check("median", median([]) === 0 && median([3, 1, 2]) === 2 && median([1, 2, 3, 4]) === 2.5);

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
