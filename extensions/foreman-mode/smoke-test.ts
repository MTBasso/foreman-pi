/**
 * Smoke test for extensions/foreman-mode (commands, state writer, /foreman off).
 * Run with: npx tsx extensions/foreman-mode/smoke-test.ts
 *
 * Fakes ExtensionAPI with a real `pi.events` bus; command handlers are called
 * directly, with `hasUI` both true and false.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../../lib/agents.ts";
import { t } from "../../lib/i18n.ts";
import { MODE_ENTRY_TYPE, MODE_EVENT, MODE_SET_EVENT } from "../../lib/mode.ts";
import { WORKERS_ABORT_EVENT, WORKERS_EVENT, type WorkersSnapshot } from "../../lib/workers.ts";
import extension from "./index.ts";
import { expandHome, readReference, readSkillBody, resolvePlanPath, stripFrontmatter } from "./prompts.ts";

let failures = 0;
const check = (label: string, cond: boolean, detail?: string) => {
	console.log(`${cond ? "ok " : "FAIL"} - ${label}${!cond && detail ? ` (${detail})` : ""}`);
	if (!cond) failures++;
};

const ENV_KEYS = ["FOREMAN_PI_SUBAGENT", "FOREMAN_PI_MODE", "FOREMAN_LANG", "LANG", "LC_ALL", "LC_MESSAGES", "FOREMAN_ABORT_WAIT_MS", "HOME"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function resetEnv() {
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.LANG = "en_US.UTF-8";
	if (savedEnv.HOME !== undefined) process.env.HOME = savedEnv.HOME;
}
resetEnv();

function stderrCapture() {
	const orig = process.stderr.write.bind(process.stderr);
	const lines: string[] = [];
	(process.stderr as any).write = (chunk: any) => {
		lines.push(String(chunk));
		return true;
	};
	return { lines, restore: () => ((process.stderr as any).write = orig) };
}

function makeApi() {
	const events = createEventBus();
	const commands: Record<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }> = {};
	const handlers: Record<string, Array<(e: any, c: any) => any>> = {};
	const sent: Array<{ content: string; options?: any }> = [];
	const entries: Array<{ type: string; data: any }> = [];
	const modeEvents: boolean[] = [];
	events.on(MODE_EVENT, (d: any) => modeEvents.push(d.active));
	const api: any = {
		events,
		registerCommand: (name: string, o: any) => (commands[name] = o),
		on: (e: string, h: any) => ((handlers[e] ??= []).push(h), () => {}),
		sendUserMessage: (content: string, options?: any) => sent.push({ content, options }),
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
	};
	return { api, events, commands, handlers, sent, entries, modeEvents };
}

interface UiLog {
	notify: Array<{ msg: string; level?: string }>;
	status: Array<string | undefined>;
	confirms: Array<{ title: string; message: string; opts?: any }>;
}
function makeCtx(opts: { hasUI: boolean; confirm?: boolean; idle?: boolean; cwd?: string }) {
	const log: UiLog = { notify: [], status: [], confirms: [] };
	const ctx: any = {
		hasUI: opts.hasUI,
		cwd: opts.cwd ?? process.cwd(),
		isIdle: () => opts.idle !== false,
		ui: {
			notify: (msg: string, level?: string) => log.notify.push({ msg, level }),
			setStatus: (_k: string, text?: string) => log.status.push(text),
			confirm: async (title: string, message: string, o?: any) => {
				log.confirms.push({ title, message, opts: o });
				return opts.confirm ?? true;
			},
		},
	};
	return { ctx, log };
}

const snap = (running: number, queued = 0): WorkersSnapshot => ({
	running: Array.from({ length: running }, (_, i) => ({ taskId: `t${i + 1}-qa`, role: "qa", startedAt: Date.now() })),
	queued,
	finished: [],
});

async function main() {
	// --- prompts.ts -----------------------------------------------------------
	check("stripFrontmatter removes the YAML block", stripFrontmatter("---\nname: x\n---\n\n# Body\n") === "# Body");
	check("stripFrontmatter leaves plain text alone", stripFrontmatter("# Body") === "# Body");
	check("expandHome expands ~/", expandHome("~/a/b", "/h") === "/h/a/b" && expandHome("~", "/h") === "/h" && expandHome("/x/~y", "/h") === "/x/~y" && expandHome("rel", "/h") === "rel");
	const foremanBody = readSkillBody("foreman");
	check("skill body has no frontmatter and has the skill text", !foremanBody.startsWith("---") && /# Foreman/.test(foremanBody) && /foreman_delegate/.test(foremanBody));
	check("diagnose reference readable", /Problem intake/.test(readReference("diagnosing-a-run")));

	// --- child processes: no-op -----------------------------------------------
	{
		process.env.FOREMAN_PI_SUBAGENT = "1";
		const c = makeApi();
		await extension(c.api);
		check("FOREMAN_PI_SUBAGENT=1: no commands, no handlers", Object.keys(c.commands).length === 0 && Object.keys(c.handlers).length === 0);
		resetEnv();
	}

	// --- registration ---------------------------------------------------------
	{
		const a = makeApi();
		await extension(a.api);
		check("registers foreman, foreman-audit, foreman-diagnose, plan-runner", ["foreman", "foreman-audit", "foreman-diagnose", "plan-runner"].every((n) => a.commands[n]));
		check("every command has a description", Object.values(a.commands).every((c) => !!c.description && !/[{}]/.test(c.description)));
	}

	// --- /foreman -------------------------------------------------------------
	{
		const a = makeApi();
		await extension(a.api);
		const { ctx, log } = makeCtx({ hasUI: false });
		const err = stderrCapture();
		await a.commands.foreman.handler("build a login page, por favor", ctx);
		err.restore();
		check("/foreman with hasUI false: mode on, entry appended, event broadcast", a.entries.at(-1)?.type === MODE_ENTRY_TYPE && a.entries.at(-1)?.data.active === true && a.modeEvents.join() === "true");
		check("/foreman sends one user message on pi (idle: no deliverAs)", a.sent.length === 1 && a.sent[0].options === undefined);
		const msg = a.sent[0].content;
		check("prompt embeds the skill body and the absolute package root", msg.includes(foremanBody.slice(0, 80)) && msg.includes(`Package root: ${PACKAGE_ROOT}`) && PACKAGE_ROOT.startsWith("/"));
		check("prompt has no frontmatter and does not start with a /skill: expansion", !/^name: foreman$/m.test(msg) && !/^description: Turns the current session/m.test(msg) && !msg.trimStart().startsWith("/skill:"));
		check("user request passed verbatim in the user's language", msg.endsWith("build a login page, por favor"));
		check("no UI: confirmation goes to stderr, not a crash", err.lines.join("").includes(t("cmd.entered")) && log.notify.length === 0);

		// busy -> followUp
		const b = makeCtx({ hasUI: true, idle: false });
		await a.commands.foreman.handler("again", b.ctx);
		check("busy session: followUp delivery", a.sent[1].options?.deliverAs === "followUp");
		check("already on: no second entry or event", a.entries.length === 1 && a.modeEvents.length === 1);

		// empty request
		const a2 = makeApi();
		await extension(a2.api);
		await a2.commands.foreman.handler("", makeCtx({ hasUI: true }).ctx);
		check("/foreman with no request asks what to work on", /not stated a request yet/.test(a2.sent[0].content));

		// status line
		const a3 = makeApi();
		await extension(a3.api);
		const c3 = makeCtx({ hasUI: true });
		await a3.commands.foreman.handler("x", c3.ctx);
		check("status line set on enter (UI) with the mode label", c3.log.status.at(-1) === t("status.modeOn") && c3.log.notify.some((n) => n.msg === t("cmd.entered")));

		// env=off forbids entering
		process.env.FOREMAN_PI_MODE = "off";
		const a4 = makeApi();
		await extension(a4.api);
		const c4 = makeCtx({ hasUI: true });
		await a4.commands.foreman.handler("x", c4.ctx);
		check("FOREMAN_PI_MODE=off: /foreman refuses, sends nothing", a4.sent.length === 0 && a4.entries.length === 0 && c4.log.notify[0]?.level === "warning");
		resetEnv();
	}

	// --- /foreman off ---------------------------------------------------------
	{
		// zero workers
		const a = makeApi();
		await extension(a.api);
		const c = makeCtx({ hasUI: true });
		await a.commands.foreman.handler("go", c.ctx);
		await a.commands.foreman.handler("off", c.ctx);
		check("off, zero workers: no confirm, mode off, entry + event + status cleared", c.log.confirms.length === 0 && a.entries.at(-1)?.data.active === false && a.modeEvents.join() === "true,false" && c.log.status.at(-1) === undefined && c.log.notify.at(-1)?.msg === t("cmd.off.done"));
		await a.commands.foreman.handler("OFF", c.ctx);
		check("off when already off: says so, writes nothing", c.log.notify.at(-1)?.msg === t("cmd.off.already") && a.entries.length === 2);

		// running workers, confirm yes
		const y = makeApi();
		await extension(y.api);
		let aborted = 0;
		y.events.on(WORKERS_ABORT_EVENT, (d: any) => {
			aborted++;
			setTimeout(() => d.ack(), 10);
		});
		const cy = makeCtx({ hasUI: true, confirm: true });
		await y.commands.foreman.handler("go", cy.ctx);
		y.events.emit(WORKERS_EVENT, snap(2, 1));
		await y.commands["foreman"].handler("off", cy.ctx);
		check("running + confirm yes: confirm shown with the count and NO timeout", cy.log.confirms.length === 1 && cy.log.confirms[0].message.includes("3") && cy.log.confirms[0].opts === undefined);
		check("running + confirm yes: abort emitted, waited for ack, mode off", aborted === 1 && y.modeEvents.at(-1) === false && y.entries.at(-1)?.data.active === false);

		// running workers, confirm no
		const n = makeApi();
		await extension(n.api);
		let abortedN = 0;
		n.events.on(WORKERS_ABORT_EVENT, () => abortedN++);
		const cn = makeCtx({ hasUI: true, confirm: false });
		await n.commands.foreman.handler("go", cn.ctx);
		n.events.emit(WORKERS_EVENT, snap(1));
		await n.commands.foreman.handler("off", cn.ctx);
		check("running + confirm no: workers untouched, mode stays on, says so", abortedN === 0 && n.modeEvents.at(-1) === true && n.entries.at(-1)?.data.active === true && cn.log.notify.at(-1)?.msg === t("cmd.off.staying"));

		// running workers, no UI
		const u = makeApi();
		await extension(u.api);
		let abortedU = 0;
		u.events.on(WORKERS_ABORT_EVENT, () => abortedU++);
		const cu = makeCtx({ hasUI: false });
		const e1 = stderrCapture();
		await u.commands.foreman.handler("go", cu.ctx);
		u.events.emit(WORKERS_EVENT, snap(2));
		await u.commands.foreman.handler("off", cu.ctx);
		e1.restore();
		const refusal = e1.lines.find((l) => l.includes(t("cmd.off.refuseNoUi", { count: 2 })));
		check("running + no UI: refused with a reason on stderr, nothing aborted, mode stays", !!refusal && abortedU === 0 && u.modeEvents.at(-1) === true && cu.log.confirms.length === 0);

		// finished workers later: cache updated, off works without confirm
		u.events.emit(WORKERS_EVENT, snap(0));
		const e2 = stderrCapture();
		await u.commands.foreman.handler("off", cu.ctx);
		e2.restore();
		check("after workers finish, /foreman off succeeds with no UI", u.modeEvents.at(-1) === false);

		// ack never arrives: bounded wait, then off
		process.env.FOREMAN_ABORT_WAIT_MS = "40";
		const w = makeApi();
		await extension(w.api);
		const cw = makeCtx({ hasUI: true, confirm: true });
		await w.commands.foreman.handler("go", cw.ctx);
		w.events.emit(WORKERS_EVENT, snap(1));
		const t0 = Date.now();
		await w.commands.foreman.handler("off", cw.ctx);
		check("no ack from coordination: waits a bounded time, then leaves the mode", Date.now() - t0 >= 35 && Date.now() - t0 < 2000 && w.modeEvents.at(-1) === false);
		resetEnv();

		// env-forced
		process.env.FOREMAN_PI_MODE = "orchestrator";
		const f = makeApi();
		await extension(f.api);
		const cf = makeCtx({ hasUI: true });
		await f.commands.foreman.handler("off", cf.ctx);
		check("FOREMAN_PI_MODE=orchestrator: /foreman off says to unset the variable, stays on", cf.log.notify.at(-1)?.msg === t("cmd.off.envForced") && f.entries.length === 0);
		resetEnv();
	}

	// --- MODE_SET_EVENT (used by session-reminder's resume/fork confirm) --------
	{
		const a = makeApi();
		await extension(a.api);
		const c = makeCtx({ hasUI: true });
		await a.handlers.session_start[0]({ reason: "resume" }, { ...c.ctx, sessionManager: { getBranch: () => [{ type: "custom", customType: MODE_ENTRY_TYPE, data: { active: true } }] } });
		check("session_start(resume) restores the active state and shows the status line", c.log.status.at(-1) === t("status.modeOn"));
		a.events.emit(MODE_SET_EVENT, { active: false });
		check("mode:set off: entry appended, event broadcast, status cleared", a.entries.at(-1)?.data.active === false && a.modeEvents.at(-1) === false && c.log.status.at(-1) === undefined);
		a.events.emit(MODE_SET_EVENT, { active: "x" });
		check("mode:set ignores bad payloads", a.entries.length === 1);
		const b = makeApi();
		await extension(b.api);
		const cb = makeCtx({ hasUI: true });
		await b.handlers.session_start[0]({ reason: "startup" }, { ...cb.ctx, sessionManager: { getBranch: () => [] } });
		check("fresh startup: no status line text", cb.log.status.at(-1) === undefined);
	}

	// --- /foreman-audit, /foreman-diagnose -------------------------------------
	{
		const a = makeApi();
		await extension(a.api);
		const eAudit = stderrCapture();
		await a.commands["foreman-audit"].handler("the payments module", makeCtx({ hasUI: false }).ctx);
		eAudit.restore();
		check("/foreman-audit enables the mode and embeds the skill with the §1.5 instruction", a.modeEvents.join() === "true" && a.sent[0].content.includes("§1.5") && a.sent[0].content.includes(foremanBody.slice(0, 80)) && a.sent[0].content.endsWith("the payments module"));

		const d = makeApi();
		await extension(d.api);
		const cd = makeCtx({ hasUI: false });
		await d.commands["foreman-diagnose"].handler("it re-ran step 3", cd.ctx);
		check("/foreman-diagnose does NOT enable the mode", d.modeEvents.length === 0 && d.entries.length === 0);
		check("/foreman-diagnose embeds diagnosing-a-run and the user's words", d.sent[0].content.includes(readReference("diagnosing-a-run").slice(0, 80)) && d.sent[0].content.endsWith("it re-ran step 3") && d.sent[0].content.includes(`Package root: ${PACKAGE_ROOT}`));
	}

	// --- /plan-runner ------------------------------------------------------------
	{
		const home = mkdtempSync(join(tmpdir(), "foreman-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "foreman-cwd-"));
		mkdirSync(join(home, "plans"), { recursive: true });
		writeFileSync(join(home, "plans", "p.md"), "# plan\n");
		mkdirSync(join(cwd, "docs", "plans"), { recursive: true });
		writeFileSync(join(cwd, "docs", "plans", "my-slug.md"), "# plan\n");
		process.env.HOME = home;
		const a = makeApi();
		await extension(a.api);
		const c = makeCtx({ hasUI: false, cwd });
		const ePlan = stderrCapture();
		await a.commands["plan-runner"].handler("~/plans/p.md", c.ctx);
		ePlan.restore();
		check("/plan-runner expands a leading ~/", a.sent[0].content.includes(`Plan to run: ${join(homedir(), "plans", "p.md")}`) && !a.sent[0].content.includes("Plan to run: ~"));
		check("/plan-runner enables the mode and embeds the plan-runner skill + package root", a.modeEvents.join() === "true" && a.sent[0].content.includes(readSkillBody("plan-runner").slice(0, 80)) && a.sent[0].content.includes(`Package root: ${PACKAGE_ROOT}`));
		await a.commands["plan-runner"].handler("my-slug", c.ctx);
		check("/plan-runner resolves a slug under docs/plans/", a.sent[1].content.includes(`Plan to run: ${join(cwd, "docs", "plans", "my-slug.md")}`));
		await a.commands["plan-runner"].handler("docs/plans/my-slug.md", c.ctx);
		check("/plan-runner resolves a cwd-relative path to absolute", a.sent[2].content.includes(`Plan to run: ${join(cwd, "docs", "plans", "my-slug.md")}`));
		const err = stderrCapture();
		await a.commands["plan-runner"].handler("", c.ctx);
		await a.commands["plan-runner"].handler("nope/missing.md", c.ctx);
		err.restore();
		check("/plan-runner with no argument: usage, nothing sent", err.lines.join("").includes(t("cmd.plan.usage")) && a.sent.length === 4);
		check("/plan-runner with a missing file: warns and still sends with a verify note", err.lines.join("").includes("missing.md") && /did not exist/.test(a.sent[3].content));
		check("resolvePlanPath: missing -> exists false, absolute", (() => { const r = resolvePlanPath("zzz", cwd); return !r.exists && r.path === join(cwd, "zzz"); })());
		const busy = makeCtx({ hasUI: true, cwd, idle: false });
		await a.commands["plan-runner"].handler("my-slug", busy.ctx);
		check("/plan-runner when busy: followUp", a.sent.at(-1)?.options?.deliverAs === "followUp");
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		resetEnv();
	}

	// --- bilingual -----------------------------------------------------------------
	{
		const run = async (lang: string) => {
			process.env.FOREMAN_LANG = lang;
			const a = makeApi();
			await extension(a.api);
			const c = makeCtx({ hasUI: true, confirm: false });
			await a.commands.foreman.handler("x", c.ctx);
			a.events.emit(WORKERS_EVENT, snap(2));
			await a.commands.foreman.handler("off", c.ctx); // confirm "no"
			const noUi = makeCtx({ hasUI: false });
			const e = stderrCapture();
			await a.commands.foreman.handler("off", noUi.ctx);
			e.restore();
			const descs = Object.values(a.commands).map((x) => x.description ?? "");
			return {
				descs,
				notify: c.log.notify.map((n) => n.msg),
				confirm: c.log.confirms[0],
				status: c.log.status.filter(Boolean) as string[],
				refuse: e.lines.join(""),
				prompt: a.sent[0].content,
			};
		};
		const en = await run("en");
		const pt = await run("pt-BR");
		resetEnv();
		check("bilingual: command descriptions differ per locale", en.descs.every((d, i) => d !== pt.descs[i]));
		check("bilingual: notifications differ per locale", en.notify.length > 0 && en.notify.length === pt.notify.length && en.notify.every((m, i) => m !== pt.notify[i]));
		check("bilingual: confirm title and message differ per locale", en.confirm.title !== pt.confirm.title && en.confirm.message !== pt.confirm.message);
		check("bilingual: pt-BR strings are Portuguese", /orquestrador/.test(pt.notify[0]) && /Sair do modo/.test(pt.confirm.title) && /workers/.test(pt.confirm.message) && /ainda estão em execução/.test(pt.confirm.message));
		check("bilingual: status line differs", en.status[0] !== pt.status[0] && /modo orquestrador/.test(pt.status[0]));
		check("bilingual: no-UI refusal differs and mentions the count", en.refuse !== pt.refuse && en.refuse.includes("2") && pt.refuse.includes("2") && /Permanecendo/.test(pt.refuse));
		const all = [...en.descs, ...pt.descs, ...en.notify, ...pt.notify, en.confirm.message, pt.confirm.message, en.refuse, pt.refuse, ...en.status, ...pt.status];
		check("bilingual: no raw {placeholders} leak", all.every((s) => !/\{\w+\}/.test(s)));
		check("bilingual: machine-facing prompt is identical English in both locales", en.prompt === pt.prompt && !/orquestrador/.test(pt.prompt));
	}

	resetEnv();
	for (const k of ENV_KEYS) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; else delete process.env[k];
	if (failures > 0) {
		console.error(`\n${failures} check(s) failed`);
		process.exit(1);
	}
	console.log("\nall checks passed");
}

main();
