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
			// herdr's CLI wants the positional pane id BEFORE the options.
			const args = ["pane", "report-metadata", env.HERDR_PANE_ID!, "--source", HERDR_SOURCE];
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
	/**
	 * Tell the pane's tail script the worker is done. The script owns the pane's
	 * lifecycle (it is the pane's process): "ok" lingers briefly then exits, which
	 * closes the pane; "attention" waits for the user to dismiss it.
	 */
	finish(opts: { keepOpen: boolean }): Promise<void>;
}

/** Live watch panes, oldest first. The newest is where the next worker stacks. */
const livePanes: string[] = [];

function parsePaneId(out: string | undefined): string | undefined {
	try {
		return JSON.parse(out ?? "null")?.result?.pane?.pane_id;
	} catch {
		return undefined;
	}
}

/**
 * Open a herdr pane that follows a worker's event log. The worker itself stays a
 * child process of this one (reports are read from its stream); the pane is a
 * live window onto it. Layout: one column to the right of the orchestrator (the
 * first worker splits it 60/40), later workers stack downward in that column, so
 * the orchestrator keeps its full height. The pane runs the tail script via `exec`,
 * so when the script exits herdr closes the pane.
 */
export async function openWatchPane(
	args: { taskId: string; role: string; cwd: string; logFile: string; tailScript: string },
	env: HerdrEnv = process.env,
	run: PaneRunner = defaultPaneRunner,
): Promise<WatchPane | undefined> {
	if (!herdrActive(env)) return undefined;
	const bin = env.HERDR_BIN_PATH || "herdr";
	const split = async (target: string, direction: "right" | "down", ratio: string) =>
		parsePaneId(await run(bin, ["pane", "split", target, "--no-focus", "--direction", direction, "--ratio", ratio, "--cwd", args.cwd]));

	let paneId: string | undefined;
	// Stack under the newest live worker pane; if it has closed meanwhile, fall back to a fresh column.
	while (!paneId && livePanes.length) {
		const prev = livePanes[livePanes.length - 1];
		paneId = await split(prev, "down", "0.5");
		if (!paneId) livePanes.pop();
	}
	if (!paneId) paneId = await split(env.HERDR_PANE_ID!, "right", "0.4");
	if (!paneId) return undefined;
	livePanes.push(paneId);
	const id = paneId;

	await run(bin, ["pane", "rename", id, args.taskId]);
	const cmd = `clear; exec node ${shellQuote(args.tailScript)} ${shellQuote(args.logFile)} ${shellQuote(`${args.taskId} · ${args.role}`)}`;
	await run(bin, ["pane", "run", id, cmd]);
	return {
		async finish({ keepOpen }) {
			try {
				fs.writeFileSync(`${args.logFile}.done`, keepOpen ? "attention" : "ok");
			} catch {
				// ignore
			}
			// The pane closes itself when the tail script exits; drop our reference once it is gone.
			const t = setTimeout(() => {
				const i = livePanes.indexOf(id);
				if (i >= 0) livePanes.splice(i, 1);
			}, keepOpen ? 0 : 12_000);
			t.unref?.();
			if (keepOpen) {
				const i = livePanes.indexOf(id);
				if (i >= 0) livePanes.splice(i, 1);
			}
		},
	};
}
