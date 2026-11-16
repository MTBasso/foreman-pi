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
	let t = 0;
	const g = createBackoffGate({ now: () => t, rng: () => 0.5, decayMs: 0 });
	check("limit starts at max", g.limit(8) === 8);
	g.noteRateLimit("429", 10);
	check("limit halves on rate-limit", g.limit(8) === 4);
	g.noteRateLimit("429", 10);
	check("second 429 inside the pause does not halve again", g.limit(8) === 4);
	t += 50; // pause (10ms) expired
	g.noteRateLimit("429", 10);
	check("429 after the pause expired halves again", g.limit(8) === 2);
	g.noteCleanFinish();
	check("clean finish still restores one slot", g.limit(8) === 3);
	g.noteCleanFinish(); g.noteCleanFinish(); g.noteCleanFinish(); g.noteCleanFinish(); g.noteCleanFinish();
	check("limit never above max", g.limit(8) === 8);
	for (let i = 0; i < 6; i++) { t += 50; g.noteRateLimit("429", 10); }
	check("limit never below 1", g.limit(8) === 1 && g.limit(1) === 1);
}
{
	let t = 0;
	const g = createBackoffGate({ now: () => t, rng: () => 0.5, decayMs: 1000 });
	g.limit(8);
	g.noteRateLimit("429", 10);
	check("limit restores one slot per decay interval (fake clock)", g.limit(8) === 4 && (t = 999, g.limit(8)) === 4 && (t = 1000, g.limit(8)) === 5 && (t = 2500, g.limit(8)) === 6);
	t = 10000;
	check("decay reaches the ceiling and clears degraded", g.limit(8) === 8 && g.limit(8) === 8);
}
{
	let t = 0;
	const g = createBackoffGate({ now: () => t, rng: () => 0.5, decayMs: 0 });
	g.limit(8);
	g.noteRateLimit("429", 10);
	t = 10_000_000;
	check("decay 0 disables restoration by time", g.limit(8) === 4);
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
	g.noteRateLimit("retry-after: 5", 10);
	check("pause still extends to the longest retry-after", g.remainingMs() === 5000);
}

{
	let t = 0;
	const g = createBackoffGate({ now: () => t, rng: () => 0.5, decayMs: 0 });
	check("setup: limit 4", g.limit(4) === 4);
	g.noteRateLimit("429", 1000);
	check("halved to 2", g.limit(4) === 2);
	g.noteCleanFinish();
	g.noteCleanFinish();
	check("fully restored", g.limit(4) === 4);
	t = 500; // still inside the pause
	g.noteRateLimit("429", 1000);
	check("rate limit inside pause after full restore halves again", g.limit(4) === 2);
}

{
	const fs = await import("node:fs");
	const en = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const pt = fs.readFileSync(new URL("../README.pt-BR.md", import.meta.url), "utf8");
	check("README documents FOREMAN_BACKOFF_DECAY_S in both languages", en.includes("`FOREMAN_BACKOFF_DECAY_S`") && pt.includes("`FOREMAN_BACKOFF_DECAY_S`"));
}

if (failures > 0) { console.error(`${failures} failed`); process.exit(1); }
console.log("all checks passed");
