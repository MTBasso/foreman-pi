/**
 * Smoke test for the session-reminder extension. Run: npx tsx extensions/session-reminder/smoke-test.ts
 * Covers the foreman_delegate warning, the orchestrator-mode orientation line,
 * the absence of any marker logic, and the resume/fork "keep orchestrator mode?" confirm.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { t } from "../../lib/i18n.ts";
import { MODE_ENTRY_TYPE, MODE_EVENT, MODE_SET_EVENT } from "../../lib/mode.ts";
import foremanMode from "../foreman-mode/index.ts";
import extension, { missingDelegateWarning } from "./index.ts";

let failures = 0;
const check = (l: string, c: boolean, detail?: string) => {
	console.log(`${c ? "ok " : "FAIL"} - ${l}${!c && detail ? ` (${detail})` : ""}`);
	if (!c) failures++;
};

const ENV_KEYS = ["FOREMAN_PI_SUBAGENT", "FOREMAN_PI_MODE", "FOREMAN_LANG", "LANG", "FOREMAN_KEEP_MODE_TIMEOUT_MS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const resetEnv = () => {
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.LANG = "en_US.UTF-8";
};
resetEnv();

check("no warning when foreman_delegate present", missingDelegateWarning(() => [{ name: "read" }, { name: "foreman_delegate" }]) === "");
const w = missingDelegateWarning(() => [{ name: "read" }]);
check("one-line warning when absent", /foreman_delegate/.test(w) && !w.includes("\n"));
check("silent if getAllTools throws", missingDelegateWarning(() => { throw new Error("x"); }) === "");

const activeEntry = (active: boolean) => ({ type: "custom", customType: MODE_ENTRY_TYPE, data: { active } });

function setup(tools = [{ name: "read" }]) {
	const events = createEventBus();
	const handlers: Record<string, any> = {};
	const api: any = { events, on: (e: string, h: any) => (handlers[e] = h), getAllTools: () => tools, registerCommand: () => {}, appendEntry: () => {} };
	return { api, handlers, events };
}
function ctxFor(opts: { cwd?: string; branch?: any[]; hasUI?: boolean; confirm?: (title: string, message: string, o?: any) => Promise<boolean> }) {
	const confirms: Array<{ title: string; message: string; opts?: any }> = [];
	return {
		confirms,
		ctx: {
			cwd: opts.cwd ?? "/tmp",
			hasUI: opts.hasUI ?? false,
			sessionManager: { getBranch: () => opts.branch ?? [] },
			ui: {
				confirm: async (title: string, message: string, o?: any) => {
					confirms.push({ title, message, opts: o });
					return opts.confirm ? opts.confirm(title, message, o) : true;
				},
				notify: () => {},
				setStatus: () => {},
			},
		} as any,
	};
}
const remind = async (h: Record<string, any>, ctx: any) => (await h.before_agent_start({ messageType: "user" }, ctx))?.message?.content as string | undefined;

async function main() {
	// Workers get no reminder at all: nothing registered, so no text and no foreman_delegate warning.
	{
		process.env.FOREMAN_PI_SUBAGENT = "1";
		const s = setup();
		await extension(s.api);
		check("subagent worker: extension registers no handlers", Object.keys(s.handlers).length === 0, Object.keys(s.handlers).join());
		resetEnv();
		const s2 = setup();
		await extension(s2.api);
		check("non-worker session still registers the reminder handlers", typeof s2.handlers.session_start === "function" && typeof s2.handlers.before_agent_start === "function");
		process.env.FOREMAN_PI_SUBAGENT = "0";
		const s3 = setup();
		await extension(s3.api);
		check("FOREMAN_PI_SUBAGENT=0 is not a worker", typeof s3.handlers.before_agent_start === "function");
		resetEnv();
	}

	// Basic: warning and base text.
	{
		const s = setup();
		await extension(s.api);
		await s.handlers.session_start({ reason: "resume" }, ctxFor({}).ctx);
		const text = (await remind(s.handlers, {})) ?? "";
		check("reminder message carries the warning", /foreman_delegate tool is not loaded/.test(text));
		check("reminder is one-shot", (await remind(s.handlers, {})) === undefined);
		check("reminder references /foreman, /foreman off, /plan-runner, /foreman-diagnose", ["/foreman ", "/foreman off", "/plan-runner", "/foreman-diagnose"].every((c) => text.includes(c)));
		check("reminder carries the language rule", /Converse with the user in the language of their messages \(default English\)/.test(text));
		check("non-user messageType gets nothing", (await s.handlers.before_agent_start({ messageType: "custom" }, {})) === undefined);
	}

	// No marker logic at all: a stray leftover file changes nothing and is never mentioned.
	{
		const dir = mkdtempSync(join(tmpdir(), "foreman-rem-"));
		writeFileSync(join(dir, [".orchestrator", "active"].join("-")), "");
		const s = setup([{ name: "foreman_delegate" }]);
		await extension(s.api);
		await s.handlers.session_start({ reason: "startup" }, ctxFor({ cwd: dir }).ctx);
		const text = (await remind(s.handlers, {})) ?? "";
		const sansListing = text.split("\n").filter((l) => !l.startsWith("top-level entries:")).join("\n");
		check("startup with a stray leftover marker: no stale-marker note, no marker line", !/marker|leftover|stale/i.test(sansListing) && !/orchestrator-active/.test(sansListing));
		check("startup: orientation still present", /PRE-GATHERED ORIENTATION/.test(text) && /FOREMAN_MEMORY\.md: does not exist yet/.test(text) && /top-level entries:/.test(text));
		check("startup, mode default: line says inactive (default) and points at /foreman", /Orchestrator mode: inactive \(default\); foreman_delegate refuses until the user runs \/foreman/.test(text));
		rmSync(dir, { recursive: true, force: true });
	}

	// The mode line follows the live state, evaluated at before_agent_start (load order independent).
	{
		const s = setup([{ name: "foreman_delegate" }]);
		await extension(s.api);
		await s.handlers.session_start({ reason: "reload" }, ctxFor({ branch: [activeEntry(true)] }).ctx);
		s.events.emit(MODE_EVENT, { active: false }); // changed after session_start, before the first turn
		check("line reflects state at first turn (event beats earlier entry)", /Orchestrator mode: inactive \(event\)/.test((await remind(s.handlers, {})) ?? ""));
		const s2 = setup([{ name: "foreman_delegate" }]);
		await extension(s2.api);
		await s2.handlers.session_start({ reason: "reload" }, ctxFor({ branch: [activeEntry(true)] }).ctx);
		const t2 = (await remind(s2.handlers, {})) ?? "";
		check("line: active (entry) with no refusal hint", /Orchestrator mode: active \(entry\)$/m.test(t2));
		process.env.FOREMAN_PI_MODE = "orchestrator";
		const s3 = setup([{ name: "foreman_delegate" }]);
		await extension(s3.api);
		await s3.handlers.session_start({ reason: "startup" }, ctxFor({}).ctx);
		check("line: active (env)", /Orchestrator mode: active \(env\)/.test((await remind(s3.handlers, {})) ?? ""));
		process.env.FOREMAN_PI_SUBAGENT = "1";
		const s4 = setup([{ name: "foreman_delegate" }]);
		await extension(s4.api);
		check("worker process (even with env=orchestrator) gets no reminder and no mode line", s4.handlers.session_start === undefined && s4.handlers.before_agent_start === undefined);
		resetEnv();
	}

	// Resume/fork confirm.
	{
		const branch = [activeEntry(true)];
		for (const reason of ["resume", "fork"] as const) {
			const s = setup([{ name: "foreman_delegate" }]);
			const asked: unknown[] = [];
			s.events.on(MODE_SET_EVENT, (d) => asked.push(d));
			await extension(s.api);
			const c = ctxFor({ branch, hasUI: true, confirm: async () => true });
			await s.handlers.session_start({ reason }, c.ctx);
			check(`${reason}: active entry + UI asks once with the localized labels`, c.confirms.length === 1 && c.confirms[0].title === t("confirm.keepMode.title") && c.confirms[0].message === t("confirm.keepMode"));
			check(`${reason}: answering yes keeps the mode, no change requested`, asked.length === 0 && /Orchestrator mode: active/.test((await remind(s.handlers, {})) ?? ""));
		}
		// No -> the single writer (foreman-mode) turns it off and records an off entry.
		{
			const bus = createEventBus();
			const entries: any[] = [];
			const handlers: Record<string, any> = {};
			const modeHandlers: Record<string, any> = {};
			const api: any = { events: bus, on: (e: string, h: any) => (handlers[e] = h), getAllTools: () => [{ name: "foreman_delegate" }], registerCommand: () => {}, appendEntry: (type: string, data: any) => entries.push({ type, data }) };
			const modeApi: any = { events: bus, on: (e: string, h: any) => (modeHandlers[e] = h), registerCommand: () => {}, appendEntry: api.appendEntry, sendUserMessage: () => {} };
			await foremanMode(modeApi);
			await extension(api);
			const c = ctxFor({ branch, hasUI: true, confirm: async () => false });
			await modeHandlers.session_start({ reason: "resume" }, c.ctx);
			await handlers.session_start({ reason: "resume" }, c.ctx);
			check("resume + answer no: off entry appended by foreman-mode", entries.at(-1)?.type === MODE_ENTRY_TYPE && entries.at(-1)?.data.active === false);
			check("resume + answer no: reminder says inactive", /Orchestrator mode: inactive/.test((await remind(handlers, {})) ?? ""));
		}
		// Timeout (via the abort signal) keeps the state.
		{
			process.env.FOREMAN_KEEP_MODE_TIMEOUT_MS = "30";
			const s = setup([{ name: "foreman_delegate" }]);
			const asked: unknown[] = [];
			s.events.on(MODE_SET_EVENT, (d) => asked.push(d));
			await extension(s.api);
			const c = ctxFor({
				branch,
				hasUI: true,
				confirm: (_t, _m, o) => new Promise<boolean>((resolve) => o?.signal?.addEventListener("abort", () => resolve(false))),
			});
			await s.handlers.session_start({ reason: "resume" }, c.ctx);
			check("timeout: keeps the restored state (no off request)", asked.length === 0 && c.confirms[0].opts?.signal !== undefined && /Orchestrator mode: active/.test((await remind(s.handlers, {})) ?? ""));
			resetEnv();
		}
		// A throwing prompt keeps the state too.
		{
			const s = setup([{ name: "foreman_delegate" }]);
			const asked: unknown[] = [];
			s.events.on(MODE_SET_EVENT, (d) => asked.push(d));
			await extension(s.api);
			const c = ctxFor({ branch, hasUI: true, confirm: async () => { throw new Error("ui gone"); } });
			await s.handlers.session_start({ reason: "fork" }, c.ctx);
			check("confirm throws: keeps the restored state", asked.length === 0);
		}
		// No UI keeps the state, no prompt.
		{
			const s = setup([{ name: "foreman_delegate" }]);
			await extension(s.api);
			const c = ctxFor({ branch, hasUI: false });
			await s.handlers.session_start({ reason: "resume" }, c.ctx);
			check("no UI: no prompt, restored state kept and reported", c.confirms.length === 0 && /Orchestrator mode: active \(entry\)/.test((await remind(s.handlers, {})) ?? ""));
		}
		// reload, startup, new: never ask. Inactive entries: never ask.
		for (const reason of ["reload", "startup", "new"] as const) {
			const s = setup([{ name: "foreman_delegate" }]);
			await extension(s.api);
			const c = ctxFor({ branch, hasUI: true });
			await s.handlers.session_start({ reason }, c.ctx);
			check(`${reason}: restores silently, no prompt`, c.confirms.length === 0);
		}
		{
			const s = setup([{ name: "foreman_delegate" }]);
			await extension(s.api);
			const c = ctxFor({ branch: [activeEntry(false)], hasUI: true });
			await s.handlers.session_start({ reason: "resume" }, c.ctx);
			check("resume with an inactive entry: no prompt", c.confirms.length === 0);
		}
		// env-forced mode: nothing to confirm.
		{
			process.env.FOREMAN_PI_MODE = "orchestrator";
			const s = setup([{ name: "foreman_delegate" }]);
			await extension(s.api);
			const c = ctxFor({ branch, hasUI: true });
			await s.handlers.session_start({ reason: "resume" }, c.ctx);
			check("env-forced mode: no prompt", c.confirms.length === 0);
			resetEnv();
		}
		// Bilingual labels.
		{
			const labels = async (lang: string) => {
				process.env.FOREMAN_LANG = lang;
				const s = setup([{ name: "foreman_delegate" }]);
				await extension(s.api);
				const c = ctxFor({ branch, hasUI: true });
				await s.handlers.session_start({ reason: "resume" }, c.ctx);
				const text = (await remind(s.handlers, {})) ?? "";
				resetEnv();
				return { ...c.confirms[0], text };
			};
			const en = await labels("en");
			const pt = await labels("pt-BR");
			check("bilingual: confirm title/message differ and pt-BR is Portuguese", en.title !== pt.title && en.message !== pt.message && /Manter o modo orquestrador/.test(pt.title) && !/[{}]/.test(en.message + pt.message));
			check("bilingual: the model-facing reminder stays English in both", en.text.startsWith("This project has the foreman plugin") && pt.text.startsWith("This project has the foreman plugin") && !/orquestrador|modo/i.test(pt.text));
		}
	}

	for (const k of ENV_KEYS) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; else delete process.env[k];
	if (failures) process.exit(1);
	console.log("\nall checks passed");
}

main();
