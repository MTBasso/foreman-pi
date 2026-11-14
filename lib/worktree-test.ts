import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { blockReport, createWorktree, finishWorktree, isolateMode, resolveWorkdir, retargetPrompt, shouldIsolate } from "./worktree.ts";

let failures = 0;
const check = (n: string, ok: boolean, d?: unknown) => { if (!ok) { failures++; console.log(`FAIL - ${n}${d ? ` (${String(d)})` : ""}`); } };

check("mode default auto", isolateMode({}) === "auto");
check("mode never", isolateMode({ FOREMAN_ISOLATE: "never" }) === "never");
check("auto: first writer shares", !shouldIsolate("backend-dev", 0, "auto"));
check("auto: second writer isolates", shouldIsolate("backend-dev", 1, "auto"));
check("always isolates the first", shouldIsolate("frontend-dev", 0, "always"));
check("never isolates nothing", !shouldIsolate("backend-dev", 3, "never"));
check("readers never isolate", !shouldIsolate("qa", 3, "always") && !shouldIsolate("reviewer", 1, "always"));

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foreman-wt-")));
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf-8" }).trim();
g(root, "init", "-q", "-b", "main");
fs.writeFileSync(`${root}/shared.txt`, "base\n");
fs.writeFileSync(`${root}/a.txt`, "a\n");
g(root, "add", "-A"); g(root, "commit", "-qm", "init");
// A hook that must not fire for worktree creation or merges.
fs.mkdirSync(`${root}/.git/hooks`, { recursive: true });
fs.writeFileSync(`${root}/.git/hooks/post-checkout`, `#!/bin/sh\ntouch "${root}/HOOK_FIRED"\n`, { mode: 0o755 });
fs.writeFileSync(`${root}/.git/hooks/post-merge`, `#!/bin/sh\ntouch "${root}/HOOK_FIRED"\n`, { mode: 0o755 });

const w1 = createWorktree(root, "t1-backend-dev")!;
const w2 = createWorktree(root, "t2-frontend-dev")!;
check("worktrees created", !!w1 && !!w2 && fs.existsSync(w1.path) && fs.existsSync(w2.path));
check("hooks did not fire on create", !fs.existsSync(`${root}/HOOK_FIRED`));
check(".foreman excluded from git status", !g(root, "status", "--porcelain").includes(".foreman"));

// parallel disjoint edits; w1 commits, w2 leaves work uncommitted
fs.writeFileSync(`${w1.path}/one.txt`, "1\n"); g(w1.path, "add", "one.txt"); g(w1.path, "commit", "-qm", "one");
fs.writeFileSync(`${w2.path}/two.txt`, "2\n");
const [r1, r2] = await Promise.all([finishWorktree(w1, "t1"), finishWorktree(w2, "t2")]);
check("both merge", r1.merged && r2.merged, JSON.stringify([r1, r2]));
check("both files present on main", fs.existsSync(`${root}/one.txt`) && fs.existsSync(`${root}/two.txt`));
check("uncommitted work was kept", fs.readFileSync(`${root}/two.txt`, "utf-8") === "2\n");
check("worktrees and branches removed", !fs.existsSync(w1.path) && g(root, "branch", "--list", "foreman/*") === "");
check("hooks did not fire on merge", !fs.existsSync(`${root}/HOOK_FIRED`));

// conflict
const c1 = createWorktree(root, "t3-x")!, c2 = createWorktree(root, "t4-y")!;
fs.writeFileSync(`${c1.path}/shared.txt`, "from c1\n"); g(c1.path, "commit", "-qam", "c1");
fs.writeFileSync(`${c2.path}/shared.txt`, "from c2\n"); g(c2.path, "commit", "-qam", "c2");
const m1 = await finishWorktree(c1, "t3"); const m2 = await finishWorktree(c2, "t4");
check("first merges", m1.merged);
check("second conflicts and is aborted", !m2.merged && /shared\.txt/.test((m2 as any).conflict), JSON.stringify(m2));
check("main is clean after abort", g(root, "status", "--porcelain") === "");
check("conflicting worktree kept", fs.existsSync(c2.path) && g(root, "branch", "--list", "foreman/t4-y").includes("t4-y"));

// no-op worker
const n = createWorktree(root, "t5-z")!;
const mn = await finishWorktree(n, "t5");
check("no-op merges with 0 commits", mn.merged && (mn as any).commits === 0 && !fs.existsSync(n.path));

// prompt + report rewriting
const rp = retargetPrompt(`edit ${root}/src/a.ts, read ${root}/.foreman/runs/r/t1.md`, w1);
check("repo paths retargeted", rp.includes(`${w1.path}/src/a.ts`));
check(".foreman paths untouched", rp.includes(`${root}/.foreman/runs/r/t1.md`) && !rp.includes(`${w1.path}/.foreman`));
const br = blockReport("did stuff\n--- foreman-report ---\nStatus: completed\nSummary: x\nBlocked-on: none\n--- end foreman-report ---", "conflict in a", w1);
check("blockReport flips status", br.startsWith("[BLOCKED]") && /Status: blocked/.test(br) && /Blocked-on: conflict in a/.test(br));

