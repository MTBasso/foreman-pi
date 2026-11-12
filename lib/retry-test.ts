import { isTransientFailure, runWithRetry } from "./retry.ts";
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

console.log(failures === 0 ? "All retry checks passed." : `${failures} retry check(s) FAILED.`);
if (failures) process.exit(1);
