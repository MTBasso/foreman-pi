/**
 * Docs tests (Phase 10). Run with: npx tsx lib/readme-test.ts
 *
 *  - the README "Model fallback" section is byte-identical to the one on `main`
 *    (git, when a `main` ref exists) and to a pinned sha256 of that section
 *    (so a shallow CI checkout without `main` still guards it);
 *  - README.md and README.pt-BR.md list exactly the roles in lib/roles.ts and
 *    document every slash command the extensions register;
 *  - both READMEs document the language/env variables;
 *  - grep gate: no stale references (the dropped role, the vendored dispatcher, the
 *    removed marker file) outside the historical docs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "./roles.ts";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
	console.log(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
}

/** sha256 of the frozen section as it exists on main (heading through the blank line before the next `## `). */
const FALLBACK_SHA256 = "f7720cc65898104facb2e8744ae0082603767f92a3ae9792a5081af62d092aec";
const FALLBACK_HEADING = "## Model fallback (false-positive testing, not a refusal bypass)\n";

/** Text from `heading` up to (not including) the next level-2 heading. */
function section(text: string, heading: string): string | undefined {
	const start = text.indexOf(heading);
	if (start < 0) return undefined;
	const rest = text.slice(start + heading.length);
	const next = rest.search(/^## /m);
	return text.slice(start, next < 0 ? text.length : start + heading.length + next);
}

// --- Model fallback section is frozen ----------------------------------------
const readme = read("README.md");
const ptReadme = read("README.pt-BR.md");
const mine = section(readme, FALLBACK_HEADING);
check("README has the Model fallback section", mine !== undefined);
check("Model fallback section matches the pinned sha256", mine !== undefined && createHash("sha256").update(mine).digest("hex") === FALLBACK_SHA256);
const git = spawnSync("git", ["show", "main:README.md"], { cwd: ROOT, encoding: "utf8" });
if (git.status === 0) {
	const onMain = section(git.stdout, FALLBACK_HEADING);
	check("Model fallback section is byte-identical to main:README.md", onMain !== undefined && onMain === mine);
} else {
	console.log("skip - no `main` ref available (shallow checkout); the pinned sha256 covers it");
}
check("README.pt-BR.md does not copy the frozen section", !ptReadme.includes("retries a refused Claude response on GPT"));
check("README.pt-BR.md points at the English section", ptReadme.includes("README.md#model-fallback-false-positive-testing-not-a-refusal-bypass"));

// --- roles and commands match the code ---------------------------------------
function firstColumnTicks(text: string, re: RegExp): string[] {
	return [...text.matchAll(re)].map((m) => m[1]);
}
for (const [file, text, heading] of [
	["README.md", readme, "## Roles\n"],
	["README.pt-BR.md", ptReadme, "## Papéis (roles)\n"],
] as const) {
	const sec = section(text, heading);
	const roles = sec ? firstColumnTicks(sec, /^\| `([a-z-]+)` \|/gm) : [];
	check(`${file}: roles table equals lib/roles.ts`, JSON.stringify([...roles].sort()) === JSON.stringify([...ROLES].sort()), roles.join(", "));
	const tiers = sec ? [...sec.matchAll(/^\| `([a-z-]+)` \| (strong|mid|cheap) \|/gm)].length : 0;
	check(`${file}: every role row has a tier`, tiers === ROLES.length);
	const dropped = ["release", "manager"].join("-");
	check(`${file}: roles table has no dropped-role row`, !(sec ?? "").includes(`\`${dropped}\``));
}

const registered = new Set<string>();
for (const ext of fs.readdirSync(path.join(ROOT, "extensions"))) {
	const f = path.join(ROOT, "extensions", ext, "index.ts");
	if (!fs.existsSync(f)) continue;
	for (const m of fs.readFileSync(f, "utf8").matchAll(/registerCommand\(\s*"([^"]+)"/g)) registered.add(m[1]);
}
check("found the registered commands", registered.size >= 5, [...registered].join(", "));
for (const [file, text] of [
	["README.md", readme],
	["README.pt-BR.md", ptReadme],
] as const) {
	const documented = new Set(firstColumnTicks(text, /^\| `\/([a-z-]+)[ `]/gm));
	check(
		`${file}: command table equals the registered commands`,
		[...registered].sort().join(",") === [...documented].sort().join(","),
		`code=${[...registered].sort()} docs=${[...documented].sort()}`,
	);
}

// --- both READMEs document the language split and the main env vars -----------
for (const [file, text] of [
	["README.md", readme],
	["README.pt-BR.md", ptReadme],
] as const) {
	for (const v of ["FOREMAN_LANG", "FOREMAN_PI_MODE", "FOREMAN_MODEL_<ROLE>", "FOREMAN_MODEL_<TIER>", "FOREMAN_THINKING_<ROLE>", "FOREMAN_PI_ROLE", "foreman-report"]) {
		check(`${file} mentions ${v}`, text.includes(v));
	}
	check(`${file} links the other README`, text.slice(0, 200).includes(file === "README.md" ? "README.pt-BR.md" : "](README.md)"));
}
check("README.pt-BR.md is Portuguese with accents", /ç/.test(ptReadme) && /ã/.test(ptReadme) && /ções/.test(ptReadme));

// --- grep gate: stale references --------------------------------------------
// Needles are built from pieces so this file does not contain them itself.
const j = (...p: string[]) => new RegExp(p.join("-").replace(/\./g, "\\."));
const STALE: [string, RegExp][] = [
	["the dropped release role", j("release", "manager")],
	["the vendored dispatcher", j("subagent", "dispatch")],
	["marker file as a mechanism", new RegExp(`${j(".orchestrator", "active").source}|${j("orchestrator", "marker").source}`)],
];
const HISTORICAL = ["PLAN.md", "CHANGELOG.md", "docs/plans/", "docs/verification-log.md"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".foreman"]);
function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (SKIP_DIRS.has(e.name)) return [];
		const full = path.join(dir, e.name);
		return e.isDirectory() ? walk(full) : [path.relative(ROOT, full).split(path.sep).join("/")];
	});
}
const scanned = walk(ROOT).filter(
	(f) =>
		/\.(md|ts|json|yml|yaml)$/.test(f) &&
		f !== "package-lock.json" &&
		!f.startsWith(".claude/") &&
		!HISTORICAL.some((h) => f === h || f.startsWith(h)),
);
check("grep gate scans the docs and source", scanned.includes("README.md") && scanned.includes("lib/roles.ts") && scanned.includes("skills/foreman/SKILL.md"));
for (const [label, re] of STALE) {
	const hits = scanned.filter((f) => re.test(read(f)));
	check(`grep gate: no ${label} outside historical docs`, hits.length === 0, hits.join(", "));
}

console.log(failures === 0 ? "\nAll docs checks passed." : `\n${failures} docs check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
