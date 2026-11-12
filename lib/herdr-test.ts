import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { createHerdr, herdrActive, openWatchPane, paneTitle, panesEnabled, shellQuote } from "./herdr.ts";
let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };
const calls: string[][] = [];
const run = (_b: string, a: string[]) => void calls.push(a);

check("inactive outside herdr", !herdrActive({}));
check("needs pane id", !herdrActive({ HERDR_ENV: "1" }));
const off = createHerdr({}, run);
off.notify("x"); off.reportWorkers({ running: 1, queued: 0 });
check("no-op when inactive", calls.length === 0);

// the pane id must directly follow the subcommand: herdr rejects options-first order
const orderCalls: string[][] = [];
const ord = createHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "wA:p1" }, (_b, a) => void orderCalls.push(a));
ord.reportWorkers({ running: 1, queued: 0 });
check("report-metadata: pane id before options", orderCalls[0][2] === "wA:p1" && orderCalls[0][3] === "--source");
const on = createHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "wA:p1" }, run);
on.reportWorkers({ running: 2, queued: 1 });
on.reportWorkers({ running: 2, queued: 1 });
check("dedupes identical titles", calls.length === 1 && calls[0].includes("foreman: 2 running, 1 queued"));
on.reportWorkers({ running: 0, queued: 0 });
check("clears title when idle", calls[1].includes("--clear-title"));
on.notify("blocked", "needs input");
check("notification", calls[2][0] === "notification" && calls[2].includes("--body"));
check("paneTitle idle", paneTitle({ running: 0, queued: 0 }) === undefined);

// watch panes
const pcalls: string[][] = [];
let n = 9;
const prun = async (_b: string, a: string[]) => { pcalls.push(a); return a[1] === "split" ? JSON.stringify({ result: { pane: { pane_id: `wA:p${n++}` } } }) : ""; };
const henv = { HERDR_ENV: "1", HERDR_PANE_ID: "wA:p1" };
check("panes enabled in herdr", panesEnabled(henv) && !panesEnabled({ ...henv, FOREMAN_HERDR_PANES: "0" }) && !panesEnabled({}));
check("no pane outside herdr", (await openWatchPane({ taskId: "t1", role: "qa", cwd: "/x", logFile: "/tmp/x.jsonl", tailScript: "/s" }, {}, prun)) === undefined);
const dir = fs.mkdtempSync(`${os.tmpdir()}/hw-`);
const log = `${dir}/t1.events.jsonl`;
const wp = await openWatchPane({ taskId: "t1", role: "qa", cwd: "/x", logFile: log, tailScript: "/s/herdr-tail.mjs" }, henv, prun);
check("first worker splits the orchestrator to the right (new column)", pcalls[0][1] === "split" && pcalls[0][2] === "wA:p1" && pcalls[0].includes("right"));
check("pane is renamed, cleared, and exec's the tail script", pcalls[1][1] === "rename" && pcalls[2][1] === "run" && /^clear; exec node '\/s\/herdr-tail\.mjs'/.test(pcalls[2].at(-1)!));
await openWatchPane({ taskId: "t2", role: "qa", cwd: "/x", logFile: log + "2", tailScript: "/s" }, henv, prun);
check("second worker stacks below the first in the column", pcalls[3][2] === "wA:p9" && pcalls[3].includes("down"));
await wp!.finish({ keepOpen: false });
check("clean finish writes ok and never closes the pane itself", fs.readFileSync(log + ".done", "utf-8") === "ok" && !pcalls.some((a) => a[1] === "close"));
await wp!.finish({ keepOpen: true });
check("attention finish writes attention", fs.readFileSync(log + ".done", "utf-8") === "attention");
// a closed stack target falls back to a fresh column
let fail = true;
const flaky = async (_b: string, a: string[]) => (a[1] === "split" && a[2] === "wA:p10" && fail ? undefined : prun(_b, a));
const w3 = await openWatchPane({ taskId: "t3", role: "qa", cwd: "/x", logFile: log + "3", tailScript: "/s" }, henv, flaky);
check("stale stack target falls back to a new column", !!w3 && pcalls.at(-3)![2] === "wA:p1" && pcalls.at(-3)!.includes("right"));
check("shellQuote escapes quotes", shellQuote("a'b") === `'a'\\''b'`);

// tail script: renderer + lifecycle
const tailMod: any = await import(/* @vite-ignore */ "../scripts/herdr-tail.mjs" as string);
const st = { calls: 0, errors: 0 };
const asst = (content: unknown[], extra = {}) => JSON.stringify({ type: "message_end", message: { role: "assistant", content, ...extra } });
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const o1 = tailMod.render(asst([{ type: "text", text: "plan it" }, { type: "toolCall", name: "write", arguments: { path: "/home/u/Code/temp/src/b.py", content: "x".repeat(212) } }]), st).map(strip);
check("render: text and write summary", o1[0].includes("plan it") && o1[1].includes("write …/temp/src/b.py") && o1[1].includes("212 chars"));
check("render: edit counts changes, no raw JSON", strip(tailMod.render(asst([{ type: "toolCall", name: "edit", arguments: { path: "a.py", edits: [{}, {}] } }]), st)[0]).includes("2 change(s)") && !tailMod.render(asst([{ type: "toolCall", name: "edit", arguments: { path: "a.py", edits: [{ oldText: "SECRET" }] } }]), st)[0].includes("SECRET"));
check("render: ok tool results are silent", tailMod.render(JSON.stringify({ type: "message_end", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "fine" }] } }), st).length === 0);
check("render: tool errors shown and counted", strip(tailMod.render(JSON.stringify({ type: "message_end", message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "ENOENT" }] } }), st)[0]).includes("✗ read: ENOENT") && st.errors === 1);
check("render: junk lines ignored", tailMod.render("nope", st).length === 0);
check("fmtElapsed", tailMod.fmtElapsed(4000) === "4s" && tailMod.fmtElapsed(125000) === "2m05s");
const tailRun = (verdict: string) => {
	const f = `${dir}/run-${verdict}.jsonl`;
	fs.writeFileSync(f, asst([{ type: "toolCall", name: "bash", arguments: { command: "ls" } }]) + "\n");
	fs.writeFileSync(f + ".done", verdict);
	return execFileSync("node", [new URL("../scripts/herdr-tail.mjs", import.meta.url).pathname, f, "t1 · qa"], { encoding: "utf-8", timeout: 20000, env: { ...process.env, LINGER_S: "0", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
};
check("tail: ok run prints summary and exits by itself", /finished/.test(strip(tailRun("ok"))) && /1 tool calls/.test(strip(tailRun("ok"))));

console.log(failures === 0 ? "All herdr checks passed." : `${failures} herdr check(s) FAILED.`);
if (failures) process.exit(1);
