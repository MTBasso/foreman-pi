/**
 * Coordinator-appended worker footer (A2).
 *
 * Language, orchestrator-mode and workdir boilerplate is written once by code
 * instead of by the orchestrator in every handoff. Pure; English prose (handoffs
 * are English), only the `User language:` value follows the locale.
 */
import type { Locale } from "./i18n.ts";

export interface FooterInput {
	locale: Locale;
	/** Final worker cwd (the isolated worktree when isolated). */
	cwd: string;
}

export function workerFooter({ locale, cwd }: FooterInput): string {
	return [
		"---",
		`User language: ${locale}. If the handoff above names another language, follow that.`,
		"Orchestrator mode does not apply to you; proceed normally.",
		`Working directory: ${cwd}`,
		"The guard and report rules are the Shared worker rules in your system prompt.",
	].join("\n");
}

export interface ComposeInput {
	/** Handoff text as sent (inline, or the pointer for an oversized one). */
	handoff: string;
	/** Resume preamble, when this is a resume attempt. */
	resume?: string;
	footer: string;
}

/** Build the `Task:` argument: resume preamble first, handoff, footer last. */
export function composeTaskArg({ handoff, resume, footer }: ComposeInput): string {
	return `Task: ${resume ? `${resume}\n\n` : ""}${handoff}\n\n${footer}`;
}
