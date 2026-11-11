/**
 * Default worker spawner for foreman_delegate.
 *
 * COPIED (deliberately duplicated) from extensions/subagent-dispatch/index.ts
 * (getPiInvocation, writePromptToTempFile, runSingleAgent's spawn + JSON
 * message_end parsing). That file is vendored and not edited; see PLAN.md.
 *
 * Differences: no UI/usage tracking, returns a handle immediately (non-blocking)
 * with kill(), and oversized prompts go to <run>/<task>.prompt.md with a pointer.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../subagent-dispatch/agents.ts";
import type { SpawnRequest, WorkerHandle, WorkerResult } from "./coordinator.ts";

/** Prompts above this many bytes are passed by file pointer, not argv. */
export const MAX_INLINE_PROMPT_BYTES = 100 * 1024;

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

function failed(message: string): WorkerHandle {
	return {
		kill() {},
		done: Promise.resolve({ code: null, signal: null, messages: [], stderr: "", spawnError: message }),
	};
}

export function spawnWorker(req: SpawnRequest): WorkerHandle {
	const { agents } = discoverAgents(req.cwd, "user");
	const agent = agents.find((a) => a.name === req.role);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return failed(`Unknown agent: "${req.role}". Available agents: ${available}.`);
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const model = agent.model ?? req.model;
	if (model) args.push("--model", model);
	if (!agent.model && req.thinkingLevel) args.push("--thinking", req.thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | undefined;
	try {
		if (agent.systemPrompt.trim()) {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreman-worker-"));
			const promptFile = path.join(tmpDir, `prompt-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
			fs.writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}

		let task = req.prompt;
		if (Buffer.byteLength(task, "utf-8") > MAX_INLINE_PROMPT_BYTES) {
			fs.mkdirSync(req.runDir, { recursive: true });
			const file = path.join(req.runDir, `${req.taskId}.prompt.md`);
			fs.writeFileSync(file, task, "utf-8");
			task = `Your full handoff prompt is too large to inline. Read it in full from ${file} first, then carry it out.`;
		}
		args.push(`Task: ${task}`);
	} catch (e) {
		return failed(`Failed to prepare worker: ${e instanceof Error ? e.message : String(e)}`);
	}

	const cleanupTmp = () => {
		if (!tmpDir) return;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	};

	const invocation = getPiInvocation(args);
	const result: WorkerResult = { code: null, signal: null, messages: [], stderr: "" };
	let proc: ReturnType<typeof spawn> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let exited = false;

	const done = new Promise<WorkerResult>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			cleanupTmp();
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
				cwd: req.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// Exempts the child from orchestrator-guardrail (same cwd => same
				// .orchestrator-active marker) and makes coordination a no-op there.
				env: { ...process.env, FOREMAN_PI_SUBAGENT: "1" },
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
			}, 5000);
		},
	};
}
