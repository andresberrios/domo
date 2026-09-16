<script setup lang="ts">
const model = defineModel<string>({ default: '' })

const open = ref(false)
const browsing = ref('')
const loading = ref(false)
const error = ref<string | null>(null)
const entries = ref<Array<{ name: string, path: string }>>([])
const parent = ref<string | null>(null)

async function load(path?: string) {
  loading.value = true
  error.value = null
  try {
    const result = await $fetch<{ path: string, parent: string | null, directories: Array<{ name: string, path: string }> }>(
      '/api/fs/list',
      { query: path ? { path } : {} }
    )
    browsing.value = result.path
    parent.value = result.parent
    entries.value = result.directories
  } catch (err: any) {
    error.value = err?.data?.statusMessage ?? err?.message ?? 'Cannot read directory'
  } finally {
    loading.value = false
  }
}

watch(open, (value) => {
  if (value) void load(model.value || undefined)
})

function choose() {
  model.value = browsing.value
  open.value = false
}
</script>

<template>
  <div class="flex gap-2">
    <UInput
      v-model="model"
      placeholder="/path/to/repository"
      icon="i-lucide-folder"
      class="flex-1"
      :ui="{ base: 'font-mono text-xs' }"
    />
    <UModal
      v-model:open="open"
      title="Choose a working directory"
      description="Pick the repository this agent should work in."
    >
      <UButton icon="i-lucide-folder-search" color="neutral" variant="subtle" aria-label="Browse" />

      <template #body>
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <UButton
              icon="i-lucide-arrow-up"
              color="neutral"
              variant="subtle"
              size="xs"
              :disabled="!parent"
              @click="parent && load(parent)"
            />
            <code class="min-w-0 flex-1 truncate rounded bg-elevated px-2 py-1 text-xs">{{ browsing }}</code>
          </div>

          <UAlert v-if="error" color="error" variant="subtle" :description="error" />

          <div class="max-h-72 overflow-y-auto rounded-lg border border-default">
            <div v-if="loading" class="space-y-2 p-3">
              <USkeleton v-for="index in 5" :key="index" class="h-6 w-full" />
            </div>
            <ul v-else-if="entries.length" class="divide-y divide-default">
              <li v-for="entry in entries" :key="entry.path">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-elevated"
                  @click="load(entry.path)"
                >
                  <UIcon name="i-lucide-folder" class="size-4 text-muted" />
                  <span class="truncate">{{ entry.name }}</span>
                </button>
              </li>
            </ul>
            <p v-else class="p-4 text-center text-sm text-muted">
              No sub-directories here.
            </p>
          </div>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
          <UButton label="Use this folder" @click="choose" />
        </div>
      </template>
    </UModal>
  </div>
</template>
