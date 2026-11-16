import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeTaskArg, workerFooter } from "./handoff-footer.ts";
import { MAX_INLINE_PROMPT_BYTES, inlineOrPointerPrompt } from "./spawn.ts";
import { resumePreamble } from "./retry.ts";
import { tokensOf } from "./usage.ts";

let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };

{
	const f = workerFooter({ locale: "en", cwd: "/work/repo" });
	check("footer contains language, mode and workdir lines",
		/^User language: en\./m.test(f) && /Orchestrator mode does not apply to you/.test(f) && /^Working directory: \/work\/repo$/m.test(f) && /Shared worker rules/.test(f));
	check("pt-BR locale yields pt-BR", /^User language: pt-BR\./m.test(workerFooter({ locale: "pt-BR", cwd: "/x" })));
	check("footer is under 90 tokens", tokensOf(f) < 90 && f.split("\n").length <= 6);
	check("isolated cwd appears in the footer", workerFooter({ locale: "en", cwd: "/tmp/wt-iso/t1" }).includes("Working directory: /tmp/wt-iso/t1"));
}
{
	const footer = workerFooter({ locale: "en", cwd: "/w" });
	const pre = resumePreamble(1);
	const arg = composeTaskArg({ handoff: "DO THE THING", resume: pre, footer });
	check("composeTaskArg puts resume preamble before handoff and footer last",
		arg.startsWith("Task: ") && arg.indexOf(pre) < arg.indexOf("DO THE THING") && arg.indexOf("DO THE THING") < arg.indexOf(footer) && arg.endsWith(footer));
	const plain = composeTaskArg({ handoff: "H", footer });
	check("composeTaskArg without resume has no preamble", plain === `Task: H\n\n${footer}`);
}
{
	const dir = mkdtempSync(join(tmpdir(), "foreman-footer-"));
	try {
		const big = "x".repeat(MAX_INLINE_PROMPT_BYTES + 10);
		const pointer = inlineOrPointerPrompt(big, dir, "t1");
		const footer = workerFooter({ locale: "en", cwd: "/w" });
		const arg = composeTaskArg({ handoff: pointer, footer });
		check("pointer-prompt handoff still gets the footer", arg.includes("too large to inline") && arg.endsWith(footer) && !arg.includes(big));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log("all checks passed");
