#!/usr/bin/env node
// Follow a foreman worker's JSON event log and print it readably.
// Usage: node herdr-tail.mjs <events.jsonl> <label>
// Exits when <events.jsonl>.done appears (the coordinator writes it when the worker ends).
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";

const [file, label = "worker"] = process.argv.slice(2);
if (!file) {
	console.error("usage: herdr-tail.mjs <events.jsonl> [label]");
	process.exit(2);
}
const c = { dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", red: "\x1b[31m", off: "\x1b[0m" };
const clip = (s, n = 160) => { const one = String(s).replace(/\s+/g, " ").trim(); return one.length > n ? one.slice(0, n - 1) + "…" : one; };

export function render(line) {
	let e;
	try { e = JSON.parse(line); } catch { return undefined; }
	if (e?.type !== "message_end") return undefined;
	const m = e.message;
	if (m?.role === "assistant") {
		const out = [];
		for (const p of m.content ?? []) {
			if (p.type === "text" && p.text?.trim()) out.push(`${c.green}▍${c.off} ${clip(p.text, 400)}`);
			else if (p.type === "toolCall") out.push(`${c.cyan}→ ${p.name}${c.off} ${c.dim}${clip(JSON.stringify(p.arguments ?? {}), 140)}${c.off}`);
		}
		if (m.stopReason === "error") out.push(`${c.red}✗ ${clip(m.errorMessage ?? "error")}${c.off}`);
		return out.join("\n") || undefined;
	}
	if (m?.role === "toolResult") {
		const text = (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join(" ");
		return `${m.isError ? c.red : c.dim}  ${m.isError ? "✗" : "✓"} ${m.toolName ?? ""} ${clip(text, 100)}${c.off}`;
	}
	return undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(`${c.yellow}foreman · ${label}${c.off}\n`);
	let pos = 0;
	let buf = "";
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	for (;;) {
		if (existsSync(file)) {
			const size = statSync(file).size;
			if (size > pos) {
				const fd = openSync(file, "r");
				const b = Buffer.alloc(size - pos);
				readSync(fd, b, 0, b.length, pos);
				closeSync(fd);
				pos = size;
				buf += b.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const l of lines) { const r = render(l); if (r) console.log(r); }
			}
		}
		if (existsSync(`${file}.done`) && (!existsSync(file) || statSync(file).size <= pos)) break;
		await sleep(400);
	}
	console.log(`\n${c.yellow}— worker finished —${c.off}`);
}
