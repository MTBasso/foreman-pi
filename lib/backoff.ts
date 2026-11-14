/**
 * Shared back-off gate: when one worker hits a provider rate limit, every
 * worker pauses together (instead of re-hitting it on a fixed schedule), and
 * the effective concurrency is halved until clean finishes restore it.
 *
 * Only the rate-limit class (429, 529, rate limit, overloaded) pauses the
 * pool; other transient errors keep their per-worker back-off.
 */

export const RATE_LIMIT_RE = /\b(429|529)\b|rate[_ ]?limit|overloaded/i;
/** A pause never exceeds this, so a bad retry-after cannot stall a run. */
export const MAX_PAUSE_MS = 5 * 60 * 1000;
const JITTER = 0.25;

export function isRateLimit(text: string): boolean {
	return RATE_LIMIT_RE.test(text);
}

/** Seconds from a `retry-after` hint in error text, as ms; undefined when absent. */
export function parseRetryAfterMs(text: string): number | undefined {
	const m = /retry[-_ ]?after["'\s:=]*(\d+(?:\.\d+)?)/i.exec(text);
	if (!m) return undefined;
	const s = Number(m[1]);
	return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}

export interface BackoffGateOptions {
	now?: () => number;
	rng?: () => number;
	maxPauseMs?: number;
}

export function createBackoffGate(opts: BackoffGateOptions = {}) {
	const now = opts.now ?? Date.now;
	const rng = opts.rng ?? Math.random;
	const maxPause = opts.maxPauseMs ?? MAX_PAUSE_MS;
	let pausedUntil = 0;
	/** Rate-limit-imposed cap on concurrency; undefined = not degraded. Independent of any one caller's max. */
	let degraded: number | undefined;
	let ceiling = Infinity;

	return {
		/** Pause the pool and halve concurrency. Returns the pause applied (ms, jittered, capped). */
		noteRateLimit(text: string, backoffMs: number): number {
			const base = parseRetryAfterMs(text) ?? backoffMs;
			const jittered = base * (1 + (rng() * 2 - 1) * JITTER);
			const ms = Math.min(maxPause, Math.max(0, Math.round(jittered)));
			pausedUntil = Math.max(pausedUntil, now() + ms);
			degraded = Math.max(1, Math.floor(Math.min(degraded ?? ceiling, ceiling) / 2));
			return ms;
		},
		remainingMs(): number {
			return Math.min(maxPause, Math.max(0, pausedUntil - now()));
		},
		/** Effective concurrency for a configured maximum: never below 1, never above `max`. */
		limit(max: number): number {
			ceiling = Math.max(1, max);
			return degraded === undefined ? ceiling : Math.max(1, Math.min(ceiling, degraded));
		},
		/** A worker finished cleanly: restore one slot, never above the configured maximum. */
		noteCleanFinish(): void {
			if (degraded === undefined) return;
			degraded += 1;
			if (degraded >= ceiling) degraded = undefined;
		},
	};
}

export type BackoffGate = ReturnType<typeof createBackoffGate>;

/** Process-wide gate: `spawnWorker` is injected as a plain function, so the pool state lives here. */
export const sharedGate: BackoffGate = createBackoffGate();