// --- step 4: linked-worktree base, env dirs, safe rewriting, resolveWorkdir ---
g(root, "branch", "plan-branch");
const planWt = path.join(root, ".worktrees", "plan-slug");
g(root, "worktree", "add", "-q", planWt, "plan-branch");
const mainHeadBefore = g(root, "rev-parse", "HEAD");
fs.writeFileSync(`${root}/.gitignore`, ".venv/\nnode_modules/\n");
g(root, "add", ".gitignore"); g(root, "commit", "-qm", "ignore env");
g(planWt, "merge", "-q", "main");
fs.mkdirSync(`${planWt}/.venv`); fs.writeFileSync(`${planWt}/.venv/marker`, "v\n");
fs.mkdirSync(`${planWt}/node_modules`); fs.writeFileSync(`${planWt}/node_modules/marker`, "n\n");
fs.mkdirSync(`${planWt}/venv`); fs.writeFileSync(`${planWt}/venv/marker`, "x\n"); // not ignored
const mainHead = g(root, "rev-parse", "HEAD");
const lw = createWorktree(planWt, "t9-builder")!;
check("linked-root worktree created", !!lw && fs.existsSync(lw.path), JSON.stringify(lw));
check("linked-root exclude resolves to the shared file", g(planWt, "rev-parse", "--git-path", "info/exclude").endsWith("info/exclude") && fs.readFileSync(path.resolve(planWt, g(planWt, "rev-parse", "--git-path", "info/exclude")), "utf-8").includes(".foreman/"));
check(".foreman excluded in the linked worktree status", !g(planWt, "status", "--porcelain").includes(".foreman"), g(planWt, "status", "--porcelain"));
fs.writeFileSync(`${lw.path}/lw.txt`, "lw\n");
const lm = await finishWorktree(lw, "t9");
check("worktree from a linked-worktree root merges back into that worktree's branch, not main",
	lm.merged && fs.existsSync(`${planWt}/lw.txt`) && !fs.existsSync(`${root}/lw.txt`) && g(root, "rev-parse", "HEAD") === mainHead && g(planWt, "rev-parse", "--abbrev-ref", "HEAD") === "plan-branch", JSON.stringify(lm));
check("main HEAD untouched", mainHeadBefore !== "" && g(root, "rev-parse", "HEAD") === mainHead);

const ev = createWorktree(planWt, "t10-env")!;
check(".venv and node_modules are symlinked when ignored",
	fs.lstatSync(`${ev.path}/.venv`).isSymbolicLink() && fs.lstatSync(`${ev.path}/node_modules`).isSymbolicLink() && fs.readFileSync(`${ev.path}/.venv/marker`, "utf-8") === "v\n");
check("non-ignored env dir is not symlinked", !fs.existsSync(`${ev.path}/venv`) || !fs.lstatSync(`${ev.path}/venv`).isSymbolicLink());
check("symlinked env dirs do not show in git status", g(ev.path, "status", "--porcelain") === "", g(ev.path, "status", "--porcelain"));
await finishWorktree(ev, "t10");
check("env worktree cleaned up with source dirs intact", !fs.existsSync(ev.path) && fs.existsSync(`${planWt}/.venv/marker`));

const fakeIso = { root: planWt, path: `${planWt}/.foreman/worktrees/t1`, branch: "foreman/t1" };
const rt = retargetPrompt(`read ${planWt}/docs/x and ${planWt}/.foreman/runs/r.md and ${planWt}-other/y and ${fakeIso.path}/z`, fakeIso);
check("retargetPrompt does not duplicate the .worktrees segment",
	rt.includes(`${fakeIso.path}/docs/x`) && !rt.includes(`${fakeIso.path}/.worktrees`) && rt.includes(`${planWt}/.foreman/runs/r.md`) && rt.includes(`${planWt}-other/y`) && rt.includes(`${fakeIso.path}/z`) && !rt.includes(`${fakeIso.path}/.foreman/worktrees/t1/.foreman`), rt);

check("resolveWorkdir accepts root and a sibling worktree",
	resolveWorkdir(root, root) === root && resolveWorkdir(root, planWt) === planWt && resolveWorkdir(planWt, root) === root);
let e1 = "", e2 = "", e3 = "";
try { resolveWorkdir(root, os.tmpdir()); } catch (e: any) { e1 = String(e.message); }
try { resolveWorkdir(root, `${root}/a.txt`); } catch (e: any) { e2 = String(e.message); }
try { resolveWorkdir(root, `${root}/nope`); } catch (e: any) { e3 = String(e.message); }
check("resolveWorkdir rejects a path outside the repo and a non-directory", e1.includes(planWt) && e1.includes(root) && !!e2 && !!e3, [e1, e2, e3].join(" | "));

// not a repo
check("non-repo => no worktree", createWorktree(fs.mkdtempSync(path.join(os.tmpdir(), "nogit-")), "t1") === undefined);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "All worktree checks passed." : `${failures} worktree check(s) FAILED.`);
if (failures) process.exit(1);
