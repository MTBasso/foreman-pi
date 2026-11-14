/**
 * Retry a worker run that died on a transient provider error (HTTP 429 rate
 * limit, 529 overloaded, 5xx) before producing any assistant output.
 *
 * No-output failures are re-run (cap 3). A failure after output is resumed
 * (cap 2, separate count) with a preamble telling the worker to continue from git state. Backoff doubles from `baseMs`.
 * `kill()` cancels both a running attempt and a pending backoff.
 */
import type { PiRunHandle, PiRunResult } from "./spawn.ts";

export const TRANSIENT_RE = /\b(429|529|502|503|504)\b|rate[_ ]?limit|overloaded|temporarily unavailable|credential validation/i;

function failedTransient(r: PiRunResult): { transient: boolean; producedOutput: boolean } {
	if (r.spawnError) return { transient: false, producedOutput: false };
	const text = `${r.errorMessage ?? ""}\n${r.stderr ?? ""}`;
	const failed = r.code !== 0 || r.stopReason === "error";
	const producedOutput = r.messages.some((m) => m?.role === "assistant" && Array.isArray(m.content) && m.content.some((c: any) => c?.type === "toolCall" || (c?.type === "text" && c.text?.trim())));
	return { transient: failed && TRANSIENT_RE.test(text), producedOutput };
}

/** Transient failure before any assistant output: safe to re-run from scratch. */
export function isTransientFailure(r: PiRunResult): boolean {
	const f = failedTransient(r);
	return f.transient && !f.producedOutput;
}

/** Transient failure after the worker already produced output: resume, not restart. */
export function isMidTaskTransient(r: PiRunResult): boolean {
	const f = failedTransient(r);
	return f.transient && f.producedOutput;
}

export function resumePreamble(n: number): string {
	return `Your previous run was interrupted by a provider error (resume ${n}). Run \`git status\` and \`git log -3\`, continue from what exists, commit only your own paths, then finish and write the foreman-report.`;
}

export interface ResumeInfo {
	previous: PiRunResult;
	n: number;
}

export interface RetryOptions {
	maxRetries?: number;
	maxResumes?: number;
	baseMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export function runWithRetry(start: (attempt: number, resume?: ResumeInfo) => PiRunHandle, opts: RetryOptions = {}): PiRunHandle {
	const maxRetries = opts.maxRetries ?? 3;
	const maxResumes = opts.maxResumes ?? 2;
	const baseMs = opts.baseMs ?? 30_000;
	const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
	let killed = false;
	let current: PiRunHandle | undefined;

	const done = (async (): Promise<PiRunResult> => {
		let retries = 0;
		let resumes = 0;
		let resume: ResumeInfo | undefined;
		for (let attempt = 0; ; attempt++) {
			current = start(attempt, resume);
			const r = await current.done;
			if (killed) return r;
			if (isTransientFailure(r) && retries < maxRetries) {
				await sleep(baseMs * 2 ** retries++);
				resume = undefined;
			} else if (isMidTaskTransient(r) && resumes < maxResumes) {
				await sleep(baseMs * 2 ** resumes++);
				resume = { previous: r, n: resumes };
			} else return r;
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
