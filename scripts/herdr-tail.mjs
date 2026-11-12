#!/usr/bin/env node
// Follow a foreman worker's JSON event log in a herdr pane and print it compactly.
// Usage: node herdr-tail.mjs <events.jsonl> <label>
// Lifecycle: the pane's process IS this script (the coordinator runs it with `exec`), so
// herdr closes the pane when it exits. On <events.jsonl>.done:
//   "ok"        -> print a summary, linger LINGER_S seconds (default 8), exit => pane closes
//   "attention" -> print the summary and wait for Enter/q so a blocked/failed run stays visible
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";

const ESC = "\x1b[";
const c = {
	dim: `${ESC}2m`, bold: `${ESC}1m`, cyan: `${ESC}36m`, yellow: `${ESC}33m`, green: `${ESC}32m`,
	red: `${ESC}31m`, blue: `${ESC}34m`, magenta: `${ESC}35m`, off: `${ESC}0m`,
};
const clip = (s, n = 90) => {
	const one = String(s ?? "").replace(/\s+/g, " ").trim();
	return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
const shorten = (p) => {
	const s = String(p ?? "");
	const parts = s.split("/");
	return s.startsWith("/") && parts.length > 4 ? "…/" + parts.slice(-3).join("/") : s;
};

/** One-line human summary of a tool call. */
export function summarizeCall(name, a = {}) {
	switch (name) {
		case "write": return `write ${shorten(a.path)} ${c.dim}${(a.content ?? "").length} chars${c.off}`;
		case "edit": return `edit  ${shorten(a.path)} ${c.dim}${(a.edits ?? [a]).length} change(s)${c.off}`;
		case "read": return `read  ${shorten(a.path)}`;
		case "bash": return `bash  ${c.dim}${clip(a.command, 100)}${c.off}`;
		default: return `${name} ${c.dim}${clip(JSON.stringify(a), 80)}${c.off}`;
	}
}

/** Lines to print for one JSON event line (empty array = nothing). Successful tool results are silent. */
export function render(line, state = { calls: 0, errors: 0 }) {
	let e;
	try { e = JSON.parse(line); } catch { return []; }
	if (e?.type !== "message_end") return [];
	const m = e.message;
	const out = [];
	if (m?.role === "assistant") {
		for (const p of m.content ?? []) {
			if (p.type === "text" && p.text?.trim()) out.push(`${c.green}▍${c.off} ${clip(p.text, 220)}`);
			else if (p.type === "toolCall") { state.calls++; out.push(`${c.cyan}▸${c.off} ${summarizeCall(p.name, p.arguments)}`); }
		}
		if (m.stopReason === "error") out.push(`${c.red}✗ ${clip(m.errorMessage ?? "error", 160)}${c.off}`);
	} else if (m?.role === "toolResult" && m.isError) {
		state.errors++;
		const text = (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" ");
		out.push(`  ${c.red}✗ ${m.toolName ?? ""}: ${clip(text, 110)}${c.off}`);
	}
	return out;
}

export function fmtElapsed(ms) {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

async function main() {
	const [file, label = "worker"] = process.argv.slice(2);
	if (!file) { console.error("usage: herdr-tail.mjs <events.jsonl> [label]"); process.exit(2); }
	const lingerMs = Number(process.env.LINGER_S ?? 8) * 1000;
	const started = Date.now();
	const state = { calls: 0, errors: 0 };
	process.stdout.write(`${ESC}2J${ESC}H`);
	console.log(`${c.bold}${c.yellow}◆ ${label}${c.off}  ${c.dim}${new Date().toLocaleTimeString()}${c.off}\n`);
	let pos = 0;
	let buf = "";
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const pump = () => {
		if (!existsSync(file)) return;
		const size = statSync(file).size;
		if (size <= pos) return;
		const fd = openSync(file, "r");
		const b = Buffer.alloc(size - pos);
		readSync(fd, b, 0, b.length, pos);
		closeSync(fd);
		pos = size;
		buf += b.toString();
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const l of lines) for (const r of render(l, state)) console.log(r);
	};
	for (;;) {
		pump();
		if (existsSync(`${file}.done`)) { pump(); break; }
		await sleep(300);
	}
	const verdict = readFileSync(`${file}.done`, "utf8").trim() || "ok";
	const took = fmtElapsed(Date.now() - started);
	const stats = `${state.calls} tool calls, ${state.errors} error(s), ${took}`;
	if (verdict === "ok") {
		console.log(`\n${c.green}✔ finished${c.off} ${c.dim}${stats} · closing in ${lingerMs / 1000}s${c.off}`);
		await sleep(lingerMs);
		return;
	}
	console.log(`\n${c.red}${c.bold}! needs attention${c.off} ${c.dim}${stats}${c.off}\n${c.dim}press Enter or q to close this pane${c.off}`);
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		await new Promise((r) => process.stdin.once("data", r));
	} else {
		await sleep(60_000);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
	process.exit(0); // stdin may still be resumed (attention mode); exiting closes the herdr pane
}
