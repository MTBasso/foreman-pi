/**
 * Optional herdr integration. Active only when pi runs inside a herdr pane
 * (HERDR_ENV=1, HERDR_PANE_ID set) and the `herdr` binary is reachable; in
 * every other case each function is a silent no-op. All calls are fire-and-forget
 * and never throw: herdr being absent or slow must not affect a run.
 */
import { execFile } from "node:child_process";

export const HERDR_SOURCE = "foreman-pi";

export interface HerdrEnv {
	HERDR_ENV?: string;
	HERDR_PANE_ID?: string;
	HERDR_BIN_PATH?: string;
}

export function herdrActive(env: HerdrEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
}

export type Runner = (bin: string, args: string[]) => void;

const defaultRunner: Runner = (bin, args) => {
	try {
		const child = execFile(bin, args, { timeout: 5000 }, () => {});
		child.on("error", () => {});
		child.unref();
	} catch {
		// ignore
	}
};

export interface WorkerCounts {
	running: number;
	queued: number;
}

/** Pane title line for the sidebar; undefined clears it. */
export function paneTitle(c: WorkerCounts): string | undefined {
	if (c.running === 0 && c.queued === 0) return undefined;
	return c.queued ? `foreman: ${c.running} running, ${c.queued} queued` : `foreman: ${c.running} running`;
}

export function createHerdr(env: HerdrEnv = process.env, run: Runner = defaultRunner) {
	const active = herdrActive(env);
	const bin = env.HERDR_BIN_PATH || "herdr";
	let lastTitle: string | undefined | null = null;
	return {
		active,
		/** Mirror live worker counts into the pane's herdr metadata (deduplicated). */
		reportWorkers(c: WorkerCounts) {
			if (!active) return;
			const title = paneTitle(c);
			if (title === lastTitle) return;
			lastTitle = title;
			const args = ["pane", "report-metadata", "--source", HERDR_SOURCE, env.HERDR_PANE_ID!];
			args.push(...(title ? ["--title", title] : ["--clear-title"]));
			run(bin, args);
		},
		/** Desktop-level notification when something needs the user or finished. */
		notify(title: string, body?: string) {
			if (!active) return;
			run(bin, ["notification", "show", title, ...(body ? ["--body", body.slice(0, 200)] : [])]);
		},
	};
}
