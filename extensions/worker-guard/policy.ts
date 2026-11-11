/**
 * Worker write-guard policy. Pure: no pi imports, only node:fs/os/path for path
 * resolution. `checkWrite` judges one write/edit target, `checkBash` one bash
 * command string, both against the role the worker was spawned with
 * (FOREMAN_PI_ROLE, see lib/spawn.ts `workerEnv`).
 *
 * This is a HEURISTIC GUARD, not a sandbox. It parses shell text; it cannot see
 * what an interpreter, `make`, `npm run`, a shell function or a script writes.
 * See references/worker-guard.md for the honest limits.
 *
 * Design rules:
 *  - fail closed: anything that cannot be resolved (`$VAR`, glob, `~`, command
 *    substitution, unbalanced quotes, `eval`, process substitution) is denied
 *    where it could name a write target;
 *  - no allowance by file extension: a target is allowed only because it
 *    resolves into a directory the role may write;
 *  - paths are resolved against the cwd with `..` and symlinks followed (the
 *    realpath of the nearest existing ancestor), so `.foreman/../src/a.txt`
 *    and a symlink pointing out of the repo are caught.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Role } from "../../lib/roles.ts";

export type Verdict = { block: false } | { block: true; reason: string };

export interface GuardOptions {
	/** Temp dir that dev roles may redirect into. Defaults to os.tmpdir(). */
	tmpdir?: string;
}

type Kind = "readonly" | "scoped" | "shipper" | "dev" | "builder";

const KIND_BY_ROLE: Record<Role, Kind> = {
	planner: "readonly",
	reviewer: "readonly",
	qa: "scoped",
	"codebase-auditor": "scoped",
	shipper: "shipper",
	"frontend-dev": "dev",
	"backend-dev": "dev",
	"qa-bugfix": "dev",
	"plan-step-builder": "builder",
};

/** Role -> policy kind. An unknown role fails closed to read-only. */
export function kindOf(role: string | undefined): Kind {
	return role !== undefined && Object.hasOwn(KIND_BY_ROLE, role) ? KIND_BY_ROLE[role as Role] : "readonly";
}

export function isKnownRole(role: string | undefined): boolean {
	return role !== undefined && Object.hasOwn(KIND_BY_ROLE, role);
}

/** The guard is active only for a worker (FOREMAN_PI_SUBAGENT=1) that has a role. */
export function workerGuardActive(env: Record<string, string | undefined>): boolean {
	return env.FOREMAN_PI_SUBAGENT === "1" && !!env.FOREMAN_PI_ROLE?.trim();
}

const SUFFIX =
	' Do not retry it or work around it with another tool or command. Finish what you can and end your foreman-report with "Status: blocked" naming this reason.';

function deny(msg: string): Verdict {
	return { block: true, reason: `Blocked by the foreman worker guard: ${msg}.${SUFFIX}` };
}
const OK: Verdict = { block: false };

// --- context & path resolution ---------------------------------------------

interface Ctx {
	role: string;
	kind: Kind;
	root: string;
	tmp: string;
}

function realOrResolved(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function makeCtx(role: string | undefined, cwd: string, opts?: GuardOptions): Ctx {
	return {
		role: role ?? "",
		kind: kindOf(role),
		root: realOrResolved(cwd),
		tmp: realOrResolved(opts?.tmpdir ?? os.tmpdir()),
	};
}

/**
 * Resolve `p` against `base` (already real) the way the OS would: `..` pops the
 * real parent, symlinks are followed, a non-existent tail is appended as-is.
 * Returns null when it cannot be decided (dangling link, unreadable, NUL).
 */
export function resolveReal(base: string, p: string): string | null {
	let cur = path.isAbsolute(p) ? path.parse(p).root : base;
	for (const seg of p.split("/")) {
		if (!seg || seg === ".") continue;
		if (seg === "..") {
			cur = path.dirname(cur);
			continue;
		}
		const next = path.join(cur, seg);
		let st: fs.Stats;
		try {
			st = fs.lstatSync(next);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				cur = next;
				continue;
			}
			return null;
		}
		if (st.isSymbolicLink()) {
			try {
				cur = fs.realpathSync(next);
			} catch {
				return null;
			}
		} else {
			cur = next;
		}
	}
	return cur;
}

function inside(dir: string, p: string, strict = false): boolean {
	if (p === dir) return !strict;
	const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
	return p.startsWith(prefix);
}

function isRealEnvFile(base: string): boolean {
	if (base !== ".env" && !base.startsWith(".env.")) return false;
	return !/\.(example|sample|template|dist|tpl)$/.test(base);
}

