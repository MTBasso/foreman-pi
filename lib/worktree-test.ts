import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { blockReport, createWorktree, finishWorktree, isolateMode, retargetPrompt, shouldIsolate } from "./worktree.ts";

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

// not a repo
check("non-repo => no worktree", createWorktree(fs.mkdtempSync(path.join(os.tmpdir(), "nogit-")), "t1") === undefined);

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "All worktree checks passed." : `${failures} worktree check(s) FAILED.`);
if (failures) process.exit(1);
