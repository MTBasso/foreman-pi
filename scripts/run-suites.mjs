#!/usr/bin/env node
// Run named test suites serially, keep full output in a log, print a short summary.
// Usage: node run-suites.mjs [--cwd DIR] [--python ABS] [--pyright ABS --baseline FILE]
//                            [--timeout-s N] <suite>...
//   suite: py:<path> (python -m pytest <path>) | node:<path> | npm:<script>
// Exit 0 all pass, 1 any failure (or NEW pyright errors), 2 usage error.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: run-suites.mjs [--cwd DIR] [--python ABS] [--pyright ABS --baseline FILE] [--timeout-s N] <py:PATH|node:PATH|npm:SCRIPT>...";
const usage = (msg) => { console.error(msg ? `${msg}\n${USAGE}` : USAGE); process.exit(2); };

const opts = { cwd: process.cwd(), python: "python3", pyright: null, baseline: null, timeoutS: 600 };
const suites = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const val = () => (i + 1 < argv.length ? argv[++i] : usage(`${a} needs a value`));
	if (a === "--cwd") opts.cwd = resolve(val());
	else if (a === "--python") opts.python = val();
	else if (a === "--pyright") opts.pyright = val();
	else if (a === "--baseline") opts.baseline = val();
	else if (a === "--timeout-s") {
		opts.timeoutS = Number(val());
		if (!(opts.timeoutS > 0)) usage("--timeout-s must be a positive number");
	} else if (a.startsWith("--")) usage(`unknown option ${a}`);
	else suites.push(a);
}
if (opts.baseline && !opts.pyright) usage("--baseline needs --pyright");
for (const s of suites) if (!/^(py|node|npm):.+/.test(s)) usage(`unprefixed suite: ${s}`);
if (!suites.length && !opts.pyright) usage("no suites given");

const CAP = 300;
const cap = (l) => (l.length > CAP ? l.slice(0, CAP) + "…" : l);
const logDir = join(opts.cwd, ".foreman", "qa-logs");
const sanitise = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "_");

function command(suite) {
	const i = suite.indexOf(":");
	const kind = suite.slice(0, i), rest = suite.slice(i + 1);
	if (kind === "py") return [opts.python, ["-m", "pytest", rest]];
	if (kind === "node") return [process.execPath, [rest]];
	return ["npm", ["run", rest]];
}

function failingNames(lines) {
	const out = new Set();
	for (const l of lines) {
		let m;
		if ((m = /^FAILED\s+(\S+)/.exec(l))) out.add(m[1]);
		else if ((m = /^\s*not ok \d+ - (.+)$/.exec(l))) out.add(m[1].trim());
		else if ((m = /^(?:FAIL|ERROR): (.+)$/.exec(l))) out.add(m[1].trim());
		else if ((m = /^FAIL - (.+)$/.exec(l))) out.add(m[1].trim());
	}
	return [...out];
}

function runOne(suite) {
	return new Promise((done) => {
		const [cmd, args] = command(suite);
		const started = Date.now();
		let out = "", timedOut = false, spawnErr = null;
		const child = spawn(cmd, args, { cwd: opts.cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const take = (b) => { out += b.toString(); };
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => {
			timedOut = true;
			try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
		}, opts.timeoutS * 1000);
		child.on("error", (e) => { spawnErr = e; });
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ suite, code, out, timedOut, spawnErr, secs: (Date.now() - started) / 1000 });
		});
	});
}

mkdirSync(logDir, { recursive: true });
let passed = 0, failed = 0;

for (const suite of suites) {
	const r = await runOne(suite);
	writeFileSync(join(logDir, sanitise(suite) + ".log"), r.out);
	const ok = r.code === 0 && !r.timedOut && !r.spawnErr;
	console.log(`${ok ? "PASS" : "FAIL"} ${suite} ${r.secs.toFixed(1)}s`);
	if (ok) { passed++; continue; }
	failed++;
	if (r.timedOut) console.log(`  timed out after ${opts.timeoutS}s`);
	if (r.spawnErr) console.log(`  spawn error: ${cap(String(r.spawnErr.message))}`);
	const lines = r.out.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const n of failingNames(lines)) console.log(`  failed: ${cap(n)}`);
	console.log(`  --- last ${Math.min(30, lines.length)} line(s) ---`);
	for (const l of lines.slice(-30)) console.log(cap(l));
}

if (opts.pyright) {
	const started = Date.now();
	const r = spawnSync(opts.pyright, ["--outputjson"], { cwd: opts.cwd, shell: false, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	writeFileSync(join(logDir, "pyright.log"), (r.stdout ?? "") + (r.stderr ?? ""));
	let names = null;
	try {
		const j = JSON.parse(r.stdout);
		names = (j.generalDiagnostics ?? [])
			.filter((d) => d.severity === "error")
			.map((d) => `${d.file}:${(d.range?.start?.line ?? 0) + 1} ${d.rule ?? ""} ${String(d.message).replace(/\s+/g, " ")}`.replace(/\s+/g, " ").trim());
	} catch {}
	const secs = ((Date.now() - started) / 1000).toFixed(1);
	if (names === null) {
		failed++;
		console.log(`FAIL pyright ${secs}s`);
		console.log("  could not parse pyright --outputjson output (see .foreman/qa-logs/pyright.log)");
	} else if (!opts.baseline) {
		passed++;
		console.log(`PASS pyright ${secs}s`);
		console.log(`pyright: ${names.length} error(s)`);
	} else {
		const diff = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "baseline-diff.mjs"), resolve(opts.cwd, opts.baseline)], { input: names.join("\n") + "\n", encoding: "utf8" });
		const bad = diff.status !== 0;
		if (bad) failed++; else passed++;
		console.log(`${bad ? "FAIL" : "PASS"} pyright ${secs}s`);
		for (const l of (diff.stdout + (diff.stderr ?? "")).split("\n")) if (l) console.log(cap(l));
	}
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
