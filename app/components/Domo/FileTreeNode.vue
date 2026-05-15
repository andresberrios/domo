<script setup lang="ts">
/** One row of the file tree. Recurses into itself for subdirectories. */
type Entry = { name: string; path: string; isDir: boolean }

const props = defineProps<{
  entry: Entry
  envId: string
  projectName: string
  envName: string
  depth: number
}>()

const route = useRoute()
const expanded = ref(false)
const children = ref<Entry[] | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

const filePath = computed(() => {
  const segs = props.entry.path.split('/').map(encodeURIComponent).join('/')
  return `/p/${encodeURIComponent(props.projectName)}/e/${encodeURIComponent(props.envName)}/f/${segs}`
})

const isActive = computed(() => {
  const p = route.params.path
  const cur = Array.isArray(p) ? p.join('/') : (p ?? '')
  return !props.entry.isDir && cur === props.entry.path
})

async function loadChildren() {
  loading.value = true
  error.value = null
  try {
    const res = await apiClient.workspace.tree.call({
      envId: props.envId,
      dir: props.entry.path,
    })
    children.value = res.entries
  } catch (e) {
    error.value = (e as Error).message
    children.value = []
  } finally {
    loading.value = false
  }
}

async function onClick() {
  if (props.entry.isDir) {
    expanded.value = !expanded.value
    if (expanded.value && children.value === null) await loadChildren()
  } else {
    await navigateTo(filePath.value)
  }
}
</script>

<template>
  <li>
    <div
      class="flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer hover:bg-elevated"
      :class="isActive ? 'bg-elevated text-primary' : ''"
      :style="{ paddingLeft: `${depth * 12 + 4}px` }"
      @click="onClick"
    >
      <UIcon
        v-if="entry.isDir"
        :name="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        class="size-3 text-muted shrink-0"
      />
      <UIcon
        v-else
        name="i-lucide-file"
        class="size-3 text-muted shrink-0"
      />
      <span class="truncate">{{ entry.name }}</span>
    </div>

    <template v-if="entry.isDir && expanded">
      <div
        v-if="loading"
        class="text-xs text-muted py-0.5"
        :style="{ paddingLeft: `${(depth + 1) * 12 + 4}px` }"
      >
        Loading…
      </div>
      <div
        v-else-if="error"
        class="text-xs text-error py-0.5"
        :style="{ paddingLeft: `${(depth + 1) * 12 + 4}px` }"
      >
        {{ error }}
      </div>
      <ul v-else-if="children">
        <DomoFileTreeNode
          v-for="child in children"
          :key="child.path"
          :entry="child"
          :env-id="envId"
          :project-name="projectName"
          :env-name="envName"
          :depth="depth + 1"
        />
      </ul>
    </template>
  </li>
</template>
