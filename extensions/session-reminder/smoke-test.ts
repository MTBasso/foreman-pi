/** Smoke test for the session-reminder foreman_delegate warning. Run: npx tsx extensions/session-reminder/smoke-test.ts */
import extension, { missingDelegateWarning } from "./index.ts";

let failures = 0;
const check = (l: string, c: boolean) => { console.log(`${c ? "ok " : "FAIL"} - ${l}`); if (!c) failures++; };

check("no warning when foreman_delegate present", missingDelegateWarning(() => [{ name: "read" }, { name: "foreman_delegate" }]) === "");
const w = missingDelegateWarning(() => [{ name: "read" }]);
check("one-line warning when absent", /foreman_delegate/.test(w) && !w.includes("\n"));
check("silent if getAllTools throws", missingDelegateWarning(() => { throw new Error("x"); }) === "");

const handlers: Record<string, any> = {};
const api: any = { on: (e: string, h: any) => (handlers[e] = h), getAllTools: () => [{ name: "read" }] };
await extension(api);
await handlers.session_start({ reason: "resume" }, { cwd: "/tmp" });
const r = await handlers.before_agent_start({ messageType: "user" }, { cwd: "/tmp" });
check("reminder message carries the warning", /foreman_delegate tool is not loaded/.test(r?.message?.content ?? ""));

if (failures) process.exit(1);
console.log("\nall checks passed");
