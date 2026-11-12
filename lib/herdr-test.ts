import { createHerdr, herdrActive, paneTitle } from "./herdr.ts";
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
console.log(failures === 0 ? "All herdr checks passed." : `${failures} herdr check(s) FAILED.`);
if (failures) process.exit(1);
