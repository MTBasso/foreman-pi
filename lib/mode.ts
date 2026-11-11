/**
 * Orchestrator-mode state, shared by every extension that needs it.
 *
 * Mode lives in session state, not on disk:
 *   1. the persisted custom session entry `foreman-mode` (appended by
 *      extensions/foreman-mode, restored from `ctx.sessionManager.getBranch()`),
 *   2. the `foreman:mode` event on `pi.events`,
 *   3. the `FOREMAN_PI_MODE` env override (`orchestrator` | `off`) for RPC,
 *      print and live runs.
 *
 * Precedence of `isActive()`:
 *   FOREMAN_PI_SUBAGENT=1 -> inactive (always, checked first)
 *   FOREMAN_PI_MODE       -> orchestrator = active, off = inactive
 *   entry / event state   -> whichever was set last
 *   default               -> inactive
 *
 * Each extension creates its own tracker (extensions may not share a module
 * singleton), and every tracker listens on the shared bus. Bus semantics
 * (verified in lib/mode-test.ts): `emit` is synchronous, handlers start in
 * registration order, return values are ignored and handler promises are not
 * awaited. State handlers here are synchronous, so `isActive()` is correct
 * right after an emit; request/reply (abort ack) uses a callback in the payload.
 */

export const MODE_ENTRY_TYPE = "foreman-mode";
export const MODE_EVENT = "foreman:mode";
/** Request (from other extensions) for foreman-mode to change the mode: `{ active: boolean }`. */
export const MODE_SET_EVENT = "foreman:mode:set";
export const MODE_ENV = "FOREMAN_PI_MODE";

export type ModeSource = "subagent" | "env" | "entry" | "event" | "default";

export interface ModeEventData {
	active: boolean;
}

export interface ModeBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork" | (string & {});

/** `true`/`false` when FOREMAN_PI_MODE forces a state, else undefined. */
export function envOverride(env: Record<string, string | undefined> = process.env): boolean | undefined {
	const v = (env[MODE_ENV] ?? "").trim().toLowerCase();
	if (v === "orchestrator") return true;
	if (v === "off") return false;
	return undefined;
}

export function isSubagent(env: Record<string, string | undefined> = process.env): boolean {
	return env.FOREMAN_PI_SUBAGENT === "1";
}

/** Newest `foreman-mode` entry's `active` flag in a branch (oldest first), or undefined. */
export function latestModeEntry(entries: readonly any[]): boolean | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "custom" && e.customType === MODE_ENTRY_TYPE && typeof e.data?.active === "boolean") {
			return e.data.active;
		}
	}
	return undefined;
}

export function createModeTracker(pi: { events: ModeBus }) {
	let stored: { active: boolean; source: "entry" | "event" } | undefined;
	const listeners = new Set<(active: boolean) => void>();

	function state(): { active: boolean; source: ModeSource } {
		if (isSubagent()) return { active: false, source: "subagent" };
		const forced = envOverride();
		if (forced !== undefined) return { active: forced, source: "env" };
		if (stored) return { active: stored.active, source: stored.source };
		return { active: false, source: "default" };
	}

	let last = state().active;
	function notify() {
		const now = state().active;
		if (now === last) return;
		last = now;
		for (const cb of [...listeners]) {
			try {
				cb(now);
			} catch {
				// a failing listener must not break the others or the emitter
			}
		}
	}

	const off = pi.events.on(MODE_EVENT, (data) => {
		const d = data as Partial<ModeEventData> | undefined;
		if (typeof d?.active !== "boolean") return;
		stored = { active: d.active, source: "event" };
		notify();
	});

	return {
		isActive: () => state().active,
		source: () => state().source,
		describe: () => state(),
		/** Record a local change (the writer calls this, then emits MODE_EVENT). */
		set(active: boolean) {
			stored = { active, source: "event" };
			notify();
		},
		/** Fires only when the effective state flips (env/subagent can mask changes). */
		onChange(cb: (active: boolean) => void): () => void {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		/**
		 * session_start: rebuild state from the session branch. `new` always
		 * starts inactive; every other reason reads the newest entry (a fresh
		 * `startup` has none, so it is never locked).
		 */
		restore(ctx: { sessionManager?: { getBranch(): readonly any[] } }, reason: SessionStartReason): boolean {
			let entry: boolean | undefined;
			if (reason !== "new") {
				try {
					entry = latestModeEntry(ctx.sessionManager?.getBranch() ?? []);
				} catch {
					entry = undefined;
				}
			}
			stored = entry === undefined ? undefined : { active: entry, source: "entry" };
			notify();
			return state().active;
		},
		dispose: () => {
			off();
			listeners.clear();
		},
	};
}

export type ModeTracker = ReturnType<typeof createModeTracker>;
