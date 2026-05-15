<script setup lang="ts">
const rightOpen = useState('panel:right', () => true)
const bottomOpen = useState('panel:bottom', () => false)
</script>

<template>
  <UApp>
    <UDashboardGroup storage-key="domo">
      <UDashboardSidebar
        id="left-rail"
        resizable
        collapsible
        :default-size="18"
        :min-size="12"
        :max-size="28"
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
          <DomoCenterNavbar
            @toggle-right="rightOpen = !rightOpen"
            @toggle-bottom="bottomOpen = !bottomOpen"
          />
        </template>

        <template #body>
          <div class="flex-1 min-h-0 overflow-auto">
            <NuxtPage />
          </div>
          <DomoBottomTerminal v-if="bottomOpen" @close="bottomOpen = false" />
        </template>
      </UDashboardPanel>

      <UDashboardPanel
        v-if="rightOpen"
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
    </UDashboardGroup>
  </UApp>
</template>
