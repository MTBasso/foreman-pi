import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyChecks, type ExecFn, type ExecResult } from "./verify-checks.ts";

let failures = 0;
const check = (n: string, ok: boolean) => {
	console.log(`${ok ? "ok " : "FAIL"} - ${n}`);
	if (!ok) failures++;
};

const mk = (scripts: Record<string, string>) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "verify-checks-"));
	fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", scripts }));
	return d;
};
const plan = (checks: string) => `## Steps\n\n1. **Thing** (Touches: a)\n   - Checks: ${checks}\n2. **Next** (Touches: b)\n   - Checks: \`npm run other\`\n`;

interface Call { file: string; args: string[]; cwd: string }
const fake = (res: Partial<ExecResult> | Promise<ExecResult>) => {
	const calls: Call[] = [];
	let killed = 0;
	const exec: ExecFn = (file, args, o) => {
		calls.push({ file, args, cwd: o.cwd });
		return {
			promise: res instanceof Promise ? res : Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...res }),
			kill: () => { killed++; },
		};
	};
	return { exec, calls, killed: () => killed };
};
const base = { step: 1, timeoutMs: 60000 };

// only npm scripts present in package.json are run
{
	const d = mk({ a: "x", b: "x" });
	const f = fake({});
	const h = verifyChecks({ ...base, cwd: d, planText: plan("`npm run a`, `npm run missing`, `npm run b`"), exec: f.exec });
	await h.done;
	const suites = f.calls[0]?.args.filter((a) => a.startsWith("npm:"));
	check("only npm scripts present in package.json are run", f.calls.length === 1 && JSON.stringify(suites) === JSON.stringify(["npm:a", "npm:b"]) && f.calls[0].args.includes("--cwd"));
}
// free text never executed
{
	const d = mk({ a: "x" });
	const f = fake({});
	const h = verifyChecks({ ...base, cwd: d, planText: plan("`rm -rf /`, `node evil.js`, `npm run a; touch pwn`, `npm run --evil`"), exec: f.exec });
	const r = await h.done;
	check("free-text checks are never executed", f.calls.length === 0 && r.verified === "n/a");
}
// exit codes
{
	const d = mk({ a: "x" });
	const y = await verifyChecks({ ...base, cwd: d, planText: plan("`npm run a`"), exec: fake({ code: 0, stdout: "PASS npm:a 1s\n" }).exec }).done;
	check("exit 0 gives yes", y.verified === "yes");
	const n = await verifyChecks({ ...base, cwd: d, planText: plan("`npm run a`"), exec: fake({ code: 1, stdout: "PASS npm:z 1s\nFAIL npm:a 2.0s\n  failed: t\nFAIL npm:b 1s\n" }).exec }).done;
	check("exit 1 gives no with the first FAIL line", n.verified === "no" && n.note!.includes("FAIL npm:a 2.0s") && !n.note!.includes("npm:b") && n.note!.includes(".foreman/qa-logs/npm_a.log"));
}
// timeout
{
	const d = mk({ a: "x" });
	const f = fake({ code: null, timedOut: true });
	const h = verifyChecks({ ...base, cwd: d, planText: plan("`npm run a`"), exec: f.exec });
	const r = await h.done;
	check("timeout gives n/a", r.verified === "n/a" && r.note === "timeout");
	let release!: (r: ExecResult) => void;
	const g = fake(new Promise<ExecResult>((res) => (release = res)));
	const h2 = verifyChecks({ ...base, cwd: d, planText: plan("`npm run a`"), exec: g.exec });
	h2.kill();
	release({ code: null, stdout: "", stderr: "", timedOut: false });
	check("kill reaches the child", g.killed() === 1);
	// real run-suites timeout: a sleeping script, 1 s budget
	const dd = mk({ slow: "node -e \"setTimeout(()=>{},30000)\"" });
	const r2 = await verifyChecks({ ...base, timeoutMs: 1000, cwd: dd, planText: plan("`npm run slow`") }).done;
	check("timeout gives n/a and kills the child (real run-suites)", r2.verified === "n/a" && r2.note === "timeout");
}
// missing run-suites / spawn error / no scripts / bad plan
{
	const d = mk({ a: "x" });
	const m = verifyChecks({ ...base, cwd: d, planText: plan("`npm run a`"), runSuites: path.join(d, "nope.mjs"), exec: fake({}).exec });
	check("missing run-suites.mjs gives n/a", m.immediate?.verified === "n/a" && /run-suites/.test(m.immediate.note!));
	const s = await verifyChecks({ ...base, cwd: d, planText: plan("`npm run a`"), exec: fake({ code: null, error: "ENOENT" }).exec }).done;
	check("spawn error gives n/a", s.verified === "n/a" && /spawn error/.test(s.note!));
	check("no parsable scripts gives n/a", verifyChecks({ ...base, cwd: d, planText: plan("do it by hand") }).immediate?.verified === "n/a");
	check("unreadable plan gives n/a", verifyChecks({ ...base, cwd: d, planText: undefined }).immediate?.verified === "n/a");
	check("no package.json gives n/a", verifyChecks({ ...base, cwd: os.tmpdir() + "/definitely-not-here", planText: plan("`npm run a`") }).immediate?.verified === "n/a");
}
// real end-to-end with run-suites
{
	const d = mk({ good: "node -e 0", bad: "node -e process.exit(1)" });
	const y = await verifyChecks({ ...base, cwd: d, planText: plan("`npm run good`") }).done;
	check("real run-suites: passing script gives yes", y.verified === "yes");
	const n = await verifyChecks({ ...base, cwd: d, planText: plan("`npm run good`, `npm run bad`") }).done;
	check("real run-suites: failing script gives no with log path", n.verified === "no" && n.note!.includes("FAIL npm:bad") && n.note!.includes("npm_bad.log"));
}
process.exit(failures ? 1 : 0);
