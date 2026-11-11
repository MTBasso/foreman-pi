/**
 * Small UI helpers that work with or without a UI (print and JSON modes have
 * `hasUI === false`) and tolerate stale contexts (a captured ctx throws after
 * a session switch or reload).
 */

export type NotifyLevel = "info" | "warning" | "error";

/** Notify through the UI, or write to stderr when there is none (or it throws). */
export function say(ctx: any, message: string, level: NotifyLevel = "info"): void {
	try {
		if (ctx?.hasUI && ctx.ui) {
			ctx.ui.notify(message, level);
			return;
		}
	} catch {
		// fall through to stderr
	}
	process.stderr.write(`${message}\n`);
}

/** Run a UI call only when there is a UI; swallow stale-context errors. */
export function safeUi(ctx: any, fn: (ui: any) => void): void {
	if (!ctx?.hasUI || !ctx.ui) return;
	try {
		fn(ctx.ui);
	} catch {
		// stale ctx after reload/session switch: nothing to update
	}
}
