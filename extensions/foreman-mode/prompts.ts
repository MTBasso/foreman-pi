/**
 * Prompt builders for the foreman-mode commands.
 *
 * The skill text is embedded directly (frontmatter stripped, package root
 * stated) instead of sending `/skill:name`: the `claude` CLI behind
 * pi-claude-cli has its own Skill tool and can try to resolve the name
 * against its own skill system. Everything here is model-facing, so it stays
 * English; the user's own request is appended verbatim in whatever language
 * it was typed.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PACKAGE_ROOT } from "../../lib/agents.ts";

export function stripFrontmatter(text: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
	return (m ? text.slice(m[0].length) : text).trim();
}

export function readSkillBody(name: string, root: string = PACKAGE_ROOT): string {
	return stripFrontmatter(readFileSync(join(root, "skills", name, "SKILL.md"), "utf8"));
}

export function readReference(name: string, root: string = PACKAGE_ROOT): string {
	return readFileSync(join(root, "references", `${name}.md`), "utf8").trim();
}

/** Expand a leading `~` / `~/` ourselves (shells do not expand it inside quotes). */
export function expandHome(p: string, home: string = homedir()): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return p;
}

/**
 * Resolve a plan argument: a path (absolute, `~/`, or relative to cwd), else a
 * slug under docs/plans/. Returns an absolute path and whether it exists; a
 * missing file is still returned (the model is told, the command does not fail).
 */
export function resolvePlanPath(arg: string, cwd: string): { path: string; exists: boolean } {
	const expanded = expandHome(arg.trim());
	const direct = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	const candidates = [direct, resolve(cwd, "docs", "plans", expanded), resolve(cwd, "docs", "plans", `${expanded}.md`), `${direct}.md`];
	for (const c of candidates) if (existsSync(c)) return { path: c, exists: true };
	return { path: direct, exists: false };
}

function preface(root: string): string {
	return (
		`Package root: ${root}\n` +
		"Resolve every `references/`, `agents/` and `templates/` path against the package root above. " +
		"The skill text below is already loaded: do not look for its location, and do not try to run it as a skill."
	);
}

const NO_REQUEST =
	"The user has not stated a request yet: greet them briefly and ask what they want to build or fix, following the skill's grilling approach.";

const MODE_NOTE =
	"Orchestrator mode is ON (the user ran the command). If `foreman_delegate` ever refuses with a not-in-mode error, tell the user to run /foreman; never try bash or file edits to work around it.";

export function buildForemanPrompt(request: string, root: string = PACKAGE_ROOT): string {
	const req = request.trim();
	return [
		"You are now the foreman orchestrator. Follow the foreman skill below.",
		MODE_NOTE,
		preface(root),
		"--- foreman skill ---",
		readSkillBody("foreman", root),
		"--- end foreman skill ---",
		req ? `User request (verbatim):\n${req}` : NO_REQUEST,
	].join("\n\n");
}

export function buildAuditPrompt(scope: string, root: string = PACKAGE_ROOT): string {
	const s = scope.trim();
	return [
		"You are now the foreman orchestrator, running an audit request. Follow the foreman skill below, but go straight to §1.5 (audit request): skip the grilling and planning steps.",
		MODE_NOTE,
		preface(root),
		"--- foreman skill ---",
		readSkillBody("foreman", root),
		"--- end foreman skill ---",
		s ? `Audit scope (verbatim):\n${s}` : "No scope was given: audit the whole project, or ask the user one question to narrow it if that is clearly too broad.",
	].join("\n\n");
}

export function buildDiagnosePrompt(problem: string, root: string = PACKAGE_ROOT): string {
	const p = problem.trim();
	return [
		"The user ran /foreman-diagnose. Follow the diagnosing-a-run reference below. This is a read-only diagnosis: report what happened with cited evidence, and do not edit files or redesign the plugin.",
		preface(root),
		"--- diagnosing-a-run reference ---",
		readReference("diagnosing-a-run", root),
		"--- end reference ---",
		p ? `What the user said went wrong (verbatim):\n${p}` : "The user gave no description yet: start with the problem intake (§1).",
	].join("\n\n");
}

export function buildPlanRunnerPrompt(planPath: string, exists: boolean, root: string = PACKAGE_ROOT): string {
	return [
		"You are now the plan-runner orchestrator. Follow the plan-runner skill below.",
		MODE_NOTE,
		preface(root),
		"--- plan-runner skill ---",
		readSkillBody("plan-runner", root),
		"--- end plan-runner skill ---",
		`Plan to run: ${planPath}` +
			(exists ? "" : "\n(The file did not exist when the command ran: verify the path with the user before dispatching anything.)"),
	].join("\n\n");
}
