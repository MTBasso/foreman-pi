---
name: project-memory
description: Reads and writes FOREMAN_MEMORY.md at the root of the current project, the per-project record of stack choices, conventions and decisions learned over time. Use this whenever the foreman skill needs to check prior decisions or record new ones.
---

# Project Memory

This plugin is installed globally and works the same way across every project, but
each project has its own conventions. Those live in a single file, local to that
repo, never in the plugin itself.

## File: `FOREMAN_MEMORY.md` (repo root)

Sections to maintain:

```markdown
# Foreman Memory

## Project
<one-line description of what this project is>

## Frontend
- Styling library: <chosen library>
- UI pattern: <dashboard / form-heavy / landing / editorial / ...>
- Other conventions: <...>

## Backend
- Architecture pattern: <...>
- Data store: <...>
- Other conventions: <...>

## Decisions log
- <date> — <decision> — <why, incl. alternatives considered/rejected during grilling>
```

## Rules

- If the file doesn't exist, create it the first time any decision is made — don't
  create an empty file speculatively.
- Before asking the user a question the foreman skill would normally ask (stack,
  pattern, architecture), check this file first. If it's already answered, reuse
  the answer and only re-ask if the new feature plausibly needs a different
  choice.
- Append to the decisions log rather than rewriting history.
- Write the `<why>` with enough of the reasoning from the grilling conversation
  that someone reading it cold later understands the tradeoff, not just the
  outcome — e.g. "Tailwind over Bootstrap: team already knows utility classes,
  and the dashboard pattern needs tighter custom layout control" rather than
  just "Tailwind chosen".
- This file is committed to the project repo, not kept in the plugin, so it travels
  with the project and survives across sessions and machines.
