/**
 * foreman-mode — the single writer of orchestrator-mode state.
 *
 * Commands: /foreman [request] | /foreman off, /foreman-audit [scope],
 * /foreman-diagnose [problem], /plan-runner <plan>. Entering the mode appends
 * the `foreman-mode` session entry, broadcasts `foreman:mode`, sets the status
 * line and sends the embedded skill text as a user message (prompts.ts).
 * Everything else (guardrail, coordination, session-reminder) only reads the
 * state through lib/mode.ts. Handlers work with `hasUI` false (print/RPC):
 * messages fall back to stderr.
 *
 * Workers (FOREMAN_PI_SUBAGENT=1) get a no-op extension: they never see the
 * mode commands.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { t } from "../../lib/i18n.ts";
import {
	createModeTracker,
	envOverride,
	isSubagent,
	MODE_ENTRY_TYPE,
	MODE_EVENT,
	MODE_SET_EVENT,
} from "../../lib/mode.ts";
import { safeUi, say } from "../../lib/ui.ts";
import { activeCount, WORKERS_ABORT_EVENT, WORKERS_EVENT, type WorkersSnapshot } from "../../lib/workers.ts";
import { buildAuditPrompt, buildDiagnosePrompt, buildForemanPrompt, buildPlanRunnerPrompt, resolvePlanPath } from "./prompts.ts";

const STATUS_KEY = "foreman-mode";
/** Longer than the SIGTERM -> SIGKILL grace (5s) so a stubborn worker is still reaped before we give up waiting. */
const DEFAULT_ABORT_WAIT_MS = 7000;

function abortWaitMs(): number {
	const raw = process.env.FOREMAN_ABORT_WAIT_MS;
	if (raw === undefined || raw === "") return DEFAULT_ABORT_WAIT_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ABORT_WAIT_MS;
}

export default function (pi: ExtensionAPI) {
	if (isSubagent()) return;

	const tracker = createModeTracker(pi);
	let workers: WorkersSnapshot | undefined;
	let lastCtx: any;

	pi.events.on(WORKERS_EVENT, (data) => {
		workers = data as WorkersSnapshot;
	});

	function updateStatus(ctx: any) {
		safeUi(ctx, (ui) => ui.setStatus(STATUS_KEY, tracker.isActive() ? t("status.modeOn") : undefined));
	}

	/** Write the new state: local tracker first (sync), then entry, then broadcast. */
	function apply(active: boolean, ctx: any) {
		tracker.set(active);
		pi.appendEntry(MODE_ENTRY_TYPE, { active, at: Date.now() });
		pi.events.emit(MODE_EVENT, { active });
		updateStatus(ctx);
	}

	// Other extensions (session-reminder's resume/fork confirm) ask for a change here.
	pi.events.on(MODE_SET_EVENT, (data) => {
		const active = (data as { active?: unknown } | undefined)?.active;
		if (typeof active !== "boolean" || active === tracker.isActive()) return;
		apply(active, lastCtx);
		if (!active) say(lastCtx, t("cmd.off.done"));
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		tracker.restore(ctx, event.reason);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		safeUi(ctx, (ui) => ui.setStatus(STATUS_KEY, undefined));
	});

	/** Turn the mode on; false when FOREMAN_PI_MODE=off forbids it. */
	function enter(ctx: any): boolean {
		lastCtx = ctx;
		if (envOverride() === false) {
			say(ctx, t("cmd.envForcedOff"), "warning");
			return false;
		}
		if (!tracker.isActive()) {
			apply(true, ctx);
			say(ctx, t("cmd.entered"));
		} else {
			updateStatus(ctx);
		}
		return true;
	}

	function send(prompt: string, ctx: any) {
		const busy = typeof ctx?.isIdle === "function" && !ctx.isIdle();
		// sendUserMessage lives on `pi`, not on the command ctx.
		if (busy) pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		else pi.sendUserMessage(prompt);
	}

	/** Ask coordination to abort every worker; resolves on its ack or after a bounded wait. */
	function abortWorkers(): Promise<void> {
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(finish, abortWaitMs());
			pi.events.emit(WORKERS_ABORT_EVENT, { ack: finish });
		});
	}

	async function leave(ctx: any) {
		lastCtx = ctx;
		if (envOverride() === true) {
			say(ctx, t("cmd.off.envForced"), "warning");
			return;
		}
		if (!tracker.isActive()) {
			say(ctx, t("cmd.off.already"));
			return;
		}
		const n = activeCount(workers);
		if (n > 0) {
			if (!ctx.hasUI) {
				say(ctx, t("cmd.off.refuseNoUi", { count: n }), "error");
				return;
			}
			// No timeout: aborting running work is never a default.
			const ok = await ctx.ui.confirm(t("cmd.off.confirmTitle"), t("cmd.off.confirm", { count: n }));
			if (!ok) {
				say(ctx, t("cmd.off.staying"));
				return;
			}
			await abortWorkers();
			say(ctx, t("cmd.off.aborted", { count: n }));
		}
		apply(false, ctx);
		say(ctx, t("cmd.off.done"));
	}

	pi.registerCommand("foreman", {
		description: t("cmd.foreman.desc"),
		getArgumentCompletions: (prefix: string) =>
			"off".startsWith(prefix.toLowerCase()) && prefix !== "" ? [{ value: "off", label: "off" }] : null,
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			if (/^off$/i.test(a)) {
				await leave(ctx);
				return;
			}
			if (!enter(ctx)) return;
			send(buildForemanPrompt(a), ctx);
		},
	});

	pi.registerCommand("foreman-audit", {
		description: t("cmd.audit.desc"),
		handler: async (args, ctx) => {
			if (!enter(ctx)) return;
			send(buildAuditPrompt(args ?? ""), ctx);
		},
	});

	pi.registerCommand("foreman-diagnose", {
		description: t("cmd.diagnose.desc"),
		handler: async (args, ctx) => {
			lastCtx = ctx;
			send(buildDiagnosePrompt(args ?? ""), ctx);
		},
	});

	pi.registerCommand("plan-runner", {
		description: t("cmd.planRunner.desc"),
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (!arg) {
				say(ctx, t("cmd.plan.usage"), "warning");
				return;
			}
			const plan = resolvePlanPath(arg, ctx.cwd);
			if (!plan.exists) say(ctx, t("cmd.plan.missing", { path: plan.path }), "warning");
			if (!enter(ctx)) return;
			send(buildPlanRunnerPrompt(plan.path, plan.exists), ctx);
		},
	});
}
