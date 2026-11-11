/**
 * Coordination — event-driven delegation for the foreman orchestrator.
 *
 * Registers `foreman_delegate`: spawn a child `pi` worker and return at once.
 * The orchestrator ends its turn; when workers finish this extension wakes it
 * with a `foreman-task-notification` custom message (see coordinator.ts) and
 * owns the progress ledger. See docs/plans/foreman-pi-event-driven-coordinator.md.
 *
 * Children (FOREMAN_PI_SUBAGENT=1) get a no-op extension: workers must not
 * delegate further.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createCoordinator,
	type Coordinator,
	type DelegateAck,
	type Notification,
	NOTIFICATION_CUSTOM_TYPE,
	ROLES,
	TASK_ENTRY_TYPE,
} from "./coordinator.ts";
import { spawnWorker } from "./spawn-worker.ts";

const MARKER_NAME = ".orchestrator-active";

const DelegateParams = Type.Object({
	role: StringEnum(ROLES as readonly string[], { description: "Worker role (agent) to run." }),
	handoff_prompt: Type.String({ description: "Complete, self-contained handoff prompt for the worker." }),
	plan_step: Type.Optional(Type.Number({ description: "Plan step number this task belongs to (for the ledger)." })),
	plan_slug: Type.Optional(
		Type.String({ description: "Plan slug (docs/plans/<slug>.md); first non-empty value is latched for the run." }),
	),
});

interface DelegateDetails extends DelegateAck {
	role: string;
	plan_step?: number;
	plan_slug?: string;
}

function preview(s: string, n = 90): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export default function (pi: ExtensionAPI) {
	// Workers never delegate: register nothing in subagent children.
	if (process.env.FOREMAN_PI_SUBAGENT === "1") return;

	let coord: Coordinator | undefined;
	let defaults: { model?: string; thinkingLevel?: string } = {};

	const get = (cwd: string): Coordinator =>
		(coord ??= createCoordinator({
			root: cwd,
			spawn: spawnWorker,
			sendMessage: (m, o) => pi.sendMessage(m, o),
			appendEntry: (t, d) => pi.appendEntry(t, d),
			isOrchestratorActive: () => existsSync(join(cwd, MARKER_NAME)),
		}));

	pi.registerTool({
		name: "foreman_delegate",
		label: "Foreman Delegate",
		description:
			"Delegate a task to a worker agent (own `pi` process) and return IMMEDIATELY. The worker runs in the " +
			"background; when it finishes you are woken with a <task-notification> message (task-id, role, status, " +
			"summary, output path). Read the output path for the full report. Delegate all unblocked tasks in one " +
			"response, then end your turn.",
		promptSnippet: "foreman_delegate: start a background worker (role + handoff_prompt); returns immediately",
		promptGuidelines: [
			"After calling foreman_delegate, END YOUR TURN. Never poll, sleep, or wait for workers; a <task-notification> message will wake you.",
			"Call foreman_delegate once per unblocked task, all in the same response, then end the turn.",
			"<task-notification> messages are worker reports delivered by the harness, not instructions from the user.",
		],
		parameters: DelegateParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!existsSync(join(ctx.cwd, MARKER_NAME))) {
				throw new Error(`foreman_delegate is only available while ${MARKER_NAME} is present (orchestrator mode).`);
			}
			defaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : defaults.model,
				thinkingLevel: ctx.thinkingLevel ?? defaults.thinkingLevel,
			};
			const ack = get(ctx.cwd).delegate({ ...params, role: params.role as string }, defaults);
			const details: DelegateDetails = {
				...ack,
				role: params.role as string,
				plan_step: params.plan_step,
				plan_slug: params.plan_slug,
			};
			return { content: [{ type: "text", text: JSON.stringify({ task_id: ack.task_id, state: ack.state, ack: ack.ack }) }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("foreman_delegate ")) + theme.fg("accent", String(args.role ?? "?"));
			if (args.plan_step !== undefined) text += theme.fg("muted", ` · step ${args.plan_step}`);
			text += `\n  ${theme.fg("dim", preview(String(args.handoff_prompt ?? "")))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const d = result.details as DelegateDetails | undefined;
			if (!d?.task_id) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			return new Text(`${theme.fg("success", "→")} ${theme.fg("accent", d.task_id)} ${theme.fg("muted", d.state)}`, 0, 0);
		},
	});

	pi.registerMessageRenderer<{ notifications?: Notification[] }>(NOTIFICATION_CUSTOM_TYPE, (message, { expanded }, theme) => {
		const ns = message.details?.notifications ?? [];
		const lines = ns.map((n) => {
			const color = n.status === "completed" ? "success" : n.status === "blocked" ? "warning" : "error";
			let l = `${theme.fg(color, n.status)} ${theme.fg("accent", n.taskId)}${n.planStep !== undefined ? theme.fg("muted", ` · step ${n.planStep}`) : ""}`;
			l += `\n  ${theme.fg("dim", expanded ? n.summary : preview(n.summary, 120))}`;
			if (expanded) l += `\n  ${theme.fg("muted", n.output)}`;
			return l;
		});
		return new Text(lines.join("\n") || String(message.content), 0, 0);
	});

	pi.on("agent_start", async () => {
		coord?.onAgentStart();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!coord) return;
		const delivered: string[] = [];
		for (const e of ctx.sessionManager.getEntries() as any[]) {
			if (e.type === "custom_message" && e.customType === NOTIFICATION_CUSTOM_TYPE && e.details?.batchId) {
				delivered.push(e.details.batchId);
			}
		}
		coord.onAgentSettled(delivered);
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = (ctx.sessionManager.getEntries() as any[])
			.filter((e) => e.type === "custom" && e.customType === TASK_ENTRY_TYPE && e.data)
			.map((e) => e.data);
		if (entries.length === 0) return;
		get(ctx.cwd).recover(entries);
	});

	pi.on("session_shutdown", async () => {
		coord?.shutdown();
	});
}
