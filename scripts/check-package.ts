/**
 * Real install check for the packed foreman-pi tarball (`npm run test:package`).
 *
 *   1. hash the REAL ~/.pi/agent/settings.json
 *   2. `npm pack`, extract, assert the tarball contents
 *   3. build a sandbox env (PI_CODING_AGENT_DIR, HOME, offline/no-telemetry flags)
 *   4. `pi install <extracted dir>` + `pi list`
 *   5. `pi --mode rpc --no-session` + `get_commands` (skills from the package, no load errors)
 *   6. `pi --list-models` still lists `foreman hybrid` (model-fallback loads)
 *   7. import lib/agents.ts from the extracted copy, assert the package agents
 *   8. re-hash the real settings: must be unchanged
 *
 * Never writes to the real pi dir: every `pi`/`npm` child runs with a sandbox
 * HOME and PI_CODING_AGENT_DIR under a temp dir that is removed in `finally`.
 * Needs no login and no network (RPC `get_commands` works without credentials).
 *
 * Each later phase that adds an extension, command or role extends the
 * EXPECTED_* lists below.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REAL_HOME = os.homedir();
const REAL_SETTINGS = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(REAL_HOME, ".pi", "agent"), "settings.json");

// --- expected lists (extend per phase) --------------------------------------
const EXPECTED_EXTENSIONS = ["context-filter", "coordination", "foreman-mode", "model-fallback", "orchestrator-guardrail", "session-reminder", "worker-guard"];
const EXPECTED_SKILLS = ["design-preview", "foreman", "plan-runner", "project-memory"];
/** Slash commands registered by this package's extensions. */
const EXPECTED_EXTENSION_COMMANDS: string[] = ["foreman", "foreman-audit", "foreman-diagnose", "foreman-status", "plan-runner"];
const EXPECTED_AGENTS = [
	"backend-dev",
	"codebase-auditor",
	"frontend-dev",
	"plan-step-builder",
	"planner",
	"qa",
	"qa-bugfix",
	"reviewer",
	"shipper",
];
const REQUIRED_FILES = ["package.json", "LICENSE", "README.md", "lib/agents.ts", "lib/spawn.ts", "lib/mode.ts", "lib/workers.ts", "lib/ui.ts"];
const FORBIDDEN = [/(^|\/)smoke-test\.ts$/, /-test\.ts$/, /(^|\/)live-[^/]*\.ts$/, /^agents\/models\.json$/, /(^|\/)node_modules\//];
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
	console.log(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
}

function hashFile(p: string): string {
	try {
		return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
	} catch {
		return "absent";
	}
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 60_000) {
	const r = spawnSync(cmd, args, { env, cwd, encoding: "utf8", timeout: timeoutMs });
	return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function walk(dir: string, base = dir): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
	});
}

/** Send one RPC command to a fresh `pi --mode rpc` and resolve with its response + stderr. */
function rpc(env: NodeJS.ProcessEnv, cwd: string, command: object, timeoutMs = 30_000) {
	return new Promise<{ response: any; stderr: string; events: any[] }>((resolve, reject) => {
		const child = spawn("pi", ["--mode", "rpc", "--no-session"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
		let buf = "";
		let stderr = "";
		const events: any[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`rpc timeout after ${timeoutMs}ms; stderr: ${stderr.slice(0, 500)}`));
		}, timeoutMs);
		child.stderr.on("data", (d) => (stderr += d));
		child.stdout.on("data", (d) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line) continue;
				let msg: any;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				events.push(msg);
				if (msg.type === "response" && msg.command === (command as any).type) {
					clearTimeout(timer);
					child.kill("SIGTERM");
					resolve({ response: msg, stderr, events });
				}
			}
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.stdin.write(`${JSON.stringify(command)}\n`);
	});
}

