/**
 * C6: re-run the npm scripts a plan step declares under `Checks`, through
 * scripts/run-suites.mjs, so a worker's "all green" claim has an independent check.
 *
 * Safety: only `npm run <script>` names that exist in `<cwd>/package.json` `scripts`
 * are run, one `npm:<script>` suite each, via execFile (no shell). Free-text Checks
 * are never executed. Every failure to verify degrades to `n/a`; nothing here throws.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./agents.ts";
import { parseStepChecks } from "./plan-steps.ts";

export interface VerifyResult {
	verified: "yes" | "no" | "n/a";
	/** `no`: first FAIL line plus log path; `n/a`: the reason. */
	note?: string;
}

export interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
}

export interface ExecHandle {
	promise: Promise<ExecResult>;
	kill(): void;
}

export type ExecFn = (file: string, args: string[], opts: { cwd: string; timeoutMs: number }) => ExecHandle;

export interface VerifyHandle {
	/** Set when the outcome is known without running anything. */
	immediate?: VerifyResult;
	done: Promise<VerifyResult>;
	kill(): void;
}

export interface VerifyOptions {
	cwd: string;
	planText: string | undefined;
	step: number;
	/** Path of run-suites.mjs; default `<PACKAGE_ROOT>/scripts/run-suites.mjs`. */
	runSuites?: string;
	timeoutMs: number;
	exec?: ExecFn;
}

const SAFE_SCRIPT = /^[A-Za-z0-9_][\w:.-]*$/;
/** run-suites sanitises the suite name into the log file name. */
const logName = (suite: string) => suite.replace(/[^A-Za-z0-9._-]+/g, "_") + ".log";
/** Grace after the run-suites own per-suite timeout before the outer kill. */
const OUTER_GRACE_MS = 5000;

const defaultExec: ExecFn = (file, args, opts) => {
	let child: ReturnType<typeof execFile> | undefined;
	const promise = new Promise<ExecResult>((resolve) => {
		try {
			child = execFile(
				file,
				args,
				{ cwd: opts.cwd, timeout: opts.timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
				(err, stdout, stderr) => {
					const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
					resolve({
						code: !e ? 0 : typeof e.code === "number" ? e.code : null,
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? ""),
						timedOut: !!e?.killed,
						...(e && typeof e.code !== "number" ? { error: e.message } : {}),
					});
				},
			);
		} catch (e) {
			resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: (e as Error).message });
		}
	});
	return {
		promise,
		kill() {
			try {
				child?.kill("SIGKILL");
			} catch {
				// ignore
			}
		},
	};
};

const na = (note: string): VerifyHandle => {
	const r: VerifyResult = { verified: "n/a", note };
	return { immediate: r, done: Promise.resolve(r), kill() {} };
};

function packageScripts(cwd: string): Set<string> | undefined {
	try {
		const j = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
		return new Set(Object.keys(j?.scripts ?? {}));
	} catch {
		return undefined;
	}
}

export function verifyChecks(o: VerifyOptions): VerifyHandle {
	try {
		if (o.planText === undefined) return na("plan file not readable");
		const checks = parseStepChecks(o.planText, o.step);
		if (!checks || checks.npmScripts.length === 0) return na("no parsable npm scripts in Checks");
		const scripts = packageScripts(o.cwd);
		if (!scripts) return na("no package.json scripts in the workdir");
		const run = [...new Set(checks.npmScripts)].filter((s) => SAFE_SCRIPT.test(s) && scripts.has(s));
		if (run.length === 0) return na("declared npm scripts missing from package.json");
		const runSuites = o.runSuites ?? join(PACKAGE_ROOT, "scripts", "run-suites.mjs");
		if (!existsSync(runSuites)) return na("run-suites.mjs missing");

		const timeoutS = Math.max(1, Math.ceil(o.timeoutMs / 1000));
		const suites = run.map((s) => `npm:${s}`);
		const h = (o.exec ?? defaultExec)(
			process.execPath,
			[runSuites, "--cwd", o.cwd, "--timeout-s", String(timeoutS), ...suites],
			{ cwd: o.cwd, timeoutMs: timeoutS * 1000 + OUTER_GRACE_MS },
		);
		const done = h.promise.then(
			(r): VerifyResult => interpret(r, suites),
			(e): VerifyResult => ({ verified: "n/a", note: `spawn error: ${String((e as Error)?.message ?? e).slice(0, 100)}` }),
		);
		return { done, kill: () => h.kill() };
	} catch (e) {
		return na(`verification error: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
	}
}

function interpret(r: ExecResult, suites: string[]): VerifyResult {
	if (r.error) return { verified: "n/a", note: `spawn error: ${r.error.slice(0, 100)}` };
	if (r.timedOut || /^\s+timed out after /m.test(r.stdout)) return { verified: "n/a", note: "timeout" };
	if (r.code === 0) return { verified: "yes" };
	if (r.code === 1) {
		const line = r.stdout.split("\n").find((l) => l.startsWith("FAIL "));
		if (!line) return { verified: "n/a", note: "run-suites exited 1 without a FAIL line" };
		const name = /^FAIL (\S+)/.exec(line)?.[1] ?? suites[0];
		const clipped = line.length > 120 ? `${line.slice(0, 120)}…` : line;
		return { verified: "no", note: `${clipped} (.foreman/qa-logs/${logName(name)})` };
	}
	return { verified: "n/a", note: `run-suites exited ${r.code}` };
}
