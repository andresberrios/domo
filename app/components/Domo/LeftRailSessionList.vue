<script setup lang="ts">
/**
 * Sessions nested under an env in the left rail (Project ▸ Env ▸ Session).
 * Cached `status` drives a small indicator dot; the authoritative live
 * status is reconciled in the chat surface (Phase 9/10). "Done" sessions
 * are hidden unless the rail's "show done" toggle is on.
 */
const props = defineProps<{
  projectName: string
  envName: string
  envId: string
  showDone: boolean
  refreshKey: number
}>()

const { data: sessions, refresh } = await apiClient.sessions.list.useCall({
  envId: props.envId,
})
watch(() => props.refreshKey, () => refresh())

const visible = computed(() =>
  (sessions.value ?? []).filter((s) => props.showDone || !s.done),
)

const router = useRouter()
const creating = ref(false)
const errMsg = ref<string | null>(null)

async function createSession() {
  if (creating.value) return
  creating.value = true
  errMsg.value = null
  try {
    const s = await apiClient.sessions.create.call({ envId: props.envId })
    await refresh()
    await router.push(
      `/p/${props.projectName}/e/${props.envName}/s/${s.id}`,
    )
  } catch (e) {
    errMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    creating.value = false
  }
}

function dotColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-primary'
    case 'pending-approval':
      return 'bg-warning'
    case 'error':
      return 'bg-error'
    default:
      return 'bg-muted'
  }
}
</script>

<template>
  <ul class="pl-5 space-y-0.5 mt-0.5">
    <li
      v-for="s in visible"
      :key="s.id"
    >
      <NuxtLink
        :to="`/p/${projectName}/e/${envName}/s/${s.id}`"
        class="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-elevated"
        active-class="bg-accented font-medium"
        :class="s.done ? 'opacity-50' : ''"
      >
        <span
          class="size-1.5 rounded-full shrink-0"
          :class="dotColor(s.status)"
        />
        <span class="truncate text-xs">{{ s.title || 'Untitled session' }}</span>
      </NuxtLink>
    </li>

    <li>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded px-1 py-0.5 w-full text-left text-xs text-muted hover:bg-elevated hover:text-default disabled:opacity-50"
        :disabled="creating"
        @click="createSession"
      >
        <UIcon
          :name="creating ? 'i-lucide-loader-circle' : 'i-lucide-plus'"
          class="size-3 shrink-0"
          :class="creating ? 'animate-spin' : ''"
        />
        <span>New session</span>
      </button>
    </li>
    <li v-if="errMsg" class="px-1 text-xs text-error">
      {{ errMsg }}
    </li>
  </ul>
</template>
