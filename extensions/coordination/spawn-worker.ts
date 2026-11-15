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
import { MAX_INLINE_PROMPT_BYTES, inlineOrPointerPrompt, runPiJson, workerBaseArgs, workerEnv } from "../../lib/spawn.ts";
import { openWatchPane, panesEnabled } from "../../lib/herdr.ts";
import { isRateLimit, sharedGate } from "../../lib/backoff.ts";
import { composeTaskArg, workerFooter } from "../../lib/handoff-footer.ts";
import { detectLocale } from "../../lib/i18n.ts";
import { resumePreamble, runWithRetry, type ResumeInfo } from "../../lib/retry.ts";
import { blockReport, createWorktree, finishWorktree, isolateMode, retargetPrompt, shouldIsolate, type Isolated } from "../../lib/worktree.ts";
import { ISOLATABLE_ROLES } from "../../lib/worktree.ts";

/** Writer workers currently running in the shared tree or an isolated one. */
let activeWriters = 0;
import { PACKAGE_ROOT } from "../../lib/agents.ts";
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

	const args: string[] = workerBaseArgs(agent.name, process.env, { cwd });
	const chosen = resolveModel(agent, process.env, { model: req.model, thinking: req.thinkingLevel });
	if (chosen.model) args.push("--model", chosen.model);
	if (chosen.thinking) args.push("--thinking", chosen.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | undefined;
	let promptText = "";
	try {
		const systemPrompt = composeWorkerPrompt(agent);
		if (systemPrompt.trim()) {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreman-worker-"));
			const promptFile = path.join(tmpDir, `prompt-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
			fs.writeFileSync(promptFile, systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		}
		promptText = inlineOrPointerPrompt(prompt, req.runDir, req.taskId);
	} catch (e) {
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		releaseWriter();
		return failed(`Failed to prepare worker: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Always keep the events log (message_end lines): it is the evidence an orphaned worker leaves behind.
	const logFile = path.join(req.runDir, `${req.taskId}.events.jsonl`);
	try {
		fs.mkdirSync(req.runDir, { recursive: true });
	} catch {
		// ignore
	}
	// Inside herdr: give the worker a live watch pane following that log.
	let watch: Promise<Awaited<ReturnType<typeof openWatchPane>>> | undefined;
	if (panesEnabled()) {
		watch = openWatchPane({ taskId: req.taskId, role: agent.name, cwd, logFile, tailScript: path.join(PACKAGE_ROOT, "scripts", "herdr-tail.mjs") });
	}
	// A resume attempt prepends the preamble; the child is --no-session, so git state is the memory.
	const footer = workerFooter({ locale: detectLocale(), cwd });
	const buildArgs = (resume?: ResumeInfo): string[] => [...args, composeTaskArg({ handoff: promptText, resume: resume ? resumePreamble(resume.n) : undefined, footer })];
	const maxResumes = Number.parseInt(process.env.FOREMAN_MAX_RESUMES ?? "", 10);
	const handle = runWithRetry(
		(attempt, resume) => {
			if (attempt > 0) req.onAttempt?.(attempt);
			return runPiJson(buildArgs(resume), { cwd, logFile, onEvent: req.onEvent, env: { ...workerEnv(agent.name), ...(iso ? { FOREMAN_WORKTREE: "1" } : {}) } });
		},
		{
			...(Number.isFinite(maxResumes) && maxResumes >= 0 ? { maxResumes } : {}),
			gate: sharedGate,
			onTransient: (r, backoffMs) => {
				const text = `${r.errorMessage ?? ""}\n${r.stderr ?? ""}`;
				if (isRateLimit(text)) sharedGate.noteRateLimit(text, backoffMs);
			},
		},
	);
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
		if (watch) {
			const report = finalReport(r.messages);
			const clean = r.code === 0 && !/^\s*status:\s*(blocked|failed)/im.test(report) && !report.trimStart().startsWith("[BLOCKED]");
			void watch.then((w) => w?.finish({ keepOpen: !clean }));
		}
		if (!iso) return r;
		try {
			const m = await finishWorktree(iso, req.taskId);
			if (m.merged) return r;
			return withBlockedReport(r, m.conflict, iso);
		} catch (e) {
			return withBlockedReport(r, `merge-back error: ${e instanceof Error ? e.message : String(e)}`, iso);
		}
	});
	return { done, kill: handle.kill, cwd, chosen: { model: chosen.model, thinking: chosen.thinking } };
}

function withBlockedReport(r: PiRunResult, conflict: string, iso: Isolated): PiRunResult {
	const report = finalReport(r.messages);
	return { ...r, messages: [...r.messages, { role: "assistant", content: [{ type: "text", text: blockReport(report, conflict, iso) }] }] };
}
