# Domo — Task tracker

Index of the per-phase checklists in [`tasks/`](tasks/). Tick items as we land them; add new ones as we discover them.

> **Keep this in sync with the design docs.** Whenever a task surfaces a new decision, a contradicted assumption, or a changed scope, update `initial-design.md` (and `project-context.md` if the high-level framing shifts) in the same change — not later. Same rule the other direction: design changes get reflected here as task additions/edits.

## Phases

| | File | Covers | Build-seq |
|-|------|--------|-----------|
| 0 | [`tasks/phase-0-foundations.md`](tasks/phase-0-foundations.md) | Smoke tests, Nuxt skeleton, Coast adapter | 0–2 |
| 1 | [`tasks/phase-1-projects-and-envs.md`](tasks/phase-1-projects-and-envs.md) | Project setup flow, env creation + env screen | 3–4 |
| 2 | [`tasks/phase-2-workspace.md`](tasks/phase-2-workspace.md) | File tree + editor, terminal pane, git changes pane | 5–7 |
| 3 | [`tasks/phase-3-sessions.md`](tasks/phase-3-sessions.md) | Electric Agents, chat surface, session lifecycle, diff approval | 8–11 |
| 4 | [`tasks/phase-4-polish.md`](tasks/phase-4-polish.md) | Aborts, shortcuts, dark mode, error/loading, responsive, onboarding | 12 |

## Cross-cutting

- [`tasks/cross-cutting.md`](tasks/cross-cutting.md) — pending decisions, pending discussions carried from `initial-design.md`, public-docs we still owe

The phases are roughly ordered, but they're not strictly serial: pieces of one phase can land out of order if they don't block. The "build sequence" column maps each phase back to the step numbers in `initial-design.md` so the source-of-truth is easy to cross-reference.
