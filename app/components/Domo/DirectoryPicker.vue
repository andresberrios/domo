<script setup lang="ts">
// Imperative browse (NOT `useCall`): `nuxt-procedures` `useCall` keys its
// cache on the input serialized at call time and `refresh()` re-sends that
// ORIGINAL input — so navigating/typing never changed what was fetched and
// the picker was stuck on the home dir. We drive `apiClient.fs.browse.call`
// directly and re-call on every navigation.
type BrowseResp = Awaited<ReturnType<typeof apiClient.fs.browse.call>>

const props = defineProps<{ initialPath?: string }>()
const emit = defineEmits<{
  select: [path: string]
  cancel: []
}>()

// The path bar — editable, and also our breadcrumb. It always reflects the
// canonical directory currently listed (we overwrite it with the resolved
// path the server returns).
const path = ref(props.initialPath ?? '')
const data = ref<BrowseResp | null>(null)
const pending = ref(false)
const errMsg = ref<string | null>(null)

async function load(p?: string): Promise<void> {
  pending.value = true
  errMsg.value = null
  try {
    const res = await apiClient.fs.browse.call({
      path: p && p.length > 0 ? p : undefined,
    })
    data.value = res
    path.value = res.path
  } catch (e) {
    const x = e as { data?: { message?: string }; statusMessage?: string }
    errMsg.value =
      x?.data?.message || x?.statusMessage || (e as Error).message || 'Could not read directory'
  } finally {
    pending.value = false
  }
}

load(path.value || undefined)

function descend(p: string): void { load(p) }
function up(): void { if (data.value?.parent) load(data.value.parent) }
function go(): void { load(path.value || undefined) }

const currentName = computed(() => {
  const p = data.value?.path
  if (!p) return ''
  const base = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base || p
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-arrow-up"
        :disabled="!data?.parent || pending"
        title="Up one level"
        @click="up()"
      />
      <UInput
        v-model="path"
        size="xs"
        class="flex-1"
        placeholder="/absolute/path"
        :disabled="pending"
        @keydown.enter="go()"
      />
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-refresh-cw"
        title="Go / refresh"
        :loading="pending"
        @click="go()"
      />
    </div>

    <div
      class="border border-default rounded-md max-h-72 overflow-auto min-h-32"
      :class="{ 'opacity-50': pending }"
    >
      <p v-if="errMsg" class="p-3 text-sm text-error">
        {{ errMsg }}
      </p>
      <ul v-else-if="data && data.entries.length > 0" class="text-sm">
        <li
          v-for="e in data.entries"
          :key="e.path"
          class="px-3 py-1 hover:bg-elevated cursor-pointer flex items-center gap-2"
          :class="{ 'text-muted': e.hidden }"
          :title="`Open ${e.name}`"
          @click="descend(e.path)"
        >
          <UIcon name="i-lucide-folder" class="size-3.5 text-muted shrink-0" />
          <span class="truncate">{{ e.name }}</span>
        </li>
      </ul>
      <p v-else-if="data" class="p-3 text-sm text-muted">
        No subdirectories — you can still select this folder.
      </p>
    </div>

    <div class="flex items-center justify-between gap-2 pt-1">
      <span class="text-xs text-muted truncate min-w-0" :title="data?.path">
        <template v-if="currentName">In <strong>{{ currentName }}</strong></template>
      </span>
      <div class="flex items-center gap-2 shrink-0">
        <UButton size="sm" variant="ghost" @click="emit('cancel')">
          Cancel
        </UButton>
        <UButton
          size="sm"
          color="primary"
          :disabled="!data?.path || pending"
          @click="data && emit('select', data.path)"
        >
          Select this folder
        </UButton>
      </div>
    </div>
  </div>
</template>
