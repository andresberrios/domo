# Phase 4 — Polish

The end-of-v1 sweep. Aborts, keyboard shortcuts, dark mode, error/loading states, responsive layout, onboarding.

## 12. Polish

Split into two checkpoints. **First half landed** (visual-robustness +
first-run); second half (interaction) is next.

- [ ] Aborts everywhere (session, env operations, build) — *next half* (session abort already done in Phase 3 step 11; remaining: env ops + build)
- [ ] Keyboard shortcuts (focus prompt, switch tabs, save file, commit) — *next half*
- [x] **Dark mode** — `UColorModeButton` in `DomoCenterNavbar`; verified the toggle flips `<html class="dark">` and persists. App already uses Nuxt UI semantic tokens (only intentional exception: `DomoTerminal` `bg-black`); `DomoCodeEditor`/`DomoDiffView` already react to `useColorMode`. (Note: a headless Vite-dev screenshot renders unstyled — a `@layer` paint timing artifact; the Tailwind/Nuxt UI utility CSS is confirmed generated/present, not a code defect, no CSS/config changed.)
- [x] **Error states + loading skeletons** — `app/error.vue` (global, wrapped in `UApp`, Go-home/Try-again), `<NuxtErrorBoundary>` around `<NuxtPage>` (per-view crash → `DomoEmptyState` + Retry), `<NuxtLoadingIndicator>` for route transitions, reusable `DomoEmptyState`, `USkeleton` loading block on the env overview page, `UAlert` for env-action errors. Fixed a spurious `400 /procedures/envs/list` (project/env pages called it with an empty `projectId` on not-found URLs / before projects resolve) — now a guarded `.call()`.
- [ ] Responsive mobile layout (left panel as drawer; center/right/bottom stack) — *next half*
- [x] **Empty / onboarding states** — `app/pages/index.vue` rewritten: first-run onboarding (`DomoEmptyState` + "Add a project" CTA opening the rail's modal via shared `leftRail:showAddProject`) when no projects; a project-picker grid when projects exist (removed the stale "Phase 1 will wire up…" placeholder). Project/env "not found" now render `DomoEmptyState` with a back action.
