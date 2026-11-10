---
name: design-preview
description: Builds a real, interactive HTML preview of a UI/design-system option, using the actual styling library loaded live (not a text description), so the user can pick between options by seeing the real result. Use whenever the foreman skill needs to offer UI/design choices.
---

# Design Preview

Your job is to turn a shortlist of UI options into something the user can actually
look at and click through, built with the real library running — never a mockup
description in prose.

## Two independent choices

Always treat these as separate questions, and let the preview combine them:

1. **Styling library** — e.g. Tailwind CSS, Bootstrap, Material Design, Ant Design,
   Chakra, Bulma. Load the real library (CDN script/stylesheet) inside the
   artifact and build the components with it directly, so the preview is exactly
   what the final app would look like.
2. **UI pattern / archetype** — e.g. dashboard (cards, charts, tables), form-heavy,
   landing/marketing page, content/editorial layout. This decides the layout, not
   the library.

## shadcn-style note

shadcn is not a CDN-loadable library — it's copy-paste components built on top of
Tailwind and Radix. When a shadcn-style look is wanted, load Tailwind for real and
replicate shadcn's own default tokens (colors, radii, spacing, shadows) so the
preview is visually faithful even though the literal shadcn package isn't running.

## How to present it

- Build one HTML artifact per option (or a tabbed/switchable single artifact) with
  the real library loaded and 2-4 representative components/sections filled with
  realistic placeholder content for this specific project — not generic Lorem
  Ipsum.
- This skill runs in the foreman session itself (not a subagent), so write
  the HTML file yourself and tell the user exactly how to open it (path, or
  a local preview command) — don't just describe it in text.
- Let the user pick by reacting to what they see, not by naming a library in text.
- Once chosen, record the pick (library + pattern) so the foreman skill can write
  it into the project's memory file and pass it on to the frontend agent verbatim.
