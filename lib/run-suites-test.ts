import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };

const script = new URL("../scripts/run-suites.mjs", import.meta.url).pathname;
const exec = (cwd: string, ...a: string[]) => spawnSync(process.execPath, [script, "--cwd", cwd, ...a], { encoding: "utf8" });
const d = mkdtempSync(join(tmpdir(), "run-suites-"));
const w = (name: string, body: string) => { writeFileSync(join(d, name), body); };

try {
	w("ok.mjs", "console.log('all fine');\n");
	w("bad.mjs", "for (let i = 1; i <= 40; i++) console.log('line ' + i);\nconsole.log('not ok 7 - the broken thing');\nconsole.log('FAIL - my check');\nconsole.log('x'.repeat(1000));\nprocess.exit(1);\n");
	w("hang.mjs", "setInterval(() => {}, 1000);\n");
	w("a.mjs", "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[1].replace('a.mjs', 'order.txt'), 'a');\n");
	w("b.mjs", "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[1].replace('b.mjs', 'order.txt'), 'b');\n");

	{
		const r = exec(d, "node:ok.mjs");
		check("pass suite prints one PASS line and exits 0", r.status === 0 && /^PASS node:ok\.mjs \d+\.\ds$/m.test(r.stdout) && r.stdout.includes("1 passed, 0 failed") && !r.stdout.includes("all fine"));
	}
	{
		const r = exec(d, "node:bad.mjs");
		const lines = r.stdout.split("\n");
		check("failing suite prints names, tail 30 and exits 1",
			r.status === 1 && /^FAIL node:bad\.mjs/m.test(r.stdout) && r.stdout.includes("not ok 7 - the broken thing") && r.stdout.includes("my check")
			&& /^line 40$/m.test(r.stdout) && !/^line 5$/m.test(r.stdout) && r.stdout.includes("0 passed, 1 failed"));
		check("long lines are capped", lines.every((l) => l.length <= 320) && lines.some((l) => l.includes("xxx")));
		const log = join(d, ".foreman", "qa-logs");
		const files = existsSync(log) ? readFileSync(join(log, "node_bad.mjs.log"), "utf8") : "";
		check("full log written under .foreman/qa-logs", files.includes("line 1\n") && files.includes("x".repeat(1000)));
	}
	{
		const t = Date.now();
		const r = exec(d, "--timeout-s", "1", "node:hang.mjs");
		check("timeout kills the suite and reports FAIL", r.status === 1 && /FAIL node:hang\.mjs/.test(r.stdout) && /timed out/.test(r.stdout) && Date.now() - t < 8000);
	}
	{
		const r = exec(d, "ok.mjs");
		check("unprefixed suite exits 2", r.status === 2 && /usage/i.test(r.stderr));
		check("no suites exits 2", exec(d).status === 2);
	}
	{
		const r = exec(d, "node:b.mjs", "node:a.mjs", "node:b.mjs");
		const order = readFileSync(join(d, "order.txt"), "utf8");
		check("suites run serially in the order given", r.status === 0 && order === "bab" && r.stdout.indexOf("node:b.mjs") < r.stdout.indexOf("node:a.mjs"));
	}
	{
		const marker = join(d, "marker.txt");
		const evil = `--eval=require('fs').writeFileSync(${JSON.stringify(marker)},'x')`;
		for (const s of [`node:${evil}`, "py:-pplugin", "npm:--prefix=/tmp"]) {
			const r = exec(d, s);
			check(`leading-dash suite rejected: ${s.slice(0, 12)}`, r.status === 2 && /must not start with "-"/.test(r.stderr) && !existsSync(marker) && !r.stdout.includes("PASS"));
		}
		const rel = exec(d, "--python", "python3", "py:x");
		check("relative --python rejected", rel.status === 2 && /absolute/.test(rel.stderr));
		check("relative --pyright rejected", exec(d, "--pyright", "pyright").status === 2);
		check("missing --cwd rejected", spawnSync(process.execPath, [script, "--cwd", join(d, "nope"), "node:ok.mjs"], { encoding: "utf8" }).status === 2);
	}
	{
		const fakePy = join(d, "fakepy");
		writeFileSync(fakePy, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(join(d, "pyargs.txt"))}, process.argv.slice(2).join(' '));\n`);
		chmodSync(fakePy, 0o755);
		const r = exec(d, "--python", fakePy, "py:tests/test_x.py");
		check("py: suite runs python -m pytest <path>", r.status === 0 && readFileSync(join(d, "pyargs.txt"), "utf8") === "-m pytest tests/test_x.py");
		writeFileSync(join(d, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { good: "node -e 0", bad: "node -e \"process.exit(1)\"" } }));
		const g = exec(d, "npm:good");
		check("npm: suite passing exits 0", g.status === 0 && /^PASS npm:good/m.test(g.stdout));
		const b = exec(d, "npm:bad");
		check("npm: suite failing exits 1", b.status === 1 && /^FAIL npm:bad/m.test(b.stdout));
	}
	{
		const diag = (items: [string, number, string, string][]) => JSON.stringify({ generalDiagnostics: items.map(([file, line, rule, message]) => ({ file, severity: "error", message, rule, range: { start: { line: line - 1, character: 0 } } })).concat([{ file: "w.py", severity: "warning", message: "warn", rule: "r", range: { start: { line: 0, character: 0 } } }] as any) });
		const fake = (name: string, json: string) => { const p = join(d, name); writeFileSync(p, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(json)});\nprocess.exit(1);\n`); chmodSync(p, 0o755); return p; };
		const base = join(d, "base.txt");
		writeFileSync(base, "a.py:3 reportX old problem\n");
		const same = fake("pyright-same", diag([["a.py", 3, "reportX", "old problem"]]));
		const more = fake("pyright-new", diag([["a.py", 3, "reportX", "old problem"], ["b.py", 9, "reportY", "fresh problem"]]));
		const ok = exec(d, "--pyright", same, "--baseline", base);
		check("pyright baseline: only NEW errors fail", ok.status === 0 && !ok.stdout.includes("NEW:"));
		const bad = exec(d, "--pyright", more, "--baseline", base);
		check("pyright baseline: NEW line printed and exit 1", bad.status === 1 && bad.stdout.includes("NEW: b.py:9 reportY fresh problem") && !bad.stdout.includes("warn"));
		const nob = exec(d, "--pyright", more);
		check("pyright without baseline prints error count only", nob.status === 0 && /pyright: 2 error/.test(nob.stdout));
	}
} finally { rmSync(d, { recursive: true, force: true }); }

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("run-suites tests passed");
