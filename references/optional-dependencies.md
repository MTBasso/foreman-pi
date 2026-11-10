Referenced from `foreman`'s step 0.5. Read this only when you haven't
already confirmed (this session, or recently on this machine) that the
optional dependencies are installed.

This plugin leans on four skills from other marketplaces: `grill-me`,
`improve-codebase-architecture`, `writing-for-agents` (all from
`mattpocock/skills`), and `impeccable` (from `pbakaus/impeccable`, for
removing "AI slop" from generated UI). Run `claude plugin list` once; for
any of the four missing, install it yourself rather than just telling the
user to:

```bash
claude plugin marketplace add mattpocock/skills
claude plugin install grill-me@mattpocock/skills
claude plugin install improve-codebase-architecture@mattpocock/skills
claude plugin install writing-for-agents@mattpocock/skills
claude plugin marketplace add pbakaus/impeccable
# then check the exact plugin id this marketplace exposes (names can differ
# from the repo name) with `claude plugin marketplace list` / `claude plugin
# list`, and install that, e.g. `claude plugin install impeccable@impeccable`
```

If an install fails (network, marketplace name changed, etc.), tell the user
once and fall back to your own judgment for that step — don't block the rest
of foreman mode on it.
