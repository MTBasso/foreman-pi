Referenced from `foreman`'s step 0.5. Read this only when you haven't
already confirmed (this session, or recently on this machine) that the
optional dependencies are installed.

This plugin leans on four optional skills from other sources: `grill-me`,
`improve-codebase-architecture`, `writing-for-agents` (all from
`mattpocock/skills`), and `impeccable` (from `pbakaus/impeccable`, for
removing "AI slop" from generated UI). None of them is required.

Check this session's available-skills list for each name. For any that is
missing, tell the user once that it is optional and can be added with the
skills CLI (for example `npx skills add mattpocock/skills`, or
`npx skills find impeccable` to locate the right package), or by placing the
skill folder under `~/.agents/skills/` or `~/.pi/agent/skills/`. Do not
install anything yourself: you have no shell while orchestrating.

If a skill is missing or an install fails, fall back to your own judgment for
that step -- don't block the rest of foreman mode on it.