/** Why `abs` may not be written by this role, or undefined when it may. */
function pathProblem(ctx: Ctx, abs: string | null, shown: string, allowTmp: boolean): string | undefined {
	if (abs === null) return `the path "${shown}" could not be resolved (dangling symlink or unreadable)`;
	const rel = inside(ctx.root, abs) ? path.relative(ctx.root, abs) : null;
	const segs = rel === null || rel === "" ? [] : rel.split(path.sep);
	switch (ctx.kind) {
		case "readonly":
			return isKnownRole(ctx.role)
				? `role "${ctx.role}" is read-only and may not write "${shown}"`
				: `unknown role "${ctx.role}" fails closed to read-only, so "${shown}" may not be written`;
		case "scoped":
		case "shipper": {
			if (segs[0] === ".foreman" && segs.length > 1) return undefined;
			if (ctx.kind === "scoped" && rel === "FOREMAN_AUDIT.md") return undefined;
			const allowed = ctx.kind === "scoped" ? ".foreman/ and FOREMAN_AUDIT.md" : ".foreman/";
			return `role "${ctx.role}" may only write under ${allowed}, but "${shown}" resolves to ${abs}`;
		}
		default: {
			if (rel === null) {
				if (allowTmp && inside(ctx.tmp, abs, true)) return undefined;
				return `"${shown}" resolves outside the repository (${abs})`;
			}
			if (segs.includes(".git")) return `writing into .git is not allowed ("${shown}")`;
			if (isRealEnvFile(path.basename(abs))) return `writing real .env files is not allowed ("${shown}"); .env.example and templates are fine`;
			return undefined;
		}
	}
}

// --- write / edit tool -----------------------------------------------------

export function checkWrite(role: string | undefined, cwd: string, target: unknown, opts?: GuardOptions): Verdict {
	if (typeof target !== "string" || !target.trim()) return deny("the write target path is missing");
	if (target.startsWith("~")) return deny(`the write target "${target}" starts with ~ and cannot be resolved; use a repo-relative path`);
	const ctx = makeCtx(role, cwd, opts);
	const problem = pathProblem(ctx, resolveReal(ctx.root, target), target, false);
	return problem ? deny(problem) : OK;
}

// --- shell parser ----------------------------------------------------------

interface Word {
	text: string;
	/** Contains $VAR, ${..}, $(..), backticks, arithmetic or ANSI-C escapes: value unknown. */
	dynamic: boolean;
	/** Unquoted glob or brace characters. */
	glob: boolean;
	/** Starts with an unquoted ~. */
	tilde: boolean;
}
interface Redirect {
	kind: "write" | "dup" | "read";
	target: Word | null;
}
interface Cmd {
	words: Word[];
	redirects: Redirect[];
	/** Commands joined by `|` share a pipeline id. */
	pipeline: number;
	pipeIn: boolean;
}
interface PState {
	cmds: Cmd[];
	counter: number;
}
class ParseError extends Error {}

const MAX_DEPTH = 4;

/** Index of the `)` matching an already-consumed `(`, scanning from `from`; -1 if unbalanced. */
function findParen(src: string, from: number): number {
	let depth = 1;
	const n = src.length;
	for (let j = from; j < n; j++) {
		const c = src[j];
		if (c === "\\") {
			j++;
		} else if (c === "'") {
			const k = src.indexOf("'", j + 1);
			if (k < 0) return -1;
			j = k;
		} else if (c === '"') {
			j++;
			while (j < n && src[j] !== '"') {
				if (src[j] === "\\") j++;
				else if (src[j] === "$" && src[j + 1] === "(") {
					const k = findParen(src, j + 2);
					if (k < 0) return -1;
					j = k;
				}
				j++;
			}
		} else if (c === "`") {
			let k = j + 1;
			while (k < n && src[k] !== "`") k += src[k] === "\\" ? 2 : 1;
			if (k >= n) return -1;
			j = k;
		} else if (c === "(") {
			depth++;
		} else if (c === ")") {
			depth--;
			if (depth === 0) return j;
		}
	}
	return -1;
}

function findBrace(src: string, from: number): number {
	let depth = 1;
	for (let j = from; j < src.length; j++) {
		if (src[j] === "\\") j++;
		else if (src[j] === "{") depth++;
		else if (src[j] === "}" && --depth === 0) return j;
	}
	return -1;
}

function checkArithmetic(inner: string): void {
	if (inner.includes("`") || inner.includes("$(")) throw new ParseError("command substitution inside arithmetic expansion is not supported");
}

