#!/usr/bin/env node
// Token audit table for a foreman run dir (.foreman/runs/<run>).
// Usage: node scripts/trace-report.mjs <run-dir> [--baseline <dir>] [--json]
// Plain JS, self-contained (ships to plain node). The aggregator below duplicates lib/usage.ts on
// purpose; lib/trace-report-test.ts is the drift guard. tokens = ceil(chars / 4).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DENIAL_PREFIX = "Blocked by the foreman worker guard";
const REASON_MAX = 120;

const isObj = (v) => typeof v === "object" && v !== null;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const tokensOf = (text) => Math.ceil(text.length / 4);

function median(numbers) {
	if (numbers.length === 0) return 0;
	const s = [...numbers].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function denialReason(text) {
	let rest = text.slice(DENIAL_PREFIX.length).replace(/^[\s:,-]+/, "");
	const end = /[.!?](\s|$)/.exec(rest);
	if (end) rest = rest.slice(0, end.index);
	return rest.trim().slice(0, REASON_MAX) || "(no reason)";
}

function textOf(content) {
	if (!Array.isArray(content)) return "";
	for (const c of content) if (isObj(c) && typeof c.text === "string") return c.text;
	return "";
}

function aggregate(events) {
	const s = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0, attempts: 0, firstRequestTokens: 0, guardDenials: { total: 0, byReason: {} } };
	for (const event of events) {
		if (!isObj(event) || event.type !== "message_end" || !isObj(event.message)) continue;
		const m = event.message;
		if (m.role === "assistant") {
			const u = isObj(m.usage) ? m.usage : {};
			const i = num(u.input), o = num(u.output), cr = num(u.cacheRead), cw = num(u.cacheWrite);
			s.input += i; s.output += o; s.cacheRead += cr; s.cacheWrite += cw;
			s.cost += isObj(u.cost) ? num(u.cost.total) : 0;
			if (s.turns === 0) s.firstRequestTokens = i + cr + cw;
			s.turns++;
			if (Array.isArray(m.content)) for (const c of m.content) if (isObj(c) && c.type === "toolCall") s.toolCalls++;
		} else if (m.role === "toolResult" && m.isError === true) {
			const text = textOf(m.content);
			if (text.startsWith(DENIAL_PREFIX)) {
				s.guardDenials.total++;
				const r = denialReason(text);
				s.guardDenials.byReason[r] = (s.guardDenials.byReason[r] ?? 0) + 1;
			}
		}
	}
	return s;
}

function readEvents(path) {
	const out = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
	}
	return out;
}

function parseArgs(argv) {
	const a = { dir: undefined, baseline: undefined, json: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--json") a.json = true;
		else if (argv[i] === "--baseline") a.baseline = argv[++i];
		else if (!a.dir) a.dir = argv[i];
		else return undefined;
	}
	return a.dir ? a : undefined;
}

function loadBaseline(dir, skipped) {
	const map = new Map();
	let names = [];
	try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { skipped.push(`${dir} (baseline dir unreadable)`); return map; }
	for (const n of names) {
		try {
			const f = JSON.parse(readFileSync(join(dir, n), "utf8"));
			if (isObj(f) && f.role !== undefined && f.plan_step !== undefined && isObj(f.baseline)) map.set(`${f.role}#${f.plan_step}`, f.baseline);
		} catch { skipped.push(join(dir, n)); }
	}
	return map;
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
	console.error("usage: node scripts/trace-report.mjs <run-dir> [--baseline <dir>] [--json]");
	process.exit(2);
}

const skipped = [];
let files = [];
try { files = readdirSync(args.dir).filter((n) => /^t.*\.json$/.test(n) && !n.endsWith(".events.jsonl")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); }
catch { skipped.push(`${args.dir} (run dir unreadable)`); }

const tasks = [];
for (const f of files) {
	let meta;
	try { meta = JSON.parse(readFileSync(join(args.dir, f), "utf8")); } catch { skipped.push(join(args.dir, f)); continue; }
	if (!isObj(meta) || typeof meta.task_id !== "string") { skipped.push(join(args.dir, f)); continue; }
	let usage = isObj(meta.usage) ? meta.usage : undefined;
	let source = "json";
	if (!usage) {
		const ev = join(args.dir, `${f.slice(0, -".json".length)}.events.jsonl`);
		try { usage = aggregate(readEvents(ev)); source = "events"; } catch { skipped.push(ev); continue; }
	}
	const gd = isObj(usage.guardDenials) ? usage.guardDenials : { total: 0, byReason: {} };
	tasks.push({
		task_id: meta.task_id,
		role: String(meta.role ?? "?"),
		plan_step: meta.plan_step ?? null,
		state: String(meta.state ?? "?"),
		handoffTokens: tokensOf(typeof meta.handoff_prompt === "string" ? meta.handoff_prompt : ""),
		turns: num(usage.turns), toolCalls: num(usage.toolCalls),
		input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite),
		cost: num(usage.cost),
		guardDenials: { total: num(gd.total), byReason: isObj(gd.byReason) ? gd.byReason : {} },
		usageSource: source,
	});
}

