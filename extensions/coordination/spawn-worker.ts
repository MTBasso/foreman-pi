/**
 * Default worker spawner for foreman_delegate.
 *
 * Resolves the role to an agent definition (lib/agents.ts), builds the child
 * `pi` argv, and runs it through lib/spawn.ts. Returns a handle immediately
 * (non-blocking) with kill(); oversized prompts go to <run>/<task>.prompt.md
 * with a pointer. Workers run with FOREMAN_PI_SUBAGENT=1, which exempts them
 * from orchestrator-guardrail and makes coordination a no-op in the child, and
 * FOREMAN_PI_ROLE=<role>, which scopes the worker-guard write policy. The child
 * runs with --no-session; reports and prompt files are written by the parent
 * (or are plain model output), never by the child through a guarded tool.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeWorkerPrompt, discoverAgents } from "../../lib/agents.ts";
import { resolveModel } from "../../lib/model-policy.ts";
import { MAX_INLINE_PROMPT_BYTES, inlineOrPointerPrompt, runPiJson, workerEnv } from "../../lib/spawn.ts";
import { runWithRetry } from "../../lib/retry.ts";
import { blockReport, createWorktree, finishWorktree, isolateMode, retargetPrompt, shouldIsolate, type Isolated } from "../../lib/worktree.ts";
import { ISOLATABLE_ROLES } from "../../lib/worktree.ts";

/** Writer workers currently running in the shared tree or an isolated one. */
let activeWriters = 0;
import { finalReport, type SpawnRequest, type WorkerHandle } from "./coordinator.ts";
import type { PiRunResult } from "../../lib/spawn.ts";

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

	const isWriter = ISOLATABLE_ROLES.has(agent.name);
	const iso: Isolated | undefined = shouldIsolate(agent.name, activeWriters, isolateMode()) ? createWorktree(req.cwd, req.taskId) : undefined;
	if (isWriter) activeWriters++;
	const releaseWriter = () => {
		if (isWriter) activeWriters = Math.max(0, activeWriters - 1);
	};
	const cwd = iso?.path ?? req.cwd;
	const prompt = iso ? retargetPrompt(req.prompt, iso) : req.prompt;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const chosen = resolveModel(agent, process.env, { model: req.model, thinking: req.thinkingLevel });
	if (chosen.model) args.push("--model", chosen.model);
	if (chosen.thinking) args.push("--thinking", chosen.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | undefined;
	try {
		const systemPrompt = composeWorkerPrompt(agent);
		if (systemPrompt.trim()) {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreman-worker-"));
			const promptFile = path.join(tmpDir, `prompt-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
			fs.writeFileSync(promptFile, systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}
		args.push(`Task: ${inlineOrPointerPrompt(prompt, req.runDir, req.taskId)}`);
	} catch (e) {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		releaseWriter();
		return failed(`Failed to prepare worker: ${e instanceof Error ? e.message : String(e)}`);
	}

	const handle = runWithRetry((attempt) => runPiJson(args, { cwd, env: { ...workerEnv(agent.name), ...(iso ? { FOREMAN_WORKTREE: "1" } : {}) } }));
	const cleanupTmp = () => {
		if (!tmpDir) return;
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	};
	const done = handle.done.then(async (r) => {
		cleanupTmp();
		releaseWriter();
		if (!iso) return r;
		try {
			const m = await finishWorktree(iso, req.taskId);
			if (m.merged) return r;
			return withBlockedReport(r, m.conflict, iso);
		} catch (e) {
			return withBlockedReport(r, `merge-back error: ${e instanceof Error ? e.message : String(e)}`, iso);
		}
	});
	return { done, kill: handle.kill, chosen: { model: chosen.model, thinking: chosen.thinking } };
}

function withBlockedReport(r: PiRunResult, conflict: string, iso: Isolated): PiRunResult {
	const report = finalReport(r.messages);
	return { ...r, messages: [...r.messages, { role: "assistant", content: [{ type: "text", text: blockReport(report, conflict, iso) }] }] };
}
