/**
 * Tests for lib/i18n.ts and its catalogs.
 * Run with: npx tsx lib/i18n-test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { detectLocale, t } from "./i18n.ts";
import { en } from "./i18n/en.ts";
import { ptBR } from "./i18n/pt-BR.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
	console.log(`${ok ? "ok  " : "FAIL"} - ${name}${!ok && detail ? ` (${detail})` : ""}`);
	if (!ok) failures++;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

// Parity
const enKeys = Object.keys(en).sort();
const ptKeys = Object.keys(ptBR).sort();
check("key parity en/pt-BR", JSON.stringify(enKeys) === JSON.stringify(ptKeys));
for (const k of enKeys) {
	const a = placeholders((en as Record<string, string>)[k]);
	const b = placeholders((ptBR as Record<string, string>)[k] ?? "");
	check(`placeholder parity: ${k}`, a === b, `${a} vs ${b}`);
}

// Detection table
const det: Array<[string, Record<string, string>, string]> = [
	["FOREMAN_LANG beats LANG", { FOREMAN_LANG: "pt-BR", LANG: "en_US.UTF-8" }, "pt-BR"],
	["FOREMAN_LANG=en beats pt LANG", { FOREMAN_LANG: "en", LANG: "pt_BR.UTF-8" }, "en"],
	["pt_BR.UTF-8", { LANG: "pt_BR.UTF-8" }, "pt-BR"],
	["pt_PT", { LANG: "pt_PT" }, "pt-BR"],
	["pt", { LANG: "pt" }, "pt-BR"],
	["pt-BR dash", { LC_ALL: "pt-BR" }, "pt-BR"],
	["en_US.UTF-8", { LANG: "en_US.UTF-8" }, "en"],
	["C", { LANG: "C" }, "en"],
	["POSIX", { LANG: "POSIX" }, "en"],
	["empty", {}, "en"],
	["empty strings", { LANG: "", LC_ALL: "" }, "en"],
	["garbage", { LANG: "!!??" }, "en"],
	["invalid FOREMAN_LANG falls through", { FOREMAN_LANG: "xx-garbage", LANG: "pt_BR.UTF-8" }, "pt-BR"],
	["LC_ALL beats LC_MESSAGES and LANG", { LC_ALL: "pt_BR.UTF-8", LC_MESSAGES: "en_US", LANG: "en_US" }, "pt-BR"],
	["LC_MESSAGES beats LANG", { LC_MESSAGES: "pt_BR", LANG: "en_US" }, "pt-BR"],
	["LC_ALL=C beats pt LANG", { LC_ALL: "C", LANG: "pt_BR.UTF-8" }, "en"],
];
for (const [label, env, want] of det) check(`detect: ${label}`, detectLocale(env) === want, `got ${detectLocale(env)}`);

// t(): locale per call, fallback, interpolation
const saved = { ...process.env };
function withEnv(env: Record<string, string>, fn: () => void) {
	for (const k of ["FOREMAN_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) delete process.env[k];
	Object.assign(process.env, env);
	try { fn(); } finally {
		for (const k of ["FOREMAN_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) delete process.env[k];
		for (const k of ["FOREMAN_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) if (saved[k] !== undefined) process.env[k] = saved[k];
	}
}
withEnv({ LANG: "en_US.UTF-8" }, () => check("t en", t("mode.on") === "on"));
withEnv({ LANG: "pt_BR.UTF-8" }, () => check("t pt-BR (accents)", t("workers.finished") === "concluídos"));
withEnv({ LANG: "en_US.UTF-8" }, () => {
	check("locale switches per call", (process.env.FOREMAN_LANG = "pt-BR", t("confirm.no") === "Não"));
});
withEnv({ LANG: "pt_BR.UTF-8" }, () => {
	check("missing key falls back to key", t("no.such.key") === "no.such.key");
	check("interpolation", t("confirm.abortWorkers", { count: 3 }) === "Abortar 3 workers em execução?");
	check("no leaked {} for every key", enKeys.every((k) => {
		const params = Object.fromEntries(placeholders((en as Record<string, string>)[k]).split(",").filter(Boolean).map((p) => [p, "X"]));
		return !/[{}]/.test(t(k, params));
	}));
	check("unknown param left untouched, not crashed", t("confirm.abortWorkers", {}) .includes("{count}"));
});

// Key registry: every t("...") call in extensions/ and lib/ uses a known key.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function walk(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (p.endsWith(".ts")) out.push(p);
	}
	return out;
}
const callRe = /(?<![\w.$])t\(\s*(["'`])([^"'`]+)\1/g;
const scanFiles = [...walk(path.join(root, "extensions")), ...walk(path.join(root, "lib"))].filter((f) => !f.endsWith("i18n-test.ts"));
const known = new Set(enKeys);
let calls = 0;
const unknown: string[] = [];
for (const f of scanFiles) {
	for (const m of fs.readFileSync(f, "utf8").matchAll(callRe)) {
		calls++;
		if (!known.has(m[2])) unknown.push(`${path.relative(root, f)}: ${m[2]}`);
	}
}
check(`key registry: ${calls} t("…") calls all use known keys`, unknown.length === 0, unknown.join("; "));
check("key registry regex flags unknown keys", [...'t("bogus.key")'.matchAll(callRe)].length === 1 && !known.has("bogus.key"));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
