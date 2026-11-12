/**
 * Retry a worker run that died on a transient provider error (HTTP 429 rate
 * limit, 529 overloaded, 5xx) before producing any assistant output.
 *
 * Only whole-run failures with no messages are retried, so a worker that
 * already did work is never silently re-run. Backoff doubles from `baseMs`.
 * `kill()` cancels both a running attempt and a pending backoff.
 */
import type { PiRunHandle, PiRunResult } from "./spawn.ts";

export const TRANSIENT_RE = /\b(429|529|502|503|504)\b|rate[_ ]?limit|overloaded|temporarily unavailable/i;

export function isTransientFailure(r: PiRunResult): boolean {
	if (r.spawnError) return false;
	const text = `${r.errorMessage ?? ""}\n${r.stderr ?? ""}`;
	const failed = r.code !== 0 || r.stopReason === "error";
	const producedOutput = r.messages.some((m) => m?.role === "assistant" && Array.isArray(m.content) && m.content.some((c: any) => c?.type === "toolCall" || (c?.type === "text" && c.text?.trim())));
	return failed && !producedOutput && TRANSIENT_RE.test(text);
}

export interface RetryOptions {
	maxRetries?: number;
	baseMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export function runWithRetry(start: (attempt: number) => PiRunHandle, opts: RetryOptions = {}): PiRunHandle {
	const maxRetries = opts.maxRetries ?? 3;
	const baseMs = opts.baseMs ?? 30_000;
	const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
	let killed = false;
	let current: PiRunHandle | undefined;

	const done = (async (): Promise<PiRunResult> => {
		for (let attempt = 0; ; attempt++) {
			current = start(attempt);
			const r = await current.done;
			if (killed || attempt >= maxRetries || !isTransientFailure(r)) return r;
			await sleep(baseMs * 2 ** attempt);
			if (killed) return r;
		}
	})();

	return {
		done,
		kill() {
			killed = true;
			current?.kill();
		},
	};
}
