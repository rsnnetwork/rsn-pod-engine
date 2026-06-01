# RSN QA — Structured Testing Framework

Living artifacts that implement the structured application-testing approach. Built from a read-only audit of the codebase.

Following the framework author's guidance, this is **several complementary artifacts, each with one purpose and one audience** — not one document trying to do everything. A human tester walks the **screens → clicks** script; engineers use the code map and dependency map; everyone shares the register.

| Artifact | Audience | Purpose | Framework step |
|---|---|---|---|
| [test-script.md](./test-script.md) | Testers | Walk the app screen by screen, click by click, with expected results | Step 1 (tester view) |
| [component-map.md](./component-map.md) | Engineers | Each component/action tied to the code that owns it (traceability) | Step 1 (engineer view) |
| [dependency-map.md](./dependency-map.md) | Engineers / triage | How components connect; trace upstream cause + downstream knock-on | Step 2 |
| [issue-register.md](./issue-register.md) | Shared | Component-keyed log of every observation (seeded with 27 May) | Steps 3–4 |

## Why the split

The test script is organized the way a **human moves through the app** (screens first, then the controls on each screen, coarse to fine). The code/dependency maps are organized the way an **engineer traces a problem** (component → owning file → cause → ripple). Same underlying reality, two entry points for two readers. Keeping them separate is what keeps each one usable.

## How they work together

1. A tester walks **test-script.md** and logs anything off in **issue-register.md**, tagged to the screen.
2. Engineering takes a register entry and uses **component-map.md** to find the owning code and **dependency-map.md** to trace the true cause and any knock-on effects.
3. The register links the issue to the code, so it reaches engineering already diagnosed.
4. Each test cycle updates the register; coverage gaps feed the next session.

## Scope

These are the **testing capability** — how we test and track. They are deliberately separate from any specific fix work or "what changed" report. A fix summary references these; it does not replace them.

## Live copies (Google, dev@rsn)

The team-facing live copies live in the dev@rsn Google Drive. These markdown files are the version-controlled master that the live copies are built from.

- **Last updated:** 2026-05-30
- Maintained as living documents — update whenever a screen, action, or dependency changes. Keep the set tight; don't let it sprawl into docs nobody maintains.
