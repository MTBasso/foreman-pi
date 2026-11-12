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
const prun = async (_b: string, a: string[]) => { pcalls.push(a); return a[1] === "split" ? JSON.stringify({ result: { pane: { pane_id: "wA:p9" } } }) : ""; };
const henv = { HERDR_ENV: "1", HERDR_PANE_ID: "wA:p1" };
check("panes enabled in herdr", panesEnabled(henv) && !panesEnabled({ ...henv, FOREMAN_HERDR_PANES: "0" }) && !panesEnabled({}));
check("no pane outside herdr", (await openWatchPane({ taskId: "t1", role: "qa", cwd: "/x", logFile: "/tmp/x.jsonl", tailScript: "/s" }, {}, prun)) === undefined);
const log = `${fs.mkdtempSync(`${os.tmpdir()}/hw-`)}/t1.events.jsonl`;
const wp = await openWatchPane({ taskId: "t1", role: "qa", cwd: "/x", logFile: log, tailScript: "/s/herdr-tail.mjs" }, henv, prun);
check("first pane splits the orchestrator pane downward", pcalls[0].includes("down") && pcalls[0].at(-1) === "wA:p1");
check("pane is renamed and runs the tail script", pcalls[1][1] === "rename" && pcalls[2][1] === "run" && pcalls[2].at(-1)!.includes("herdr-tail.mjs"));
await openWatchPane({ taskId: "t2", role: "qa", cwd: "/x", logFile: log + "2", tailScript: "/s" }, henv, prun);
check("second pane splits the first to the right", pcalls[3].includes("right") && pcalls[3].at(-1) === "wA:p9");
await wp!.finish({ keepOpen: true });
check("finish writes the .done marker and keeps the pane", fs.existsSync(log + ".done") && !pcalls.some((a) => a[1] === "close"));
await wp!.finish({ keepOpen: false, closeAfterMs: 1 });
check("finish closes a clean pane", pcalls.some((a) => a[1] === "close"));
check("shellQuote escapes quotes", shellQuote("a'b") === `'a'\\''b'`);

// tail script renderer
const fixture = `${log}.fixture`;
fs.writeFileSync(fixture, [
	JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] } }),
	JSON.stringify({ type: "message_end", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] } }),
].join("\n") + "\n");
fs.writeFileSync(fixture + ".done", "");
const tail = execFileSync("node", [new URL("../scripts/herdr-tail.mjs", import.meta.url).pathname, fixture, "t1 (qa)"], { encoding: "utf-8", timeout: 10000 });
check("tail renders text, tool call, tool error and exits on .done", /hello/.test(tail) && /→ bash/.test(tail) && /✗ bash boom/.test(tail) && /worker finished/.test(tail));

console.log(failures === 0 ? "All herdr checks passed." : `${failures} herdr check(s) FAILED.`);
if (failures) process.exit(1);
