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
} as const;
