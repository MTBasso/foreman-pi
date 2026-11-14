// Pure activity tracker for one worker's `pi --mode json` event stream. No pi imports, no clock
// (callers pass `now`), O(1) per event. Event shapes follow pi's docs/json.md and a recorded stream
// (lib/testdata/worker-stream.jsonl). Unknown or malformed events are ignored.

export type Phase = "idle" | "thinking" | "writing" | "tool" | "reporting" | "waiting";
export type Health = "active" | "waiting" | "silent" | "repeating" | "denied";

export interface RecentAction { label: string; durationMs: number; isError: boolean; at: number }

export interface ActivityView {
	phase: Phase;
	/** thinking snippet, `<tool> <target> <size>` while writing, command/path head while a tool runs, else "" */
	label: string;
	/** bytes of tool-call arguments streamed so far for the call being written (0 otherwise) */
	bytes: number;
	lastEventAt: number;
	turns: number;
	toolCalls: number;
	outTokens: number;
	cost: number;
	/** oldest first, at most RECENT_MAX */
	recent: RecentAction[];
	health: Health;
	denials: number;
	lastDenial: string;
}

export interface ActivityTracker {
	feed(event: unknown, now: number): void;
	view(now: number): ActivityView;
	reset(now: number): void;
}

export const RECENT_MAX = 5;
const ACTIVE_MS = 20_000;
const WAITING_MAX_MS = 90_000;
const TOOL_LONG_MS = 60_000;
const REPEAT_AT = 3;
const THINK_LABEL = 70;
const THINK_KEEP = 200;
const TARGET_HEAD = 60;
const ARGS_KEEP = 2000;
const DENIAL_PREFIX = "Blocked by the foreman worker guard";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function head(s: string, n: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? one.slice(0, n) : one;
}

function targetOf(args: unknown): string {
	if (!isObj(args)) return "";
	const v = str(args.command) || str(args.path) || str(args.file_path) || str(args.file);
	return head(v, TARGET_HEAD);
}

/** Best-effort target from a partially streamed JSON arguments string. */
function partialTarget(buf: string): string {
	const m = /"(?:command|path|file_path|file)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(buf);
	return m ? head(m[1].replace(/\\(.)/g, "$1"), TARGET_HEAD) : "";
}

