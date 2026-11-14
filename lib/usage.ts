// Pure per-worker usage tally over a `pi --mode json` event stream. No pi imports, no clock, O(1) per
// event (only `message_end` is read). Unknown or malformed events are ignored. Survives resumed
// attempts because the caller feeds every attempt's events and calls noteAttempt() per attempt.

import { DENIAL_PREFIX } from "./activity.ts";

export interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	toolCalls: number;
	attempts: number;
	/** input + cacheRead + cacheWrite of the first assistant message (0 until one arrives) */
	firstRequestTokens: number;
	guardDenials: { total: number; byReason: Record<string, number> };
}

export interface UsageTally {
	feed(event: unknown): void;
	noteAttempt(): void;
	snapshot(): UsageSnapshot;
}

const REASON_MAX = 120;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** tokens = ceil(chars / 4), the convention used by PLAN.md and trace-report. */
export function tokensOf(text: string): number {
	return Math.ceil(text.length / 4);
}

export function median(numbers: number[]): number {
	if (numbers.length === 0) return 0;
	const s = [...numbers].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function denialReason(text: string): string {
	let rest = text.slice(DENIAL_PREFIX.length).replace(/^[\s:,-]+/, "");
	const end = /[.!?](\s|$)/.exec(rest);
	if (end) rest = rest.slice(0, end.index);
	return rest.trim().slice(0, REASON_MAX) || "(no reason)";
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const c of content) if (isObj(c) && typeof c.text === "string") return c.text;
	return "";
}

export function createUsageTally(): UsageTally {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
	let turns = 0, toolCalls = 0, attempts = 0, firstRequestTokens = 0;
	let denialTotal = 0;
	const byReason: Record<string, number> = {};

	return {
		feed(event) {
			if (!isObj(event) || event.type !== "message_end" || !isObj(event.message)) return;
			const m = event.message;
			if (m.role === "assistant") {
				const u = isObj(m.usage) ? m.usage : {};
				const i = num(u.input), o = num(u.output), cr = num(u.cacheRead), cw = num(u.cacheWrite);
				input += i; output += o; cacheRead += cr; cacheWrite += cw;
				cost += isObj(u.cost) ? num(u.cost.total) : 0;
				if (turns === 0) firstRequestTokens = i + cr + cw;
				turns++;
				if (Array.isArray(m.content)) for (const c of m.content) if (isObj(c) && c.type === "toolCall") toolCalls++;
			} else if (m.role === "toolResult" && m.isError === true) {
				const text = textOf(m.content);
				if (text.startsWith(DENIAL_PREFIX)) {
					denialTotal++;
					const r = denialReason(text);
					byReason[r] = (byReason[r] ?? 0) + 1;
				}
			}
		},
		noteAttempt() {
			attempts++;
		},
		snapshot() {
			return { input, output, cacheRead, cacheWrite, cost, turns, toolCalls, attempts, firstRequestTokens, guardDenials: { total: denialTotal, byReason: { ...byReason } } };
		},
	};
}
