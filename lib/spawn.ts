/**
 * Shared child-`pi` spawning.
 *
 * Used by extensions/coordination/spawn-worker.ts to run a worker as a
 * `pi --mode json` child process: build the invocation, hand oversized prompts
 * over by file pointer instead of argv, and collect the child's `message_end`
 * JSON events into a result.
 *
 * `runPiJson` takes an injectable invocation so tests can spawn `node -e ...`
 * instead of a real `pi`.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Prompts above this many bytes are passed by file pointer, not argv. */
export const MAX_INLINE_PROMPT_BYTES = 100 * 1024;

/** Delay between SIGTERM and the SIGKILL escalation in `kill()`. */
export const KILL_GRACE_MS = 5000;

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface PiRunResult {
	code: number | null;
	signal: string | null;
	/** Child's message_end messages (assistant/user/toolResult), loosely typed. */
	messages: any[];
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	spawnError?: string;
}

export interface PiRunHandle {
	done: Promise<PiRunResult>;
	/** SIGTERM now, SIGKILL after the grace period if the child is still alive. */
	kill(): void;
}

export interface RunPiJsonOptions {
	cwd: string;
	/** Merged over `process.env` for the child. */
	env?: Record<string, string>;
	/** Use this command+args verbatim instead of `getPiInvocation(args)`. */
	invocation?: PiInvocation;
	/** Override the SIGTERM -> SIGKILL delay (tests). */
	killGraceMs?: number;
}

export function getPiInvocation(args: string[]): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript !== undefined &&
		(currentScript.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(currentScript));
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

/**
 * Returns the prompt to pass inline. If it exceeds `MAX_INLINE_PROMPT_BYTES`,
 * writes the full text to `<runDir>/<taskId>.prompt.md` and returns a pointer
 * to that file instead.
 */
export function inlineOrPointerPrompt(prompt: string, runDir: string, taskId: string): string {
	if (Buffer.byteLength(prompt, "utf-8") <= MAX_INLINE_PROMPT_BYTES) return prompt;
	fs.mkdirSync(runDir, { recursive: true });
	const file = path.join(runDir, `${taskId}.prompt.md`);
	fs.writeFileSync(file, prompt, "utf-8");
	return `Your full handoff prompt is too large to inline. Read it in full from ${file} first, then carry it out.`;
}

/**
 * Spawn a child pi in JSON mode and collect its `message_end` events.
 * Never rejects: failures are reported through the result (`spawnError`,
 * nonzero `code`, `signal`).
 */
export function runPiJson(args: string[], opts: RunPiJsonOptions): PiRunHandle {
	const invocation = opts.invocation ?? getPiInvocation(args);
	const graceMs = opts.killGraceMs ?? KILL_GRACE_MS;
	const result: PiRunResult = { code: null, signal: null, messages: [], stderr: "" };
	let proc: ReturnType<typeof spawn> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let exited = false;

	const done = new Promise<PiRunResult>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			resolve(result);
		};
		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event?.type !== "message_end") return;
			const m = event.message;
			if (m?.role !== "user" && m?.role !== "assistant" && m?.role !== "toolResult") return;
			result.messages.push(m);
			if (m.role === "assistant") {
				result.stopReason = m.stopReason;
				result.errorMessage = m.errorMessage;
			}
		};

		try {
			proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...opts.env },
			});
		} catch (e) {
			result.spawnError = e instanceof Error ? e.message : String(e);
			finish();
			return;
		}
		proc.stdout?.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const l of lines) processLine(l);
		});
		proc.stderr?.on("data", (d) => {
			result.stderr += d.toString();
		});
		proc.on("exit", () => {
			exited = true;
		});
		proc.on("close", (code, sig) => {
			if (buffer.trim()) processLine(buffer);
			result.code = code;
			result.signal = sig;
			finish();
		});
		proc.on("error", (err) => {
			result.spawnError = err.message;
			finish();
		});
	});

	return {
		done,
		kill() {
			const p = proc;
			if (!p || exited || p.exitCode !== null || p.signalCode !== null) return;
			if (!p.kill("SIGTERM")) return;
			killTimer = setTimeout(() => {
				if (!exited) p.kill("SIGKILL");
			}, graceMs);
		},
	};
}
