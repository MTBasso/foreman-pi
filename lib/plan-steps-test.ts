import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseStepTitle, readStepTitle, TITLE_MAX } from "./plan-steps.ts";
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
fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("plan-steps: ok");