/** Recurse into `$(...)` / backticks found in free text (heredoc bodies, ${...}). */
function scanSubstitutions(text: string, depth: number, st: PState): void {
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			i++;
		} else if (c === "$" && text[i + 1] === "(") {
			const e = findParen(text, i + 2);
			if (e < 0) throw new ParseError("unbalanced $( ... )");
			if (text[i + 2] === "(") checkArithmetic(text.slice(i + 2, e));
			else parseInto(text.slice(i + 2, e), depth + 1, st);
			i = e;
		} else if (c === "`") {
			let j = i + 1;
			while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
			if (j >= text.length) throw new ParseError("unbalanced backtick");
			parseInto(text.slice(i + 1, j).replace(/\\([`\\$])/g, "$1"), depth + 1, st);
			i = j;
		}
	}
}

function scanWord(src: string, start: number, depth: number, st: PState, testMode = false): { word: Word; end: number } {
	const n = src.length;
	let i = start;
	let text = "";
	let dynamic = false;
	let glob = false;
	const tilde = src[start] === "~";

	const dollar = (inDouble: boolean) => {
		const nx = src[i + 1];
		if (nx === "(") {
			const e = findParen(src, i + 2);
			if (e < 0) throw new ParseError("unbalanced $( ... )");
			if (src[i + 2] === "(") checkArithmetic(src.slice(i + 2, e));
			else parseInto(src.slice(i + 2, e), depth + 1, st);
			dynamic = true;
			text += "$(…)";
			i = e + 1;
		} else if (nx === "{") {
			const e = findBrace(src, i + 2);
			if (e < 0) throw new ParseError("unbalanced ${ ... }");
			scanSubstitutions(src.slice(i + 2, e), depth, st);
			dynamic = true;
			text += "${…}";
			i = e + 1;
		} else if (nx === "'" && !inDouble) {
			let j = i + 2;
			while (j < n && src[j] !== "'") j += src[j] === "\\" ? 2 : 1;
			if (j >= n) throw new ParseError("unbalanced quote");
			const body = src.slice(i + 2, j);
			text += body;
			if (body.includes("\\")) dynamic = true;
			i = j + 1;
		} else if (nx !== undefined && /[A-Za-z_]/.test(nx)) {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
			dynamic = true;
			text += src.slice(i, j);
			i = j;
		} else if (nx !== undefined && /[0-9@*#?$!-]/.test(nx)) {
			dynamic = true;
			text += src.slice(i, i + 2);
			i += 2;
		} else {
			text += "$";
			i++;
		}
	};
	const backtick = () => {
		let j = i + 1;
		while (j < n && src[j] !== "`") j += src[j] === "\\" ? 2 : 1;
		if (j >= n) throw new ParseError("unbalanced backtick");
		parseInto(src.slice(i + 1, j).replace(/\\([`\\$])/g, "$1"), depth + 1, st);
		dynamic = true;
		text += "`…`";
		i = j + 1;
	};

	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === ";") break;
		if (!testMode && (c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">")) break;
		if (c === "\\") {
			if (src[i + 1] === "\n") i += 2;
			else if (i + 1 < n) {
				text += src[i + 1];
				i += 2;
			} else i++;
		} else if (c === "'") {
			const j = src.indexOf("'", i + 1);
			if (j < 0) throw new ParseError("unbalanced single quote");
			text += src.slice(i + 1, j);
			i = j + 1;
		} else if (c === '"') {
			i++;
			let closed = false;
			while (i < n) {
				const d = src[i];
				if (d === '"') {
					closed = true;
					i++;
					break;
				}
				if (d === "\\") {
					const e = src[i + 1];
					if (e === undefined) i++;
					else if (e === "\n") i += 2;
					else if ('$`"\\'.includes(e)) {
						text += e;
						i += 2;
					} else {
						text += `\\${e}`;
						i += 2;
					}
				} else if (d === "`") backtick();
				else if (d === "$") dollar(true);
				else {
					text += d;
					i++;
				}
			}
			if (!closed) throw new ParseError("unbalanced double quote");
		} else if (c === "`") {
			backtick();
		} else if (c === "$") {
			dollar(false);
		} else {
			if (c === "*" || c === "?" || c === "[" || c === "{") glob = true;
			text += c;
			i++;
		}
	}
	return { word: { text, dynamic, glob, tilde }, end: i };
}

function parseInto(src: string, depth: number, st: PState): void {
	if (depth > MAX_DEPTH) throw new ParseError("command substitutions or `sh -c` strings are nested too deeply");
	const n = src.length;
	let i = 0;
	let pid = st.counter++;
	const newCmd = (pipeIn: boolean): Cmd => ({ words: [], redirects: [], pipeline: pid, pipeIn });
	let cur = newCmd(false);
	const heredocs: { delim: string; strip: boolean; expand: boolean }[] = [];
	let testMode = false;

	const endCmd = (pipe: boolean) => {
		if (cur.words.length || cur.redirects.length) st.cmds.push(cur);
		if (!pipe) pid = st.counter++;
		cur = newCmd(pipe);
	};

	const redirect = () => {
		if ((src[i] === "<" || src[i] === ">") && src[i + 1] === "(") throw new ParseError("process substitution (<( or >() is not allowed");
		let op: string;
		if (src[i] === "&") op = src.startsWith("&>>", i) ? "&>>" : "&>";
		else if (src[i] === ">") op = src.startsWith(">>", i) ? ">>" : src.startsWith(">|", i) ? ">|" : src.startsWith(">&", i) ? ">&" : ">";
		else
			op = src.startsWith("<<<", i)
				? "<<<"
				: src.startsWith("<<-", i)
					? "<<-"
					: src.startsWith("<<", i)
						? "<<"
						: src.startsWith("<&", i)
							? "<&"
							: src.startsWith("<>", i)
								? "<>"
								: "<";
		i += op.length;
		while (src[i] === " " || src[i] === "\t") i++;
		if (i >= n || /[;&|()<>\n]/.test(src[i])) throw new ParseError("a redirect has no target");
		const tStart = i;
		const { word, end } = scanWord(src, i, depth, st);
		i = end;
		if (op === "<<" || op === "<<-") {
			heredocs.push({ delim: word.text, strip: op === "<<-", expand: !/['"\\]/.test(src.slice(tStart, end)) });
			return;
		}
		let kind: Redirect["kind"];
		if (op === ">&") kind = !word.dynamic && /^(\d+|-)$/.test(word.text) ? "dup" : "write";
		else if (op === "<&") kind = "dup";
		else if (op === "<" || op === "<<<") kind = "read";
		else kind = "write";
		cur.redirects.push({ kind, target: word });
	};

	while (i < n) {
		const c = src[i];
		if (testMode) {
			if (c === " " || c === "\t") {
				i++;
			} else if (c === "\n" || c === ";") {
				testMode = false;
			} else {
				const { word, end } = scanWord(src, i, depth, st, true);
				i = end;
				cur.words.push(word);
				if (word.text === "]]") testMode = false;
			}
			continue;
		}
		if (c === " " || c === "\t") {
			i++;
		} else if (c === "#") {
			while (i < n && src[i] !== "\n") i++;
		} else if (c === "\n") {
			endCmd(false);
			i++;
			for (const h of heredocs.splice(0)) {
				let body = "";
				while (i < n) {
					const e = src.indexOf("\n", i);
					const line = e < 0 ? src.slice(i) : src.slice(i, e);
					i = e < 0 ? n : e + 1;
					if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
					body += `${line}\n`;
				}
				if (h.expand) scanSubstitutions(body, depth, st);
			}
		} else if (c === ";") {
			endCmd(false);
			i++;
		} else if (c === "&") {
			if (src[i + 1] === "&") {
				endCmd(false);
				i += 2;
			} else if (src[i + 1] === ">") redirect();
			else {
				endCmd(false);
				i++;
			}
		} else if (c === "|") {
			const len = src[i + 1] === "|" ? 2 : src[i + 1] === "&" ? 2 : 1;
			endCmd(len === 1 || src[i + 1] === "&");
			i += len;
		} else if (c === "(") {
			if (src[i + 1] === "(" && cur.words.length === 0) {
				const e = findParen(src, i + 1);
				if (e < 0) throw new ParseError("unbalanced ((");
				checkArithmetic(src.slice(i + 1, e));
				i = e + 1;
			} else {
				endCmd(false);
				i++;
			}
		} else if (c === ")") {
			endCmd(false);
			i++;
		} else if (c === "<" || c === ">") {
			redirect();
		} else if (/[0-9]/.test(c) && /^[0-9]+[<>]/.test(src.slice(i, i + 12))) {
			while (/[0-9]/.test(src[i])) i++;
			redirect();
		} else {
			const { word, end } = scanWord(src, i, depth, st);
			i = end;
			if (word.text === "[[" && cur.words.length === 0 && !word.dynamic) testMode = true;
			cur.words.push(word);
		}
	}
	endCmd(false);
}

// --- shell evaluation helpers ----------------------------------------------

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEAD_STRIP = new Set(["if", "while", "until", "then", "else", "elif", "do", "!", "{", "(", "time", "coproc"]);
const IGNORE_HEAD = new Set(["for", "case", "select", "done", "fi", "esac", "}", "in"]);
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "nice", "stdbuf", "timeout", "env", "xargs", "ionice", "setsid"]);
/** Wrapper options that take a separate value argument. */
const WRAPPER_OPT_ARGS: Record<string, string[]> = {
	env: ["-u", "-C", "-S", "--unset", "--chdir"],
	nice: ["-n", "--adjustment"],
	timeout: ["-k", "-s", "--kill-after", "--signal"],
	xargs: ["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"],
	stdbuf: ["-i", "-o", "-e"],
	ionice: ["-c", "-n", "-p"],
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set([...SHELLS, "python", "python3", "perl", "ruby", "node", "php"]);
const MUTATORS = new Set(["tee", "cp", "mv", "rm", "mkdir", "touch", "ln", "truncate", "install", "rmdir", "unlink", "shred"]);
const BUILD_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", "__pycache__"]);

interface Unwrapped {
	name: Word;
	args: Word[];
	wrappers: string[];
}

function unwrap(words: Word[]): Unwrapped | undefined {
	const wrappers: string[] = [];
	let i = 0;
	for (;;) {
		while (i < words.length && !words[i].dynamic && ASSIGN.test(words[i].text)) i++;
		if (i >= words.length) return undefined;
		const w = words[i];
		const base = w.dynamic ? "" : path.basename(w.text);
		if (!w.dynamic && WRAPPERS.has(base)) {
			wrappers.push(base);
			i++;
			const withArg = WRAPPER_OPT_ARGS[base] ?? [];
			while (i < words.length && !words[i].dynamic && words[i].text.startsWith("-") && words[i].text.length > 1) {
				const opt = words[i].text;
				i++;
				if (withArg.includes(opt)) i++;
			}
			if (base === "timeout" && i < words.length) i++;
			continue;
		}
		return { name: w, args: words.slice(i + 1), wrappers };
	}
}

const unresolvable = (w: Word) => w.dynamic || w.glob || w.tilde;

function operands(args: Word[]): Word[] {
	const out: Word[] = [];
	let dd = false;
	for (const w of args) {
		if (!dd && !w.dynamic && w.text === "--") dd = true;
		else if (!dd && !w.dynamic && w.text.startsWith("-") && w.text.length > 1) continue;
		else out.push(w);
	}
	return out;
}

function flagSet(args: Word[]): { short: Set<string>; long: Set<string> } {
	const short = new Set<string>();
	const long = new Set<string>();
	for (const w of args) {
		if (w.dynamic) continue;
		if (w.text === "--") break;
		if (w.text.startsWith("--")) long.add(w.text.split("=")[0]);
		else if (/^-[A-Za-z0-9]+$/.test(w.text)) for (const ch of w.text.slice(1)) short.add(ch);
	}
	return { short, long };
}

function hasInPlace(args: Word[]): boolean {
	for (const w of args) {
		if (w.dynamic) continue;
		if (w.text === "--") break;
		if (w.text === "--in-place" || w.text.startsWith("--in-place=")) return true;
		if (/^-[A-Za-z]*i/.test(w.text) && !w.text.startsWith("--")) return true;
	}
	return false;
}

function argPathProblem(ctx: Ctx, w: Word, allowTmp: boolean): string | undefined {
	if (unresolvable(w)) return `the path argument "${w.text}" contains a variable, glob, ~ or substitution and cannot be resolved`;
	return pathProblem(ctx, resolveReal(ctx.root, w.text), w.text, allowTmp);
}

function redirectProblem(ctx: Ctx, t: Word | null): string | undefined {
	if (!t) return "a redirect has no target";
	if (!unresolvable(t)) {
		if (t.text === "/dev/null") return undefined;
		if (ctx.kind !== "readonly" && (/^\/dev\/(stderr|stdout|tty)$/.test(t.text) || /^\/dev\/fd\/\d+$/.test(t.text))) return undefined;
	}
	if (ctx.kind === "readonly") return `role "${ctx.role}" is read-only and may not redirect output to "${t.text}" (only /dev/null is allowed)`;
	if (unresolvable(t)) return `the redirect target "${t.text}" contains a variable, glob, ~ or substitution and cannot be resolved`;
	return pathProblem(ctx, resolveReal(ctx.root, t.text), t.text, true);
}

// --- git / gh ---------------------------------------------------------------

const GIT_READ_SUBS = new Set([
	"log", "diff", "show", "status", "rev-parse", "merge-base", "ls-files", "blame", "rev-list", "ls-tree",
	"cat-file", "describe", "shortlog", "grep", "show-ref", "name-rev", "diff-tree", "diff-index", "branch",
]);
const GIT_BRANCH_READ_FLAGS = new Set(["--show-current", "--list", "-l", "-a", "-r", "-v", "-vv", "--all", "--remotes"]);

function gitParse(args: Word[], restricted: boolean): { sub: string; rest: Word[] } | string {
	let i = 0;
	while (i < args.length) {
		const w = args[i];
		if (w.dynamic) return "the git subcommand or option is built from a variable and cannot be checked";
		const t = w.text;
		if (!t.startsWith("-")) break;
		if (t === "-C") i += 2;
		else if (t === "-c" || t.startsWith("--git-dir") || t.startsWith("--work-tree") || t.startsWith("--exec-path")) {
			if (restricted) return `git option "${t}" is not allowed for this role`;
			i += t === "-c" || t === "--git-dir" || t === "--work-tree" ? 2 : 1;
		} else if (["--no-pager", "-P", "-p", "--paginate", "--no-optional-locks", "--bare", "--no-replace-objects", "--literal-pathspecs"].includes(t)) i++;
		else return `unsupported git option "${t}"`;
	}
	const sub = args[i];
	if (!sub) return { sub: "", rest: [] };
	if (sub.dynamic) return "the git subcommand is built from a variable and cannot be checked";
	return { sub: sub.text, rest: args.slice(i + 1) };
}

function gitReadOnlyProblem(role: string, args: Word[]): string | undefined {
	const p = gitParse(args, true);
	if (typeof p === "string") return p;
	if (!p.sub) return undefined;
	if (!GIT_READ_SUBS.has(p.sub)) return `"git ${p.sub}" is not allowed for role "${role}" (read-only git only: log, diff, show, status, rev-parse, merge-base, ls-files, blame, branch --show-current)`;
	for (const w of p.rest) {
		if (w.dynamic) continue;
		if (w.text.startsWith("--output")) return `"git ${p.sub} ${w.text}" writes a file and is not allowed`;
		if (p.sub === "grep" && (w.text.startsWith("-O") || w.text.startsWith("--open-files"))) return "git grep -O would run a pager command and is not allowed";
	}
	if (p.sub === "branch") {
		for (const w of p.rest) {
			if (w.dynamic || (w.text.startsWith("-") && !GIT_BRANCH_READ_FLAGS.has(w.text))) return `only "git branch --show-current" (or listing flags) is allowed, not "git branch ${w.text}"`;
			if (!w.text.startsWith("-")) return `"git branch ${w.text}" would create or change a branch`;
		}
	}
	return undefined;
}

function gitDangerProblem(args: Word[]): string | undefined {
	const p = gitParse(args, false);
	if (typeof p === "string") return p;
	for (const w of p.rest) if (!w.dynamic && w.text === "--no-verify") return "--no-verify skips hooks and is not allowed";
	const { short, long } = flagSet(p.rest);
	const ops = operands(p.rest);
	switch (p.sub) {
		case "push":
			if (short.has("f") || long.has("--force") || long.has("--force-with-lease") || long.has("--force-if-includes") || ops.some((o) => !o.dynamic && o.text.startsWith("+")))
				return "force-pushing is not allowed";
			break;
		case "reset":
			if (long.has("--hard")) return "git reset --hard is not allowed";
			break;
		case "clean":
			if (!short.has("n") && !long.has("--dry-run")) return "git clean is not allowed";
			break;
		case "checkout":
		case "restore":
			if (ops.some((o) => o.glob || (!o.dynamic && (o.text === "." || o.text === ":/")))) return `git ${p.sub} on the whole tree discards work and is not allowed`;
			break;
		case "branch":
			if (short.has("D") || ((short.has("d") || long.has("--delete")) && (short.has("f") || long.has("--force")))) return "force-deleting a branch is not allowed";
			break;
		case "commit":
			if (short.has("n")) return "git commit -n (--no-verify) is not allowed";
			break;
	}
	return undefined;
}

function ghReadOnlyProblem(role: string, args: Word[]): string | undefined {
	const ops = operands(args);
	const [a, b] = ops.map((o) => (o.dynamic ? "" : o.text));
	const ok = (a === "pr" && ["view", "list", "diff", "checks"].includes(b)) || (a === "issue" && b === "view");
	return ok ? undefined : `"gh ${a ?? ""} ${b ?? ""}" is not allowed for role "${role}" (read-only: pr view/list/diff/checks, issue view)`.replace("  ", " ");
}

// --- per-kind command policy ---------------------------------------------------

const READONLY_CMDS = new Set([
	"cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "sort", "uniq", "cut", "tr", "diff", "cmp",
	"stat", "file", "pwd", "echo", "printf", "true", "false", "test", "[", "[[", ":", "which", "type", "realpath", "readlink",
	"dirname", "basename", "tree", "du", "df", "sed", "jq", "date", "uname", "whoami", "id", "hostname", "nproc", "cd",
	"column", "nl", "tac", "rev", "fold", "expand", "md5sum", "sha1sum", "sha256sum", "xxd", "hexdump", "od", "strings",
	"comm", "join", "paste", "seq", "sleep", "git", "gh",
]);
const FIND_BAD = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const SED_UNSAFE = /(^|[;{}\n/\s\d$])[we]($|\s)/;

function readonlyProblem(ctx: Ctx, name: string, args: Word[]): string | undefined {
	if (!READONLY_CMDS.has(name)) {
		return `the command "${name}" is not on the read-only allowlist for role "${ctx.role}"${isKnownRole(ctx.role) ? "" : " (unknown role, failing closed)"}`;
	}
	const { short, long } = flagSet(args);
	switch (name) {
		case "find": {
			const bad = args.find((w) => !w.dynamic && FIND_BAD.has(w.text));
			if (bad) return `"find ${bad.text}" can run commands or write files and is not allowed`;
			break;
		}
		case "sed":
			if (hasInPlace(args) || long.has("--file") || short.has("f")) return "sed -i / -f is not allowed for a read-only role";
			if (operands(args).some((o) => !o.dynamic && SED_UNSAFE.test(o.text))) return "sed scripts with w/e commands can write or execute and are not allowed";
			break;
		case "sort":
			if (short.has("o") || long.has("--output")) return "sort -o writes a file and is not allowed";
			break;
		case "uniq":
			if (operands(args).length > 1) return "uniq with an output file operand is not allowed";
			break;
		case "tree":
			if (short.has("o")) return "tree -o writes a file and is not allowed";
			break;
		case "rg":
			if (args.some((w) => !w.dynamic && w.text.startsWith("--pre"))) return "rg --pre runs a command and is not allowed";
			break;
		case "git":
			return gitReadOnlyProblem(ctx.role, args);
		case "gh":
			return ghReadOnlyProblem(ctx.role, args);
	}
	return undefined;
}

function scopedProblem(ctx: Ctx, name: string, args: Word[], un: Unwrapped): string | undefined {
	if (un.wrappers.includes("xargs")) return "xargs can run any command on unknown paths and is not allowed";
	if (name === "sed" && hasInPlace(args)) return "sed -i edits files in place and is not allowed";
	if (name === "perl" && hasInPlace(args)) return "perl -i edits files in place and is not allowed";
	if (name === "patch" || name === "dd") return `"${name}" can write arbitrary files and is not allowed`;
	if (name === "git") return ctx.kind === "shipper" ? gitDangerProblem(args) : gitReadOnlyProblem(ctx.role, args);
	if (name === "gh") return ctx.kind === "shipper" ? undefined : ghReadOnlyProblem(ctx.role, args);
	if (MUTATORS.has(name)) {
		for (const w of operands(args)) {
			const p = argPathProblem(ctx, w, false);
			if (p) return `"${name}": ${p}`;
		}
	}
	return undefined;
}

function rmProblem(ctx: Ctx, args: Word[], viaXargs: boolean): string | undefined {
	const { short, long } = flagSet(args);
	const recursive = short.has("r") || short.has("R") || long.has("--recursive");
	const ops = operands(args);
	if (viaXargs) ops.push({ text: "<xargs input>", dynamic: true, glob: false, tilde: false });
	if (!recursive) {
		for (const w of ops) {
			if (unresolvable(w)) continue;
			const p = pathProblem(ctx, resolveReal(ctx.root, w.text), w.text, true);
			if (p) return `"rm": ${p}`;
		}
		return undefined;
	}
	for (const w of ops) {
		if (unresolvable(w)) return `"rm -r" target "${w.text}" contains a variable, glob, ~ or substitution and cannot be resolved`;
		const abs = resolveReal(ctx.root, w.text);
		if (abs === null) return `"rm -r" target "${w.text}" could not be resolved`;
		if (inside(abs, ctx.root)) return `"rm -r ${w.text}" would delete the repository root or one of its ancestors`;
		if (inside(ctx.root, abs)) {
			const segs = path.relative(ctx.root, abs).split(path.sep);
			if (segs.includes(".git")) return `"rm -r ${w.text}" would delete .git`;
			if (ctx.kind === "dev" && !segs.some((s) => BUILD_DIRS.has(s))) {
				return `"rm -r ${w.text}": this role may only recursively delete build-artifact directories (${[...BUILD_DIRS].join(", ")}) or temp files`;
			}
		} else if (!inside(ctx.tmp, abs, true)) {
			return `"rm -r ${w.text}" resolves outside the repository (${abs})`;
		}
	}
	return undefined;
}

function devProblem(ctx: Ctx, name: string, args: Word[], un: Unwrapped): string | undefined {
	const { short, long } = flagSet(args);
	if (name === "chmod" && (short.has("R") || long.has("--recursive"))) return "chmod -R is not allowed";
	if (name.startsWith("mkfs")) return "mkfs is not allowed";
	if (name === "dd" && args.some((w) => !w.dynamic ? w.text.startsWith("of=/dev/") : w.text.startsWith("of="))) return "dd writing to a device is not allowed";
	if (["npm", "pnpm", "yarn", "bun"].includes(name) && (short.has("g") || long.has("--global") || args.some((w) => !w.dynamic && w.text === "global")))
		return "global package installs are not allowed";
	if (name === "git") return gitDangerProblem(args);
	if (name === "rm") return rmProblem(ctx, args, un.wrappers.includes("xargs"));
	if (MUTATORS.has(name)) {
		const ops = operands(args).filter((w) => !unresolvable(w));
		const destOnly = ["cp", "install", "ln"].includes(name) && !short.has("t") && !long.has("--target-directory");
		const targets = destOnly ? ops.slice(-1) : ops;
		for (const w of targets) {
			const p = pathProblem(ctx, resolveReal(ctx.root, w.text), w.text, true);
			if (p) return `"${name}": ${p}`;
		}
	}
	return undefined;
}

function evalCmd(ctx: Ctx, cmd: Cmd, all: Cmd[], depth: number): string | undefined {
	for (const r of cmd.redirects) {
		if (r.kind !== "write") continue;
		const p = redirectProblem(ctx, r.target);
		if (p) return p;
	}
	let words = [...cmd.words];
	for (;;) {
		if (words.length && !words[0].dynamic && words[0].text === "function") words = words.slice(2);
		else if (words.length && !words[0].dynamic && HEAD_STRIP.has(words[0].text)) words.shift();
		else break;
	}
	if (words.length && !words[0].dynamic && IGNORE_HEAD.has(words[0].text)) return undefined;
	const un = unwrap(words);
	if (!un) return undefined;
	if (un.name.dynamic) return "the command name is built from a variable or substitution and cannot be checked";
	const name = path.basename(un.name.text);
	const args = un.args;
	if (name === "eval") return "`eval` is not allowed";
	if (["sudo", "su", "doas"].includes(name)) return "privilege escalation (sudo/su/doas) is not allowed";
	if (ctx.kind === "readonly") {
		if (un.wrappers.length) return `the wrapper "${un.wrappers[0]}" is not allowed for role "${ctx.role}"`;
		return readonlyProblem(ctx, name, args);
	}
	// `sh -c "<script>"`: judge the inner script like any other command string.
	if (SHELLS.has(name)) {
		const ci = args.findIndex((w) => !w.dynamic && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
		if (ci >= 0 && args[ci + 1]) {
			const script = args[ci + 1];
			if (script.dynamic) return `the "${name} -c" script is built from a variable or substitution and cannot be checked`;
			return evalScript(ctx, script.text, depth + 1);
		}
	}
	// `curl ... | sh` and friends.
	if (INTERPRETERS.has(name) && cmd.pipeIn && all.some((c) => c.pipeline === cmd.pipeline && c !== cmd && c.words.some((w) => !w.dynamic && ["curl", "wget"].includes(path.basename(w.text)))))
		return "piping downloaded content into an interpreter is not allowed";
	return ctx.kind === "scoped" || ctx.kind === "shipper" ? scopedProblem(ctx, name, args, un) : devProblem(ctx, name, args, un);
}

function evalScript(ctx: Ctx, script: string, depth: number): string | undefined {
	const st: PState = { cmds: [], counter: 0 };
	try {
		parseInto(script, depth, st);
	} catch (e) {
		return e instanceof ParseError ? `the command could not be parsed safely (${e.message})` : "the command could not be parsed safely";
	}
	for (const c of st.cmds) {
		const p = evalCmd(ctx, c, st.cmds, depth);
		if (p) return p;
	}
	return undefined;
}

export function checkBash(role: string | undefined, cwd: string, command: unknown, opts?: GuardOptions): Verdict {
	if (typeof command !== "string") return deny("the bash command is missing");
	const ctx = makeCtx(role, cwd, opts);
	const problem = evalScript(ctx, command, 0);
	return problem ? deny(problem) : OK;
}
