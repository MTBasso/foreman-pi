import { createBackoffGate, isRateLimit, MAX_PAUSE_MS } from "./backoff.ts";

let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "ok  " : "FAIL"} - ${n}`); if (!ok) failures++; };

{
	let t = 1000;
	const lo = createBackoffGate({ now: () => t, rng: () => 0 });
	const hi = createBackoffGate({ now: () => t, rng: () => 1 });
	const mid = createBackoffGate({ now: () => t, rng: () => 0.5 });
	check("jitter stays within ±25% (seeded rng)", lo.noteRateLimit("429", 1000) === 750 && hi.noteRateLimit("429", 1000) === 1250 && mid.noteRateLimit("429", 1000) === 1000);
	t += 400;
	check("remainingMs counts down", mid.remainingMs() === 600);
}
{
	const g = createBackoffGate({ now: () => 0, rng: () => 0.5 });
	check("retry-after seconds is honoured", g.noteRateLimit('429 {"retry-after": 7}', 99999) === 7000 && g.remainingMs() === 7000);
	check("rate-limit class", isRateLimit("529 overloaded") && isRateLimit("rate_limit_error") && !isRateLimit("503 unavailable"));
}
{
	const g = createBackoffGate({ now: () => 0, rng: () => 0.5 });
	check("limit starts at max", g.limit(8) === 8);
	g.noteRateLimit("429", 10);
	check("limit halves on rate-limit", g.limit(8) === 4);
	g.noteRateLimit("429", 10);
	check("halves again", g.limit(8) === 2);
	g.noteCleanFinish();
	check("restores one slot per clean finish", g.limit(8) === 3);
	g.noteCleanFinish(); g.noteCleanFinish(); g.noteCleanFinish(); g.noteCleanFinish(); g.noteCleanFinish();
	check("limit never above max", g.limit(8) === 8);
	for (let i = 0; i < 6; i++) g.noteRateLimit("429", 10);
	check("limit never below 1", g.limit(8) === 1 && g.limit(1) === 1);
}
{
	const g = createBackoffGate({ now: () => 0, rng: () => 0.5 });
	g.noteRateLimit("retry-after: 99999", 10);
	check("pause is capped", g.remainingMs() === MAX_PAUSE_MS);
}
{
	const g = createBackoffGate({ now: () => 0, rng: () => 0.5 });
	g.noteRateLimit("429", 1000);
	g.noteRateLimit("429", 400);
	check("two workers hitting 429 share one pause", g.remainingMs() === 1000);
}

if (failures > 0) { console.error(`${failures} failed`); process.exit(1); }
console.log("all checks passed");
