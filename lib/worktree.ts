/**
 * Per-worker git worktrees. Parallel writer workers sharing one working tree
 * can destroy each other's uncommitted edits (a worker's `git stash` once swept
 * five others'). Each isolated worker gets `.foreman/worktrees/<task>` on branch
 * `foreman/<task>`, and its commits are merged back when it finishes.
 *
 * All git calls disable repo hooks (`core.hooksPath=/dev/null`): hooks such as a
 * post-checkout that reloads a live desktop must not fire for scratch trees.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const ISOLATABLE_ROLES = new Set(["frontend-dev", "backend-dev", "qa-bugfix", "plan-step-builder"]);

export type IsolateMode = "auto" | "always" | "never";

export function isolateMode(env: Record<string, string | undefined> = process.env): IsolateMode {
	const v = env.FOREMAN_ISOLATE?.trim().toLowerCase();
	return v === "always" || v === "never" ? v : "auto";
}

export function shouldIsolate(role: string, activeWriters: number, mode: IsolateMode): boolean {
	if (!ISOLATABLE_ROLES.has(role) || mode === "never") return false;
	return mode === "always" || activeWriters > 0;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd: string, args: string[]): { ok: boolean; out: string } {
	try {
		return { ok: true, out: git(cwd, args) };
	} catch (e: any) {
		return { ok: false, out: `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim() || String(e?.message ?? e) };
	}
}

export interface Isolated {
	path: string;
	branch: string;
	root: string;
}

/** Create the worktree from the current HEAD of `root`; returns undefined if root is not a git repo or creation fails. */
export function createWorktree(root: string, taskId: string): Isolated | undefined {
	if (!tryGit(root, ["rev-parse", "--git-dir"]).ok) return undefined;
	const wt = path.join(root, ".foreman", "worktrees", taskId);
	const branch = `foreman/${taskId}`;
	try {
		const exclude = git(root, ["rev-parse", "--git-path", "info/exclude"]);
		const file = path.resolve(root, exclude);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
		if (!/^\/?\.foreman\/?$/m.test(cur)) fs.appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}.foreman/\n`);
	} catch {
		// best effort: an untracked .foreman/ is only cosmetic
	}
	const r = tryGit(root, ["worktree", "add", "-q", "-b", branch, wt, "HEAD"]);
	return r.ok ? { path: wt, branch, root } : undefined;
}

export type MergeResult = { merged: true; commits: number; note?: string } | { merged: false; conflict: string };

/** Serialises merge-backs: concurrent `git merge` calls would fight over the index lock. */
let mergeChain: Promise<unknown> = Promise.resolve();
export function finishWorktree(iso: Isolated, taskId: string): Promise<MergeResult> {
	const run = mergeChain.then(() => finishNow(iso, taskId));
	mergeChain = run.catch(() => {});
	return run;
}

function finishNow(iso: Isolated, taskId: string): MergeResult {
	const { path: wt, branch, root } = iso;
	// Keep any work the worker left uncommitted.
	if (git(wt, ["status", "--porcelain"])) {
		git(wt, ["add", "-A"]);
		tryGit(wt, ["-c", "user.name=foreman", "-c", "user.email=foreman@localhost", "commit", "-q", "-m", `foreman: ${taskId} (uncommitted work at exit)`]);
	}
	const ahead = Number(tryGit(root, ["rev-list", "--count", `HEAD..${branch}`]).out) || 0;
	if (ahead === 0) {
		cleanup(iso);
		return { merged: true, commits: 0 };
	}
	const m = tryGit(root, ["-c", "user.name=foreman", "-c", "user.email=foreman@localhost", "merge", "--no-ff", "--no-edit", "-m", `Merge ${branch}`, branch]);
	if (!m.ok) {
		const files = tryGit(root, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
		tryGit(root, ["merge", "--abort"]);
		return {
			merged: false,
			conflict: files.length
				? `merge of ${branch} conflicted in ${files.join(", ")}`
				: `merge of ${branch} failed: ${m.out.split("\n")[0]}`,
		};
	}
	cleanup(iso);
	return { merged: true, commits: ahead };
}

function cleanup(iso: Isolated) {
	tryGit(iso.root, ["worktree", "remove", "--force", iso.path]);
	tryGit(iso.root, ["branch", "-D", iso.branch]);
}

/** Rewrite absolute repo paths in a handoff to point into the worktree (never `.foreman/`: reports stay shared). */
export function retargetPrompt(prompt: string, iso: Isolated): string {
	const esc = iso.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const rewritten = prompt.replace(new RegExp(`${esc}(?!/\\.foreman)`, "g"), iso.path);
	const note =
		`> Isolated worktree: your working directory is ${iso.path} (branch ${iso.branch}), a private checkout of ${iso.root}. ` +
		`Other workers cannot see your files and you cannot see theirs. Commit your work; it is merged back when you finish. ` +
		`Use repo-relative paths. Reports and run files under ${iso.root}/.foreman/ are shared.\n\n`;
	return note + rewritten;
}

/** Make a finished worker's report reflect a failed merge-back. */
export function blockReport(report: string, conflict: string, iso: Isolated): string {
	const why = `${conflict}; work kept on branch ${iso.branch} at ${iso.path}`;
	let out = report;
	out = /^Status:.*$/m.test(out) ? out.replace(/^Status:.*$/m, "Status: blocked") : out;
	out = /^Blocked-on:.*$/m.test(out) ? out.replace(/^Blocked-on:.*$/m, `Blocked-on: ${why}`) : out;
	return `[BLOCKED] Merge-back failed: ${why}.\n\n${out}`;
}
