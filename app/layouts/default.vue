<script setup lang="ts">
const { creating, startConversation } = useNewConversation()

const newAgentOpen = ref(false)
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar
      id="domo-sidebar"
      mode="slideover"
      resizable
      collapsible
      :default-size="18"
      :min-size="14"
      :max-size="28"
      :ui="{ footer: 'border-t border-default' }"
    >
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex items-center gap-2 px-1 py-0.5">
          <span class="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <UIcon name="i-lucide-audio-lines" class="size-4" />
          </span>
          <span v-if="!collapsed" class="text-sm font-semibold tracking-tight">Domo</span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed" class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <UButton
              label="New conversation"
              icon="i-lucide-mic"
              block
              :loading="creating"
              @click="startConversation"
            />
            <UButton
              label="New coding agent"
              icon="i-lucide-plus"
              color="neutral"
              variant="subtle"
              block
              @click="newAgentOpen = true"
            />
          </div>

          <ProjectTree />
        </div>

        <div v-else class="flex flex-col items-center gap-2">
          <UButton icon="i-lucide-mic" :loading="creating" aria-label="New conversation" @click="startConversation" />
          <UButton icon="i-lucide-plus" color="neutral" variant="ghost" aria-label="New coding agent" @click="newAgentOpen = true" />
        </div>
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full items-center justify-between gap-2">
          <UButton
            to="/settings"
            icon="i-lucide-settings"
            :label="collapsed ? undefined : 'Settings'"
            color="neutral"
            variant="ghost"
            :block="!collapsed"
            class="justify-start"
          />
          <ColorModeButton v-if="!collapsed" />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />

    <NewAgentModal v-model:open="newAgentOpen" />
  </UDashboardGroup>
</template>
