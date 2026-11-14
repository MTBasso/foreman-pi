import { isMidTaskTransient, isTransientFailure, resumePreamble, runWithRetry, type ResumeInfo } from "./retry.ts";
import type { PiRunResult } from "./spawn.ts";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };
const res = (o: Partial<PiRunResult>): PiRunResult => ({ code: 1, signal: null, messages: [], stderr: "", ...o });
const h = (r: PiRunResult) => ({ done: Promise.resolve(r), kill() {} });

check("429 is transient", isTransientFailure(res({ errorMessage: '429 {"type":"rate_limit_error"}', stopReason: "error" })));
check("generic failure is not", !isTransientFailure(res({ errorMessage: "boom" })));
check("spawnError is not", !isTransientFailure(res({ spawnError: "429" })));
check("429 after output is not", !isTransientFailure(res({ errorMessage: "429", messages: [{ role: "assistant", content: [{ type: "text", text: "did work" }] }] })));

let calls = 0;
const sleeps: number[] = [];
const ok = await runWithRetry(() => (++calls < 3 ? h(res({ errorMessage: "429 rate_limit" })) : h(res({ code: 0 }))), { baseMs: 10, sleep: async (ms) => { sleeps.push(ms); } }).done;
check("retries until success", calls === 3 && ok.code === 0);
check("backoff doubles", sleeps.join() === "10,20");

calls = 0;
const gave = await runWithRetry(() => (calls++, h(res({ errorMessage: "429" }))), { maxRetries: 2, sleep: async () => {} }).done;
check("gives up after maxRetries", calls === 3 && gave.code === 1);

calls = 0;
await runWithRetry(() => (calls++, h(res({ errorMessage: "syntax" }))), { sleep: async () => {} }).done;
check("no retry on non-transient", calls === 1);

let k: ReturnType<typeof runWithRetry>;
calls = 0;
k = runWithRetry(() => (calls++, h(res({ errorMessage: "429" }))), { sleep: async () => { k.kill(); } });
await k.done;
check("kill during backoff stops retries", calls === 1);

const worked = [{ role: "assistant", content: [{ type: "text", text: "did work" }] }];

check("credential validation 503 is transient", isTransientFailure(res({ errorMessage: "503 Credential Validation failed", stopReason: "error" })));
check("credential validation phrase alone is transient", isTransientFailure(res({ errorMessage: "credential validation error" })));
check("mid-task 429 after output is mid-task transient, not no-output transient", isMidTaskTransient(res({ errorMessage: "429", messages: worked })) && !isTransientFailure(res({ errorMessage: "429", messages: worked })));
check("no-output 429 is not mid-task", !isMidTaskTransient(res({ errorMessage: "429" })));
check("non-transient failure after output is not mid-task", !isMidTaskTransient(res({ errorMessage: "syntax", messages: worked })));
check("spawnError is never mid-task", !isMidTaskTransient(res({ spawnError: "429", messages: worked })));

{
	const seen: Array<ResumeInfo | undefined> = [];
	let n = 0;
	const r = await runWithRetry((_a, resume) => (seen.push(resume), n++, h(res({ errorMessage: "429", messages: worked }))), { sleep: async () => {} }).done;
	check("mid-task failure resumes with resume.n = 1 then 2 then gives up", n === 3 && seen[0] === undefined && seen[1]?.n === 1 && seen[2]?.n === 2 && r.code === 1);
	check("resume carries the previous result", seen[1]?.previous.errorMessage === "429");
}
{
	let n = 0;
	await runWithRetry(() => (n++, h(res({ errorMessage: "429", messages: worked }))), { maxResumes: 0, sleep: async () => {} }).done;
	check("maxResumes 0 disables resume", n === 1);
}
{
	// 3 no-output retries, then output + 2 resumes: separate caps => 1 + 3 + 2 attempts
	const seq: PiRunResult[] = [
		res({ errorMessage: "429" }), res({ errorMessage: "429" }), res({ errorMessage: "429" }),
		res({ errorMessage: "429", messages: worked }), res({ errorMessage: "429", messages: worked }), res({ errorMessage: "429", messages: worked }),
	];
	let i = 0;
	const seen: Array<ResumeInfo | undefined> = [];
	await runWithRetry((_a, resume) => (seen.push(resume), h(seq[i++] ?? res({ code: 0 }))), { sleep: async () => {} }).done;
	check("no-output retries and resumes use separate caps", i === 6 && seen.slice(0, 4).every((x) => x === undefined) && seen[4]?.n === 1 && seen[5]?.n === 2);
}
{
	let n = 0;
	await runWithRetry(() => (n++, h(res({ errorMessage: "syntax", messages: worked }))), { sleep: async () => {} }).done;
	check("non-transient failure after output is never resumed", n === 1);
}
{
	let n = 0;
	const k2: ReturnType<typeof runWithRetry> = runWithRetry(() => (n++, h(res({ errorMessage: "429", messages: worked }))), { sleep: async () => { k2.kill(); } });
	await k2.done;
	check("kill during a resume backoff stops everything", n === 1);
}
{
	const p = resumePreamble(1);
	check("resumePreamble mentions git status, git log and commit only your paths", /git status/.test(p) && /git log/.test(p) && /commit only your own paths/.test(p) && /foreman-report/.test(p));
}

console.log(failures === 0 ? "All retry checks passed." : `${failures} retry check(s) FAILED.`);
if (failures) process.exit(1);