function sizeLabel(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function resultText(result: unknown): string {
	if (!isObj(result) || !Array.isArray(result.content)) return "";
	for (const c of result.content) if (isObj(c) && typeof c.text === "string") return c.text;
	return "";
}

export function createActivityTracker(opts: { stuckAfterMs?: number } = {}): ActivityTracker {
	const stuckAfterMs = opts.stuckAfterMs ?? WAITING_MAX_MS;

	let phase: Phase;
	let thinking: string;
	let wTool: string; // tool call currently being written
	let wArgs: string;
	let wBytes: number;
	let tool: { name: string; target: string; startedAt: number } | null;
	let lastEventAt: number;
	let turns: number;
	let toolCalls: number;
	let baseOut: number, curOut: number, baseCost: number, curCost: number;
	let recent: RecentAction[];
	let repeatKey: string, repeatCount: number;
	let denials: number, lastDenial: string, deniedLast: boolean;

	const reset = (now: number): void => {
		phase = "idle"; thinking = ""; wTool = ""; wArgs = ""; wBytes = 0; tool = null;
		lastEventAt = now; turns = 0; toolCalls = 0;
		baseOut = 0; curOut = 0; baseCost = 0; curCost = 0;
		recent = []; repeatKey = ""; repeatCount = 0;
		denials = 0; lastDenial = ""; deniedLast = false;
	};
	reset(0);

	const wLabel = (): string => {
		const target = partialTarget(wArgs);
		return [wTool, target, wBytes > 0 ? sizeLabel(wBytes) : ""].filter(Boolean).join(" ");
	};

	const onAssistantEvent = (e: Obj, now: number): boolean => {
		switch (e.type) {
			case "thinking_start":
				phase = "thinking"; thinking = ""; break;
			case "thinking_delta":
				phase = "thinking";
				thinking = (thinking + str(e.delta)).slice(-THINK_KEEP);
				break;
			case "toolcall_start":
				phase = "writing"; wTool = str(e.toolName); wArgs = ""; wBytes = 0; break;
			case "toolcall_delta": {
				phase = "writing";
				const d = str(e.delta);
				wBytes += d.length;
				if (wArgs.length < ARGS_KEEP) wArgs += d.slice(0, ARGS_KEEP - wArgs.length);
				break;
			}
			case "text_delta":
				phase = "reporting"; break;
			default:
				return false; // unknown assistant event: not counted as activity
		}
		lastEventAt = now;
		return true;
	};

	const feed = (event: unknown, now: number): void => {
		if (!isObj(event) || typeof event.type !== "string") return;
		switch (event.type) {
			case "message_update": {
				const ae = event.assistantMessageEvent;
				if (!isObj(ae)) return;
				if (!onAssistantEvent(ae, now)) return;
				if (isObj(event.usage)) {
					const out = num(event.usage.output);
					if (out > 0) curOut = out;
					if (isObj(event.usage.cost)) curCost = num(event.usage.cost.total);
				}
				return;
			}
			case "message_start": {
				lastEventAt = now;
				const m = event.message;
				if (isObj(m) && m.role === "assistant") { baseOut += curOut; baseCost += curCost; curOut = 0; curCost = 0; }
				return;
			}
			case "agent_start": case "turn_start": case "message_end": case "tool_execution_update":
				lastEventAt = now;
				return;
			case "turn_end":
				lastEventAt = now; turns++; phase = "waiting"; wTool = ""; wArgs = ""; wBytes = 0;
				return;
			case "tool_execution_start": {
				const name = str(event.toolName);
				const target = targetOf(event.args);
				lastEventAt = now; toolCalls++; phase = "tool"; wTool = ""; wArgs = ""; wBytes = 0; deniedLast = false;
				tool = { name, target, startedAt: now };
				const key = `${name}\u0000${target}`;
				if (key === repeatKey) repeatCount++; else { repeatKey = key; repeatCount = 1; }
				return;
			}
			case "tool_execution_end": {
				lastEventAt = now;
				const name = str(event.toolName) || tool?.name || "";
				const target = tool?.target ?? "";
				const isError = event.isError === true;
				const dur = typeof event.durationMs === "number" ? event.durationMs : tool ? Math.max(0, now - tool.startedAt) : 0;
				recent.push({ label: [name, target].filter(Boolean).join(" "), durationMs: dur, isError, at: now });
				if (recent.length > RECENT_MAX) recent.shift();
				tool = null; phase = "waiting";
				const text = resultText(event.result);
				if (isError && text.startsWith(DENIAL_PREFIX)) { denials++; lastDenial = head(text, 200); deniedLast = true; } else deniedLast = false;
				return;
			}
			default:
				return;
		}
	};

	const view = (now: number): ActivityView => {
		const age = now - lastEventAt;
		let health: Health;
		if (tool) {
			health = age >= ACTIVE_MS || now - tool.startedAt > TOOL_LONG_MS ? "waiting" : "active";
		} else if (stuckAfterMs > 0 && age > stuckAfterMs) health = "silent";
		else health = age >= ACTIVE_MS ? "waiting" : "active";
		if (health !== "silent") {
			if (deniedLast) health = "denied";
			else if (repeatCount >= REPEAT_AT) health = "repeating";
		}
		let label = "";
		if (phase === "thinking") label = thinking.trim().slice(-THINK_LABEL);
		else if (phase === "writing") label = wLabel();
		else if (phase === "tool" && tool) label = tool.target || tool.name;
		return {
			phase, label, bytes: wBytes, lastEventAt, turns, toolCalls,
			outTokens: baseOut + curOut, cost: baseCost + curCost,
			recent: recent.slice(), health, denials, lastDenial,
		};
	};

	return { feed, view, reset };
}

