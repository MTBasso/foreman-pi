#!/usr/bin/env node
// Compare failing test names (stdin, one per line) against a baseline file.
// Usage: node baseline-diff.mjs <baseline-file> [--record] < names
//   --record  write stdin as the new baseline instead of diffing
// Exit 0 when there are no NEW failures; 1 otherwise; 2 on usage error.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [file, flag] = process.argv.slice(2);
if (!file) {
	console.error("usage: baseline-diff.mjs <baseline-file> [--record] < names");
	process.exit(2);
}
const norm = (l) => l.replace(/\s+/g, " ").trim();
const names = (text) => [...new Set(text.split("\n").map(norm).filter(Boolean))].sort();
const current = names(readFileSync(0, "utf8"));

if (flag === "--record") {
	writeFileSync(file, current.join("\n") + "\n");
	console.log(`recorded ${current.length} name(s) in ${file}`);
	process.exit(0);
}
if (!existsSync(file)) {
	console.error(`no baseline at ${file}; record one with --record`);
	process.exit(2);
}
const base = names(readFileSync(file, "utf8"));
const baseSet = new Set(base);
const curSet = new Set(current);
// Baselines written by hand may truncate long names: accept a prefix match.
const known = (n) => baseSet.has(n) || base.some((b) => n.startsWith(b) || b.startsWith(n));
const fresh = current.filter((n) => !known(n));
const fixed = base.filter((b) => !curSet.has(b) && !current.some((n) => n.startsWith(b) || b.startsWith(n)));
for (const n of fresh) console.log(`NEW: ${n}`);
for (const n of fixed) console.log(`FIXED: ${n}`);
console.log(`baseline ${base.length}, current ${current.length}, new ${fresh.length}, fixed ${fixed.length}`);
process.exit(fresh.length ? 1 : 0);
