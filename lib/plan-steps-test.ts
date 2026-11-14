import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findParallelOverlaps, parseStepTitle, parseTouches, readOverlapsFor, readStepTitle, TITLE_MAX } from "./plan-steps.ts";
let failures = 0;
const check = (n: string, ok: boolean) => { if (!ok) { failures++; console.log(`FAIL - ${n}`); } };
const md = [
	"### Phase 1",
	"1. **BlackAds env var, with fallback** (Touches: `app/config.py`)",
	"   - Action: 2. **not a step** inside a bullet",
	"12. **Carousel backend** (Touches: x)",
	"13. **`lib/mode.ts`:** (new)",
	"14. **" + "x".repeat(80) + "**",
	"15. plain text step without bold",
].join("\n");
check("simple title", parseStepTitle(md, 1) === "BlackAds env var, with fallback");
check("two-digit step is not confused with step 1", parseStepTitle(md, 12) === "Carousel backend");
check("backticks and trailing colon stripped", parseStepTitle(md, 13) === "lib/mode.ts");
check("long title truncated with ellipsis", parseStepTitle(md, 14)!.length === TITLE_MAX && parseStepTitle(md, 14)!.endsWith("…"));
check("missing or unbolded step -> undefined", parseStepTitle(md, 2) === undefined && parseStepTitle(md, 15) === undefined && parseStepTitle(md, 99) === undefined);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-steps-"));
fs.mkdirSync(path.join(root, "docs", "plans"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "plans", "my-plan.md"), md);
check("reads docs/plans/<slug>.md", readStepTitle(root, "my-plan", 12) === "Carousel backend");
check("accepts a .md slug", readStepTitle(root, "my-plan.md", 12) === "Carousel backend");
check("missing file / slug / step -> undefined", readStepTitle(root, "nope", 1) === undefined && readStepTitle(root, undefined, 1) === undefined && readStepTitle(root, "my-plan", undefined) === undefined);
check("path traversal rejected", readStepTitle(root, "../my-plan", 1) === undefined && readStepTitle(root, "a/b", 1) === undefined);

const wave = [
	"## Steps",
	"1. **Alpha** (Touches: `lib/a.ts`, `lib/shared.ts`)",
	"2. **Beta** (Touches: `lib/shared.ts`)",
	"## Parallel",
	"3. **Gamma** (Touches: `lib/a.ts`, `docs/x.md`)",
	"4. **Delta** (Touches: `lib/shared.ts`, `lib/b.ts`)",
	"5. **Eps** (Touches: `src/`)",
	"6. **Zeta** (Touches: `src/deep/f.ts`)",
	"7. **Eta** (Touches: `other/f.ts`)",
	"## Later",
	"8. **Theta** (Touches: `lib/a.ts`)",
].join("\n");
const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
check("parseTouches reads a backticked list", same(parseTouches(wave, 1) ?? [], ["lib/a.ts", "lib/shared.ts"]) && parseTouches(wave, 99) === undefined);
const ov = findParallelOverlaps(wave);
check("disjoint wave steps are not flagged", !ov.some((o) => o.a === 3 || o.b === 3 || o.a === 7 || o.b === 7));
check("findParallelOverlaps ignores steps outside ## Parallel", !ov.some((o) => [1, 2, 8].includes(o.a) || [1, 2, 8].includes(o.b)));
check("directory prefix counts as overlap", ov.length === 1 && ov[0].a === 5 && ov[0].b === 6);
const wave2 = wave.replace("`docs/x.md`", "`docs/x.md`, `lib/shared.ts`");
check("findParallelOverlaps flags two wave steps sharing a file", findParallelOverlaps(wave2).some((o) => o.a === 3 && o.b === 4 && o.paths.includes("lib/shared.ts")));
check("no Parallel section -> no overlaps", findParallelOverlaps(md).length === 0 && findParallelOverlaps("").length === 0);
fs.mkdirSync(path.join(root, "docs", "plans"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "plans", "wave.md"), wave2);
check("readOverlapsFor finds the other step, absent plan is empty", same(readOverlapsFor(root, "wave", 4).map((o) => o.other), [3]) && readOverlapsFor(root, "nope", 4).length === 0 && readOverlapsFor(root, "wave", 1).length === 0);
fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("plan-steps: ok");
