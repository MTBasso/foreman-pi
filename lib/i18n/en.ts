/**
 * English catalog (source of truth for keys). Human-facing UI strings only;
 * prompts, guardrail reasons, notification blocks and contract keywords stay
 * English and do not live here. Later phases add keys as they need them.
 * Placeholders use {name}.
 */
export const en = {
	"mode.on": "on",
	"mode.off": "off",
	"workers.running": "running",
	"workers.queued": "queued",
	"workers.finished": "finished",
	"workers.count": "{count} workers",
	"status.label": "Status",
	"confirm.yes": "Yes",
	"confirm.no": "No",
	"confirm.abortWorkers": "Abort {count} running workers?",
	"confirm.cancelled": "Cancelled.",

	// Commands: descriptions
	"cmd.foreman.desc": "Enter orchestrator mode and start the foreman workflow (/foreman off to leave)",
	"cmd.audit.desc": "Enter orchestrator mode and run a read-only codebase audit",
	"cmd.diagnose.desc": "Diagnose why a foreman or plan-runner run went wrong (does not change mode)",
	"cmd.planRunner.desc": "Enter orchestrator mode and run an approved plan from docs/plans/",
	"cmd.status.desc": "Show orchestrator mode and worker status (no model call)",

	// Commands: notifications and prompts
	"cmd.entered": "Orchestrator mode is on. Use /foreman off to leave.",
	"cmd.envForcedOff": "FOREMAN_PI_MODE=off prevents orchestrator mode. Unset it to use this command.",
	"cmd.off.done": "Orchestrator mode is off. Tools restored.",
	"cmd.off.already": "Orchestrator mode is already off.",
	"cmd.off.envForced": "Orchestrator mode is forced by FOREMAN_PI_MODE=orchestrator. Unset it to leave.",
	"cmd.off.confirmTitle": "Leave orchestrator mode?",
	"cmd.off.confirm": "{count} workers are still running. Abort them and leave orchestrator mode?",
	"cmd.off.refuseNoUi": "{count} workers are running. Run /foreman off interactively or let them finish. Staying in orchestrator mode.",
	"cmd.off.staying": "Staying in orchestrator mode.",
	"cmd.off.aborted": "Aborted {count} workers.",
	"cmd.plan.usage": "Usage: /plan-runner <plan file or slug>",
	"cmd.plan.missing": "Plan file not found: {path}. Sending the path anyway.",

	// Confirm on resume/fork
	"confirm.keepMode.title": "Keep orchestrator mode?",
	"confirm.keepMode": "This session was in orchestrator mode. Keep it on?",

	// Status bar and widget
	"status.modeOn": "foreman: orchestrator mode",
	"status.workers": "workers: {running} running, {queued} queued",
	"widget.step": "step {step}",
	"widget.queued": "{count} queued",
	"widget.state.completed": "completed",
	"widget.state.failed": "failed",
	"widget.state.blocked": "blocked",
	"widget.state.aborted": "aborted",

	// /foreman-status report
	"report.title": "Foreman status",
	"report.mode": "Orchestrator mode: {state} ({source})",
	"report.workers": "Workers: {running} running, {queued} queued",
	"report.none": "No workers have run in this session.",
	"report.running": "Running:",
	"report.recent": "Recent:",
	"report.source.subagent": "worker process",
	"report.source.env": "environment",
	"report.source.entry": "session entry",
	"report.source.event": "this session",
	"report.source.default": "default",
} as const;
