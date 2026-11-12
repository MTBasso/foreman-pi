/**
 * Optional herdr integration. Active only when pi runs inside a herdr pane
 * (HERDR_ENV=1, HERDR_PANE_ID set) and the `herdr` binary is reachable; in
 * every other case each function is a silent no-op. All calls are fire-and-forget
 * and never throw: herdr being absent or slow must not affect a run.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";

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

// --- worker watch panes ------------------------------------------------------

export interface PaneRunner {
	/** Run herdr and resolve with stdout, or undefined on any failure. */
	(bin: string, args: string[]): Promise<string | undefined>;
}

const defaultPaneRunner: PaneRunner = (bin, args) =>
	new Promise((resolve) => {
		try {
			const child = execFile(bin, args, { timeout: 8000 }, (err, stdout) => resolve(err ? undefined : String(stdout)));
			child.on("error", () => resolve(undefined));
		} catch {
			resolve(undefined);
		}
	});

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function panesEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return herdrActive(env) && env.FOREMAN_HERDR_PANES !== "0";
}

export interface WatchPane {
	/** Signal the worker is done (the tail script exits) and close the pane after `closeAfterMs`, or leave it open. */
	finish(opts: { keepOpen: boolean; closeAfterMs?: number }): Promise<void>;
}

/**
 * Open a herdr pane that follows a worker's event log. The worker itself stays a
 * child process of this one (reports are read from its stream); the pane is a
 * live, human-readable window onto it. Layout: the first pane splits the
 * orchestrator's pane downward, later ones split the previous watch pane to the right.
 */
let lastWatchPane: string | undefined;
export async function openWatchPane(
	args: { taskId: string; role: string; cwd: string; logFile: string; tailScript: string },
	env: HerdrEnv = process.env,
	run: PaneRunner = defaultPaneRunner,
): Promise<WatchPane | undefined> {
	if (!herdrActive(env)) return undefined;
	const bin = env.HERDR_BIN_PATH || "herdr";
	const target = lastWatchPane ?? env.HERDR_PANE_ID!;
	const split = await run(bin, ["pane", "split", "--no-focus", "--direction", lastWatchPane ? "right" : "down", "--ratio", lastWatchPane ? "0.5" : "0.3", "--cwd", args.cwd, target]);
	let paneId: string | undefined;
	try {
		paneId = JSON.parse(split ?? "null")?.result?.pane?.pane_id;
	} catch {
		// unparseable: give up quietly
	}
	if (!paneId) return undefined;
	lastWatchPane = paneId;
	await run(bin, ["pane", "rename", paneId, `${args.taskId}`]);
	await run(bin, ["pane", "run", paneId, `node ${shellQuote(args.tailScript)} ${shellQuote(args.logFile)} ${shellQuote(`${args.taskId} (${args.role})`)}`]);
	const id = paneId;
	return {
		async finish({ keepOpen, closeAfterMs = 20_000 }) {
			try {
				fs.writeFileSync(`${args.logFile}.done`, "");
			} catch {
				// ignore
			}
			if (keepOpen) return;
			await new Promise((r) => { const t = setTimeout(r, closeAfterMs); t.unref?.(); });
			if (lastWatchPane === id) lastWatchPane = undefined;
			await run(bin, ["pane", "close", id]);
		},
	};
}
