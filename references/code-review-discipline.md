Referenced from `foreman`, `qa`, `qa-bugfix`, `release-manager`, and
`plan-step-builder`. Two halves: how to ask for a review, and how to take
one — read whichever half applies, or both.

## Requesting a review

A review is only as good as the isolation it runs in. The reviewer must not
share the implementer's context — if it saw the same conversation that
produced the code, it inherits the same blind spots.

1. **Get real SHAs, not a description of the diff:**
   ```bash
   BASE_SHA=$(git merge-base origin/main HEAD)   # or the plan's actual base
   HEAD_SHA=$(git rev-parse HEAD)
   ```
2. **Dispatch a fresh subagent/session** (never the implementer itself, never
   your own session if you wrote the plan it's checking) with:
   - A one-line description of what was built.
   - The plan/requirements it should have met (paste the relevant plan
     section or grilled requirement — don't make it go find it).
   - `BASE_SHA` and `HEAD_SHA`, and instructions to read the actual diff
     between them, not trust a summary.
3. **Act on the reply**: fix anything it flags as a real defect before this
   goes further (don't defer "I'll fix it later" on something it found).
   If you think it's wrong, push back with your own technical reasoning —
   see "Receiving a review" below for how, don't just override it silently.

When to request one (mandatory, not optional): before `release-manager`
packages anything, after any step/task a plan marks risky, and any time a
delegate's self-report is the only evidence a change works.

## Receiving a review

Whether the review comes from a dispatched subagent, a human reviewer on a
PR, or the user themselves — the response pattern is the same: technical
evaluation, not social performance.

**Principle, in any language:** no agreement or gratitude opener before you
have verified the claim. The examples below are the same failure in each
supported language.

**Never:**
- "You're absolutely right!" / "Great point!" — performative agreement
  before you've checked anything.
- `[pt-BR]` "Você está absolutamente certo!" / "Ótimo ponto!" — the same,
  in Portuguese.
- Implementing a suggestion before you've verified it's correct for this
  codebase.
- Silently ignoring feedback you disagree with instead of saying so.

**Instead:**
1. Read the full feedback before reacting.
2. Restate the technical requirement in your own words (or ask, if
   genuinely unclear) — don't guess at intent.
3. Verify it against the actual codebase: is the claim even true here?
4. If it's right: say so plainly and fix it, one item at a time, verifying
   each before moving to the next (don't batch unrelated fixes into one
   unverified pass).
5. If it's wrong, or right but inapplicable to this codebase: push back
   with the specific technical reason, don't just comply to avoid friction.
   A reviewer (human or agent) can be wrong; "the review said so" is not
   itself evidence.
