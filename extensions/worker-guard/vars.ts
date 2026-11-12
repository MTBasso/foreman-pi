/**
 * Literal-variable resolution for the worker guard.
 *
 * The guard denies any path containing `$VAR`, because it cannot know the
 * value. The most common false block is a variable that is assigned a plain
 * literal one line earlier (`D=.foreman/x; mkdir -p $D/seed`). This rewrites
 * `$D` / `${D}` to the literal ONLY when it is provably safe, so the guard then
 * judges the real path. Anything it is unsure about is left untouched (the
 * guard still denies it): this can only turn a false block into an allow when
 * the value is certain.
 *
 * Rules (all must hold for a name to be substituted):
 *  - the command has no subshell/brace groups, backticks, `$(`, compound
 *    keywords (if/while/for/case/...), `&&`, `||`, `|`, or `&` (assignment
 *    might not run, or run in a subshell);
 *  - the assignment is a whole statement `NAME=literal` / `export NAME=literal`
 *    starting at the beginning of the command or after `;` / newline;
 *  - literal is [A-Za-z0-9_./:@%+,=-]+ (optionally in one pair of quotes): no
 *    `$`, `~`, glob, whitespace or escapes;
 *  - the name is assigned exactly once and never appears as a bare word
 *    elsewhere (no reassign, read, for, unset, declare, local, ...);
 *  - substitution happens only after the assignment, outside single quotes and
 *    heredoc bodies, and never for a backslash-escaped `\$`.
 */

const LITERAL = /^[A-Za-z0-9_./:@%+,=-]+$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPOUND = /(^|[\s;])(if|then|else|elif|fi|while|until|do|done|for|case|esac|select|function|coproc|time|eval|source|\.|trap|alias)(?=[\s;]|$)/;

interface Stmt {
	text: string;
	start: number;
	end: number;
}

/** Split into top-level statements by `;` / newline outside quotes, skipping heredoc bodies. Null when unsure. */
function statements(src: string): { stmts: Stmt[]; opaque: Array<[number, number]> } | null {
	const stmts: Stmt[] = [];
	const opaque: Array<[number, number]> = [];
	let i = 0;
	let start = 0;
	let single = false;
	let double = false;
	const pending: Array<{ word: string; dash: boolean }> = [];
	const n = src.length;
	const push = (end: number) => {
		stmts.push({ text: src.slice(start, end), start, end });
	};
	while (i < n) {
		const c = src[i];
		if (single) {
			if (c === "'") single = false;
			i++;
			continue;
		}
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (double) {
			if (c === '"') double = false;
			i++;
			continue;
		}
		if (c === "'") {
			single = true;
			i++;
			continue;
		}
		if (c === '"') {
			double = true;
			i++;
			continue;
		}
		if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
			const m = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(src.slice(i));
			if (!m) return null;
			pending.push({ word: m[2] ?? m[3] ?? m[4], dash: m[1] === "-" });
			i += m[0].length;
			continue;
		}
		if (c === "#" && (i === 0 || /[\s;]/.test(src[i - 1]))) {
			const e = src.indexOf("\n", i);
			i = e < 0 ? n : e;
			continue;
		}
		if (c === ";" || c === "\n") {
			push(i);
			i++;
			start = i;
			if (c === "\n" && pending.length) {
				const bodyStart = i;
				for (const h of pending) {
					for (;;) {
						if (i >= n) return null; // unterminated heredoc
						let e = src.indexOf("\n", i);
						if (e < 0) e = n;
						const line = src.slice(i, e);
						i = Math.min(n, e + 1);
						if ((h.dash ? line.replace(/^\t+/, "") : line) === h.word) break;
					}
				}
				pending.length = 0;
				opaque.push([bodyStart, i]);
				start = i;
			}
			continue;
		}
		i++;
	}
	if (single || double) return null;
	push(n);
	return { stmts, opaque };
}

/** Replace $NAME / ${NAME} outside single quotes in `text`; returns the new text. */
function substitute(text: string, name: string, value: string): string {
	let out = "";
	let single = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (single) {
			out += c;
			if (c === "'") single = false;
			continue;
		}
		if (c === "'") {
			single = true;
			out += c;
			continue;
		}
		if (c === "\\") {
			out += c + (text[i + 1] ?? "");
			i++;
			continue;
		}
		if (c === "$") {
			const braced = text[i + 1] === "{" && text.startsWith(name + "}", i + 2);
			const plain = text.startsWith(name, i + 1) && !/[A-Za-z0-9_]/.test(text[i + 1 + name.length] ?? "");
			if (braced) {
				out += value;
				i += name.length + 2;
				continue;
			}
			if (plain) {
				out += value;
				i += name.length;
				continue;
			}
		}
		out += c;
	}
	return out;
}

export function resolveLiteralVars(command: string): string {
	if (!command.includes("$")) return command;
	if (/[`()]|\$\(|&|\|/.test(command.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "$X"))) return command;
	if (COMPOUND.test(command)) return command;
	const parsed = statements(command);
	if (!parsed) return command;

	const assigns = new Map<string, { value: string; stmtIndex: number }>();
	const dupes = new Set<string>();
	parsed.stmts.forEach((s, idx) => {
		if (parsed.opaque.some(([a, b]) => s.start >= a && s.start < b)) return;
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(s.text);
		if (!m || !NAME.test(m[1])) return;
		let v = m[2];
		const q = /^(['"])(.*)\1$/.exec(v);
		if (q) v = q[2];
		if (!LITERAL.test(v)) return;
		if (assigns.has(m[1])) dupes.add(m[1]);
		assigns.set(m[1], { value: v, stmtIndex: idx });
	});

	let out = command;
	// Apply from the last statement backwards so earlier offsets stay valid.
	for (const [name, a] of assigns) {
		if (dupes.has(name)) continue;
		// A bare-word mention (read NAME, for NAME, unset NAME, NAME+=...) other than the one assignment is unsafe.
		const bare = new RegExp(`(^|[^$A-Za-z0-9_{])${name}(?![A-Za-z0-9_}])`, "g");
		const asg = new RegExp(`(^|[\\s;])(?:export\\s+)?${name}=`, "g");
		const bareHits = (command.match(bare) ?? []).length;
		const asgHits = (command.match(asg) ?? []).length;
		if (bareHits > asgHits) continue;
		const edits: Array<[number, number]> = [];
		parsed.stmts.forEach((s, idx) => {
			if (idx <= a.stmtIndex) return;
			if (parsed.opaque.some(([x, y]) => s.start >= x && s.start < y)) return;
			edits.push([s.start, s.end]);
		});
		for (const [s0, e0] of edits.reverse()) out = out.slice(0, s0) + substitute(out.slice(s0, e0), name, a.value) + out.slice(e0);
	}
	return out;
}
