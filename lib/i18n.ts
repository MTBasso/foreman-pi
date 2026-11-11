/**
 * Minimal i18n for human-facing UI strings (English + pt-BR).
 * Pi has no locale setting, so the locale comes from the environment.
 */
import { en } from "./i18n/en.ts";
import { ptBR } from "./i18n/pt-BR.ts";

export type Locale = "en" | "pt-BR";
export type MessageKey = keyof typeof en;

const catalogs: Record<Locale, Record<string, string>> = { en, "pt-BR": ptBR };

/** Map a raw locale string to a Locale, or undefined if it is not a usable value. */
function parse(raw: string | undefined): Locale | undefined {
	const v = (raw ?? "").trim();
	if (!v) return undefined;
	const lang = v.split(/[._@:]/)[0].split("-")[0].toLowerCase();
	if (lang === "pt") return "pt-BR";
	if (lang === "en") return "en";
	return undefined;
}

/** FOREMAN_LANG, then LC_ALL, LC_MESSAGES, LANG; C/POSIX/other -> en; default en. */
export function detectLocale(env: Record<string, string | undefined> = process.env): Locale {
	const foreman = parse(env.FOREMAN_LANG);
	if (foreman) return foreman; // invalid FOREMAN_LANG falls through
	for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const raw = (env[name] ?? "").trim();
		if (raw) return parse(raw) ?? "en"; // first non-empty wins; C/POSIX/other -> en
	}
	return "en";
}

/** Translate a key. Locale is resolved per call; falls back to en, then the key. */
export function t(key: MessageKey, params?: Record<string, string | number>): string;
export function t(key: string, params?: Record<string, string | number>): string;
export function t(key: string, params?: Record<string, string | number>): string {
	const locale = detectLocale();
	const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export const catalogsForTest = catalogs;
