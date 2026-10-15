<script setup lang="ts">
const { creating, talk, assistant } = useTalk()
const talkLabel = computed(() => assistant.value ? `Talk to ${assistant.value.name}` : 'Talk in a new session')

/**
 * A new install opens on the setup guide, from the home page and once per
 * visit: skipping it or running a first session stops that for good, and
 * Settings has it after. A deep link is left where it points.
 */
const route = useRoute()
const { data: settings } = useSettings()
const offeredSetup = useState('offered-setup', () => false)
watch(settings, (value) => {
  if (!value?.setupDue || offeredSetup.value || route.path !== '/') return
  offeredSetup.value = true
  void navigateTo('/setup')
}, { immediate: true })
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
        <!-- Collapsing changes the sidebar's width at once, never over time: a width in motion re-lays the transcript out every frame. What is inside fades in. -->
        <Transition name="swap">
          <div v-if="!collapsed" class="flex flex-col gap-4">
            <div class="flex flex-col gap-3">
              <!-- Each as wide as its label needs, sharing the rest; a narrow sidebar puts them on two lines. -->
              <div class="flex flex-wrap gap-1.5">
                <UTooltip :text="talkLabel">
                  <UButton
                    label="Talk"
                    icon="i-lucide-mic"
                    block
                    class="flex-1"
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
                  class="flex-1 whitespace-nowrap"
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
        </Transition>
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
