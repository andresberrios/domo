<script setup lang="ts">
import { useBreakpoints, breakpointsTailwind } from '@vueuse/core'

// The dashboard shell. Mounted by `app.vue` ONLY for a signed-in,
// admin-approved user — so its panel-state fetch (`usePanelState` →
// `settings.get`) and other data procedures never fire on the bare auth
// screens (an unauthenticated call would 401 and surface as a console
// error). Auth pages get a bare `<NuxtPage>` instead.

// SPA app, so window-based breakpoints are safe (no SSR hydration gap).
const isDesktop = useBreakpoints(breakpointsTailwind).greaterOrEqual('lg')

// Desktop inline-panel visibility — persisted, defaults open.
const rightOpen = usePanelState('right', true)
// Mobile drawer — ephemeral and independent of the persisted desktop
// preference (a persisted `true` must NOT auto-open a full-screen drawer
// over the chat on every mobile load). Defaults closed.
const rightDrawerOpen = ref(false)
// Whichever surface is live at the current breakpoint.
const workspaceOpen = computed({
  get: () => (isDesktop.value ? rightOpen.value : rightDrawerOpen.value),
  set: (v: boolean) => {
    if (isDesktop.value) rightOpen.value = v
    else rightDrawerOpen.value = v
  },
})
function toggleWorkspace() { workspaceOpen.value = !workspaceOpen.value }

// Shared so the workspace tab can be driven by a global shortcut as well
// as RightPanel's own UTabs (Nuxt `useState` is the codebase's cross-
// component channel — same pattern as `leftRail:*`).
const workspaceTab = useState<'files' | 'git'>('workspace:tab', () => 'files')

// Global shortcuts. `meta` auto-maps to Ctrl off macOS (defineShortcuts).
// ⌘B toggles the workspace panel (drawer on mobile, inline on desktop);
// ⌘1/⌘2 jump to its Files/Git tabs.
defineShortcuts({
  meta_b: toggleWorkspace,
  meta_1: () => { workspaceOpen.value = true; workspaceTab.value = 'files' },
  meta_2: () => { workspaceOpen.value = true; workspaceTab.value = 'git' },
})
</script>

<template>
  <UDashboardGroup storage-key="domo">
    <!--
      `menu` forwards to the sidebar's mobile slideover. We set
      title/description explicitly because Nuxt UI 4.7.1 calls
      `t('dashboardSidebar.title'|'.description')` but ships no
      `dashboardSidebar` locale key (only ...Collapse/...Toggle), so
      the defaults render as the literal i18n path. `v-bind="menu"` is
      applied after the broken `:title`, so this wins.
    -->
    <UDashboardSidebar
      id="left-rail"
      resizable
      collapsible
      :default-size="18"
      :min-size="12"
      :max-size="28"
      :menu="{
        title: 'Navigation',
        description: 'Projects, environments, and sessions.',
      }"
    >
      <template #header>
        <DomoLeftRailHeader />
      </template>
      <template #default>
        <DomoLeftRailTree />
      </template>
      <template #footer>
        <DomoLeftRailFooter />
      </template>
    </UDashboardSidebar>

    <UDashboardPanel id="center" :default-size="rightOpen ? 58 : 82">
      <template #header>
        <DomoCenterNavbar @toggle-right="toggleWorkspace" />
      </template>

      <template #body>
        <div class="flex-1 min-h-0 overflow-auto">
          <NuxtErrorBoundary>
            <NuxtPage />
            <template #error="{ error, clearError }">
              <DomoEmptyState
                icon="i-lucide-triangle-alert"
                title="This view crashed"
                :description="error.message"
              >
                <UButton
                  color="primary"
                  icon="i-lucide-rotate-cw"
                  @click="clearError()"
                >
                  Retry
                </UButton>
              </DomoEmptyState>
            </template>
          </NuxtErrorBoundary>
        </div>
      </template>
    </UDashboardPanel>

    <!--
      Responsive component swap (the dashboard group is a non-wrapping
      flex row, so a second full-width inline panel can't stack on
      phones). `useBreakpoints` mounts exactly one: desktop ≥lg an
      inline resizable `UDashboardPanel` (persisted `rightOpen`);
      mobile <lg the same `DomoRightPanel` in a `USlideover` drawer
      (ephemeral `rightDrawerOpen`, default closed) — the model the
      left rail already uses.
    -->
    <UDashboardPanel
      v-if="isDesktop && rightOpen"
      id="right"
      resizable
      :default-size="24"
      :min-size="16"
      :max-size="40"
    >
      <template #header>
        <DomoRightNavbar @close="rightOpen = false" />
      </template>
      <template #body>
        <DomoRightPanel />
      </template>
    </UDashboardPanel>

    <USlideover
      v-if="!isDesktop"
      v-model:open="rightDrawerOpen"
      side="right"
      title="Workspace"
      description="Files and git changes for the selected environment."
    >
      <template #body>
        <DomoRightPanel />
      </template>
    </USlideover>
  </UDashboardGroup>
</template>
