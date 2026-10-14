<script setup lang="ts">
const { creating, talk, assistant } = useTalk()
const talkLabel = computed(() => assistant.value ? `Talk to ${assistant.value.name}` : 'Talk in a new session')
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar
      id="domo-sidebar"
      mode="slideover"
      resizable
      collapsible
      :default-size="20"
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
          <div class="flex flex-col gap-3">
            <div class="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-1.5">
              <UTooltip :text="talkLabel">
                <UButton
                  label="Talk"
                  icon="i-lucide-mic"
                  block
                  :loading="creating"
                  :aria-label="talkLabel"
                  @click="talk"
                />
              </UTooltip>
              <UButton
                label="New session"
                icon="i-lucide-plus"
                color="neutral"
                variant="subtle"
                block
                to="/agents/new"
              />
            </div>
            <nav class="flex flex-col gap-px">
              <UButton
                to="/schedules"
                label="Schedules"
                icon="i-lucide-clock-3"
                color="neutral"
                variant="ghost"
                block
                class="justify-start"
              />
              <NotificationsButton />
            </nav>
          </div>

          <SidebarAssistants />

          <ProjectTree />
        </div>

        <div v-else class="flex flex-col items-center gap-2">
          <UButton icon="i-lucide-mic" :loading="creating" :aria-label="talkLabel" @click="talk" />
          <UButton icon="i-lucide-plus" color="neutral" variant="ghost" aria-label="New session" to="/agents/new" />
          <UButton to="/schedules" icon="i-lucide-clock-3" color="neutral" variant="ghost" aria-label="Schedules" />
          <NotificationsButton collapsed />
        </div>
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full flex-col gap-1">
          <UsageSidebarSummary v-if="!collapsed" />
          <DockerDiskBadge :collapsed="collapsed" />
          <UpdateBadge :collapsed="collapsed" />
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
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