const sum = (list, k) => list.reduce((n, t) => n + t[k], 0);
const agg = (list) => ({ tasks: list.length, handoffTokens: sum(list, "handoffTokens"), turns: sum(list, "turns"), toolCalls: sum(list, "toolCalls"), input: sum(list, "input"), output: sum(list, "output"), cacheRead: sum(list, "cacheRead"), cacheWrite: sum(list, "cacheWrite"), cost: sum(list, "cost") });
const withDenials = (list) => ({ ...agg(list), guardDenials: list.reduce((n, t) => n + t.guardDenials.total, 0) });
const totals = withDenials(tasks);
const byRole = {};
for (const t of tasks) (byRole[t.role] ??= []).push(t);
const roleTotals = Object.fromEntries(Object.entries(byRole).map(([r, l]) => [r, withDenials(l)]));
const medianHandoffTokens = median(tasks.map((t) => t.handoffTokens));
const reasons = {};
for (const t of tasks) for (const [r, n] of Object.entries(t.guardDenials.byReason)) reasons[r] = (reasons[r] ?? 0) + num(n);
const topDenials = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([reason, count]) => ({ reason, count }));

let baseline;
if (args.baseline) {
	const map = loadBaseline(args.baseline, skipped);
	baseline = [];
	for (const t of tasks) {
		const b = map.get(`${t.role}#${t.plan_step}`);
		if (!b) continue;
		const d = (k) => t[k] - num(b[k]);
		const bd = isObj(b.guardDenials) ? num(b.guardDenials.total) : num(b.guardDenials);
		baseline.push({ task_id: t.task_id, role: t.role, plan_step: t.plan_step, delta: { handoffTokens: d("handoffTokens"), turns: d("turns"), toolCalls: d("toolCalls"), input: d("input"), output: d("output"), cacheRead: d("cacheRead"), cacheWrite: d("cacheWrite"), guardDenials: t.guardDenials.total - bd } });
	}
}

if (args.json) {
	console.log(JSON.stringify({ tasks, totals, byRole: roleTotals, medianHandoffTokens, topDenials, baseline: baseline ?? null, skipped }, null, 2));
	process.exit(0);
}

const pad = (v, w, right) => (right ? String(v).padStart(w) : String(v).padEnd(w));
const cols = [
	["task", (t) => t.task_id, false], ["role", (t) => t.role, false], ["step", (t) => t.plan_step ?? "-", true], ["state", (t) => t.state, false],
	["handoff", (t) => t.handoffTokens, true], ["turns", (t) => t.turns, true], ["tools", (t) => t.toolCalls, true],
	["in", (t) => t.input, true], ["out", (t) => t.output, true], ["cacheR", (t) => t.cacheRead, true], ["cacheW", (t) => t.cacheWrite, true],
	["cost", (t) => t.cost.toFixed(4), true], ["denied", (t) => t.guardDenials.total, true],
];
const table = (rows, getters) => {
	const widths = getters.map(([h, g]) => Math.max(h.length, ...rows.map((r) => String(g(r)).length)));
	const line = (cells) => cells.map((c, i) => pad(c, widths[i], getters[i][2])).join("  ").trimEnd();
	return [line(getters.map(([h]) => h)), ...rows.map((r) => line(getters.map(([, g]) => g(r))))].join("\n");
};

const out = [];
if (tasks.length) out.push(table(tasks, cols));
out.push("");
out.push(`totals: ${totals.tasks} tasks, handoff ${totals.handoffTokens}, turns ${totals.turns}, tools ${totals.toolCalls}, in ${totals.input}, out ${totals.output}, cacheR ${totals.cacheRead}, cacheW ${totals.cacheWrite}, cost ${totals.cost.toFixed(4)}, denied ${totals.guardDenials}`);
for (const [r, t] of Object.entries(roleTotals)) out.push(`role ${r}: ${t.tasks} tasks, handoff ${t.handoffTokens}, turns ${t.turns}, tools ${t.toolCalls}, in ${t.input}, out ${t.output}, cacheR ${t.cacheRead}, cacheW ${t.cacheWrite}, cost ${t.cost.toFixed(4)}, denied ${t.guardDenials}`);
out.push(`median handoff tokens: ${medianHandoffTokens}`);
if (topDenials.length) { out.push("top denial reasons:"); for (const d of topDenials) out.push(`  ${d.count}x ${d.reason}`); }
if (baseline) {
	out.push("baseline deltas (current - baseline):");
	if (baseline.length === 0) out.push("  (no task matched a baseline fixture by role and plan_step)");
	const sign = (n) => (n > 0 ? `+${n}` : String(n));
	for (const b of baseline) out.push(`  ${b.task_id} ${b.role} step ${b.plan_step}: ${Object.entries(b.delta).map(([k, v]) => `${k} ${sign(v)}`).join(", ")}`);
}
for (const s of skipped) out.push(`skipped: ${s}`);
console.log(out.join("\n"));
