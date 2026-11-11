/**
 * Default worker spawner for foreman_delegate.
 *
 * Resolves the role to an agent definition (lib/agents.ts), builds the child
 * `pi` argv, and runs it through lib/spawn.ts. Returns a handle immediately
 * (non-blocking) with kill(); oversized prompts go to <run>/<task>.prompt.md
 * with a pointer. Workers run with FOREMAN_PI_SUBAGENT=1, which exempts them
 * from orchestrator-guardrail and makes coordination a no-op in the child.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../../lib/agents.ts";
import { MAX_INLINE_PROMPT_BYTES, inlineOrPointerPrompt, runPiJson } from "../../lib/spawn.ts";
import type { SpawnRequest, WorkerHandle } from "./coordinator.ts";

export { MAX_INLINE_PROMPT_BYTES };

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
		args.push(`Task: ${inlineOrPointerPrompt(req.prompt, req.runDir, req.taskId)}`);
	} catch (e) {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		return failed(`Failed to prepare worker: ${e instanceof Error ? e.message : String(e)}`);
	}

	const handle = runPiJson(args, { cwd: req.cwd, env: { FOREMAN_PI_SUBAGENT: "1" } });
	const cleanupTmp = () => {
		if (!tmpDir) return;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	};
	const done = handle.done.then((r) => {
		cleanupTmp();
		return r;
	});
	return { done, kill: handle.kill };
}