async function main() {
	// 1. real settings hash
	const before = hashFile(REAL_SETTINGS);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-check-package-"));
	try {
		const sandboxHome = path.join(tmp, "home");
		const agentDir = path.join(tmp, "agent");
		const packDir = path.join(tmp, "pack");
		const work = path.join(tmp, "work");
		for (const d of [sandboxHome, agentDir, packDir, work]) fs.mkdirSync(d, { recursive: true });

		// 3. sandbox env (also used for npm so its cache/config never touches the real HOME)
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: sandboxHome,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
		};
		// A parent worker/orchestrator env must not leak in: the mode commands are no-ops in worker processes.
		delete env.FOREMAN_PI_SUBAGENT;
		delete env.FOREMAN_PI_MODE;
		check("sandbox dirs are outside the real pi dir", ![agentDir, sandboxHome].some((d) => d.startsWith(path.dirname(REAL_SETTINGS))));

		// 2. npm pack + extract + assert contents
		const pack = run("npm", ["pack", REPO, "--pack-destination", packDir, "--json", "--ignore-scripts"], env, work);
		check("npm pack succeeds", pack.code === 0, pack.stderr.slice(0, 300));
		if (pack.code !== 0) return;
		let tarball = "";
		try {
			const parsed = JSON.parse(pack.stdout);
			const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
			tarball = path.join(packDir, (entry as any).filename);
		} catch (e) {
			check("npm pack --json is parseable", false, String(e));
			return;
		}
		const extractRoot = path.join(tmp, "extract");
		fs.mkdirSync(extractRoot);
		const tar = run("tar", ["xzf", tarball, "-C", extractRoot], env, work);
		check("tarball extracts", tar.code === 0, tar.stderr);
		const pkgDir = path.join(extractRoot, "package");
		const files = walk(pkgDir);

		for (const f of REQUIRED_FILES) check(`tarball contains ${f}`, files.includes(f));
		for (const ext of EXPECTED_EXTENSIONS) check(`tarball contains extensions/${ext}/index.ts`, files.includes(`extensions/${ext}/index.ts`));
		for (const s of EXPECTED_SKILLS) check(`tarball contains skills/${s}/SKILL.md`, files.includes(`skills/${s}/SKILL.md`));
		for (const a of EXPECTED_AGENTS) check(`tarball contains agents/${a}.md`, files.includes(`agents/${a}.md`));
		for (const re of FORBIDDEN) {
			const hits = files.filter((f) => re.test(f));
			check(`tarball excludes ${re}`, hits.length === 0, hits.join(", "));
		}
		const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
		check("manifest has pi.extensions and pi.skills", Array.isArray(manifest.pi?.extensions) && Array.isArray(manifest.pi?.skills));

		// 4. pi install + pi list
		const inst = run("pi", ["install", pkgDir], env, work);
		check("pi install <extracted dir> exits 0", inst.code === 0, (inst.stderr || inst.stdout).slice(0, 300));
		const list = run("pi", ["list"], env, work);
		check("pi list shows the package", list.code === 0 && list.stdout.includes(pkgDir), list.stdout.slice(0, 300));

		// 5. rpc get_commands (skills + extension commands, origin package, no load errors)
		try {
			const { response, stderr, events } = await rpc(env, work, { type: "get_commands" });
			check("get_commands succeeds", response.success === true, JSON.stringify(response).slice(0, 300));
			const commands: any[] = response.data?.commands ?? [];
			const pkgCommands = commands.filter((c) => c.sourceInfo?.origin === "package");
			for (const s of EXPECTED_SKILLS) {
				const c = commands.find((x) => x.name === `skill:${s}`);
				check(`skill:${s} comes from the package`, !!c && c.source === "skill" && c.sourceInfo?.origin === "package" && c.sourceInfo?.baseDir === pkgDir, JSON.stringify(c?.sourceInfo));
			}
			for (const name of EXPECTED_EXTENSION_COMMANDS) {
				const c = commands.find((x) => x.name === name);
				check(`/${name} comes from the package`, !!c && c.sourceInfo?.origin === "package");
			}
			check(
				"no unexpected package commands",
				pkgCommands.length === EXPECTED_SKILLS.length + EXPECTED_EXTENSION_COMMANDS.length,
				pkgCommands.map((c) => c.name).join(", "),
			);
			const loadErrors = [
				...stderr.split("\n").filter((l) => /error|failed to load|cannot find|diagnostic/i.test(l)),
				...events.filter((e) => /error/i.test(String(e.type)) || (e.type === "response" && e.success === false)).map((e) => JSON.stringify(e).slice(0, 200)),
			];
			check("no load errors on stderr/events", loadErrors.length === 0, loadErrors.join(" | ").slice(0, 400));
		} catch (e) {
			// Documented fallback: if RPC ever needs a login, rely on `pi list` + the SDK loader checks (steps 4, 6, 7).
			check("rpc get_commands", false, String(e));
		}

		// 6. model-fallback still loads: the virtual model is listed
		const models = run("pi", ["--list-models"], env, work);
		check("pi --list-models lists `foreman hybrid`", models.code === 0 && /foreman\s+hybrid/.test(models.stdout), (models.stderr || models.stdout).slice(0, 300));

		// 7. lib/agents.ts imported from the extracted copy finds the package agents.
		// The copy has no node_modules, so link the repo's (devDependency) one for resolution only.
		fs.symlinkSync(path.join(REPO, "node_modules"), path.join(pkgDir, "node_modules"), "dir");
		const probe = path.join(tmp, "probe.mts");
		fs.writeFileSync(
			probe,
			`import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(${JSON.stringify(path.join(pkgDir, "lib", "agents.ts"))}).href);
const r = mod.discoverAgents(${JSON.stringify(work)}, "both");
console.log(JSON.stringify(r.agents.map((a: any) => ({ name: a.name, source: a.source, filePath: a.filePath }))));
`,
		);
		const tsx = path.join(REPO, "node_modules", ".bin", "tsx");
		const probed = run(tsx, [probe], env, work);
		check("import lib/agents.ts from extracted copy", probed.code === 0, probed.stderr.slice(0, 400));
		if (probed.code === 0) {
			const agents: { name: string; source: string; filePath: string }[] = JSON.parse(probed.stdout.trim().split("\n").pop() ?? "[]");
			const names = agents.map((a) => a.name).sort();
			check("package agents discovered from the extracted copy", JSON.stringify(names) === JSON.stringify([...EXPECTED_AGENTS].sort()), names.join(", "));
			check("all discovered agents are source=package inside the extracted dir", agents.every((a) => a.source === "package" && a.filePath.startsWith(path.join(pkgDir, "agents"))));
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
		// 8. real settings unchanged
		const after = hashFile(REAL_SETTINGS);
		check("real settings.json unchanged", after === before, `${before} -> ${after}`);
	}
}

try {
	await main();
} catch (e) {
	console.log(`FAIL - unexpected error: ${e instanceof Error ? e.stack : e}`);
	failures++;
}
console.log(failures === 0 ? "\nAll package checks passed." : `\n${failures} package check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
