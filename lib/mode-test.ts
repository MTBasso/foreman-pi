/**
 * Tests for lib/mode.ts: the pi.events spike (Phase 7 step 0), the state
 * matrix, and restore() per session_start reason.
 * Run with: npx tsx lib/mode-test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createModeTracker, envOverride, latestModeEntry, MODE_ENTRY_TYPE, MODE_EVENT } from "./mode.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail?: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENV_KEYS = ["FOREMAN_PI_SUBAGENT", "FOREMAN_PI_MODE"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function clearEnv() {
	for (const k of ENV_KEYS) delete process.env[k];
}
clearEnv();

// ---------------------------------------------------------------------------
// Step 0 spike: pi.events delivery semantics, measured on pi's real event bus.
// Findings (recorded as a Ruling in the Phase 7 notes):
//   - emit() is synchronous; handlers START in registration order, before emit returns.
//   - a handler's return value is ignored (no reply channel) and its promise is NOT awaited.
//   - a throwing/rejecting handler is logged and isolated; other handlers still run.
// So state handlers must be synchronous (isActive() is right after an emit),
// and request/reply (the abort ack) must use a callback in the payload plus a
// bounded wait, never an awaited return value.
// ---------------------------------------------------------------------------
{
	const bus = createEventBus();
	const log: string[] = [];
	bus.on("x", () => log.push("a"));
	bus.on("x", async () => {
		log.push("b-start");
		await sleep(10);
		log.push("b-end");
	});
	bus.on("x", () => log.push("c"));
	log.push("before");
	bus.emit("x", {});
	log.push("after");
	check("spike: emit is synchronous, handlers start in registration order", log.join(",") === "before,a,b-start,c,after", log.join(","));
	await sleep(30);
	check("spike: async handler finishes later, emit never awaited it", log.join(",") === "before,a,b-start,c,after,b-end", log.join(","));

	const origError = console.error;
	console.error = () => {};
	let reached = false;
	bus.on("y", () => {
		throw new Error("boom");
	});
	bus.on("y", async () => {
		throw new Error("boom async");
	});
	bus.on("y", () => {
		reached = true;
	});
	let threw = false;
	try {
		bus.emit("y", {});
	} catch {
		threw = true;
	}
	await sleep(5);
	console.error = origError;
	check("spike: throwing handlers are isolated from the emitter and from later handlers", !threw && reached);

	let replied: unknown = "none";
	bus.on("req", (d: any) => d.reply("pong"));
	bus.emit("req", { reply: (v: unknown) => (replied = v) });
	check("spike: callback-in-payload reply works synchronously", replied === "pong");

	let asyncAck = false;
	bus.on("abort", async (d: any) => {
		await sleep(15);
		d.ack();
	});
	const waited = await new Promise<boolean>((resolve) => {
		bus.emit("abort", { ack: () => ((asyncAck = true), resolve(true)) });
		setTimeout(() => resolve(false), 500);
	});
	check("spike: async handlers can still ack later (promise + bounded wait pattern)", waited && asyncAck);

	let order: string[] = [];
	const t1 = createModeTracker({ events: bus as any });
	const t2 = createModeTracker({ events: bus as any });
	t1.onChange((a) => order.push(`t1:${a}`));
	t2.onChange((a) => order.push(`t2:${a}`));
	bus.emit(MODE_EVENT, { active: true });
	check("spike: every tracker is updated synchronously by one emit", t1.isActive() && t2.isActive() && order.join() === "t1:true,t2:true", order.join());
	t1.dispose();
	t2.dispose();
}

// ---------------------------------------------------------------------------
// State matrix
// ---------------------------------------------------------------------------
const entry = (active: boolean) => ({ type: "custom", customType: MODE_ENTRY_TYPE, data: { active } });
const ctxWith = (branch: any[]) => ({ sessionManager: { getBranch: () => branch } });
const fresh = () => createModeTracker({ events: createEventBus() as any });

{
	clearEnv();
	const tr = fresh();
	check("default: inactive, source default", !tr.isActive() && tr.source() === "default");
}
{
	clearEnv();
	const bus = createEventBus();
	const tr = createModeTracker({ events: bus as any });
	process.env.FOREMAN_PI_SUBAGENT = "1";
	bus.emit(MODE_EVENT, { active: true });
	tr.restore(ctxWith([entry(true)]), "resume");
	process.env.FOREMAN_PI_MODE = "orchestrator";
	check("subagent flag wins over event, entry and env=orchestrator", !tr.isActive() && tr.source() === "subagent");
	clearEnv();
	check("without the subagent flag the stored state shows again", tr.isActive());
}
{
	clearEnv();
	process.env.FOREMAN_PI_MODE = "orchestrator";
	const tr = fresh();
	check("FOREMAN_PI_MODE=orchestrator: active with no entry", tr.isActive() && tr.source() === "env");
	process.env.FOREMAN_PI_MODE = "off";
	tr.restore(ctxWith([entry(true)]), "resume");
	check("FOREMAN_PI_MODE=off beats an active entry", !tr.isActive() && tr.source() === "env");
	process.env.FOREMAN_PI_MODE = "ORCHESTRATOR ";
	check("env value is trimmed and case-insensitive", envOverride() === true);
	process.env.FOREMAN_PI_MODE = "banana";
	check("unknown env value is ignored", envOverride() === undefined && !tr.isActive() === false);
	clearEnv();
}
{
	clearEnv();
	// A stray marker file from an older version has no effect (nothing reads it).
	const dir = mkdtempSync(join(tmpdir(), "foreman-mode-"));
	writeFileSync(join(dir, [".orchestrator", "active"].join("-")), "");
	const tr = fresh();
	tr.restore({ ...ctxWith([]), cwd: dir } as any, "startup");
	check("a stray leftover marker file has no effect", !tr.isActive() && tr.source() === "default");
	rmSync(dir, { recursive: true, force: true });
}
{
	clearEnv();
	for (const reason of ["startup", "reload", "resume", "fork"] as const) {
		const tr = fresh();
		check(`restore(${reason}): active entry -> active (source entry)`, tr.restore(ctxWith([entry(true)]), reason) === true && tr.source() === "entry");
	}
	const tr = fresh();
	check("restore(new): ignores entries, inactive", tr.restore(ctxWith([entry(true)]), "new") === false && tr.source() === "default");
	check("restore(startup) with no entry: inactive, never locked", fresh().restore(ctxWith([]), "startup") === false);
	check("restore(reload) with no entry: inactive", fresh().restore(ctxWith([]), "reload") === false);
	const tr2 = fresh();
	check("latest entry wins (active then off)", tr2.restore(ctxWith([entry(true), { type: "message" }, entry(false)]), "resume") === false);
	check("latest entry wins (off then active)", fresh().restore(ctxWith([entry(false), entry(true)]), "resume") === true);
	check("malformed entries ignored", latestModeEntry([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { active: "yes" } }, { type: "custom", customType: "other", data: { active: true } }]) === undefined);
	const tr3 = createModeTracker({ events: createEventBus() as any });
	check("getBranch throwing -> inactive, no crash", tr3.restore({ sessionManager: { getBranch: () => { throw new Error("stale"); } } }, "resume") === false);
	check("missing sessionManager -> inactive", tr3.restore({}, "resume") === false);
}
{
	clearEnv();
	const bus = createEventBus();
	const tr = createModeTracker({ events: bus as any });
	const flips: boolean[] = [];
	tr.onChange((a) => flips.push(a));
	bus.emit(MODE_EVENT, { active: true });
	bus.emit(MODE_EVENT, { active: true });
	bus.emit(MODE_EVENT, { active: false });
	bus.emit(MODE_EVENT, { active: "nope" });
	bus.emit(MODE_EVENT, undefined);
	check("event drives state; onChange fires only on flips; bad payloads ignored", flips.join() === "true,false" && !tr.isActive() && tr.source() === "event", flips.join());
	tr.set(true);
	check("set() updates locally and notifies", tr.isActive() && flips.join() === "true,false,true");
	{
		process.env.FOREMAN_PI_MODE = "orchestrator";
		const b2 = createEventBus();
		const forced = createModeTracker({ events: b2 as any });
		const f: boolean[] = [];
		forced.onChange((x) => f.push(x));
		b2.emit(MODE_EVENT, { active: false });
		check("env masks the change: no onChange while forced, still active", f.length === 0 && forced.isActive());
	}
	clearEnv();
	tr.onChange(() => {
		throw new Error("listener bug");
	});
	let fine = true;
	try {
		bus.emit(MODE_EVENT, { active: false });
	} catch {
		fine = false;
	}
	check("a failing onChange listener does not break the emitter", fine);
	// restore across sessions: an event-set state is replaced by the new session's entries
	tr.set(true);
	tr.restore(ctxWith([]), "resume");
	check("restore replaces event state with the new session's state", !tr.isActive());
}

for (const k of ENV_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
