<script setup lang="ts">
const model = defineModel<string>({ default: '' })
const props = withDefaults(defineProps<{
  title?: string
  description?: string
  placeholder?: string
  /** Offers a folder that does not exist yet: the browsed folder plus a typed name. Nothing is created here. */
  allowNew?: boolean
}>(), {
  title: 'Choose a folder',
  description: 'Any folder on this machine.',
  placeholder: '/path/to/repository',
  allowNew: false
})

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

const naming = ref(false)
const newName = ref('')
const newNameProblem = computed(() => {
  const value = newName.value.trim()
  if (!value) return null
  if (value === '.' || value === '..' || /[/\\]/.test(value)) return 'A folder name, without slashes.'
  return null
})

/**
 * Opens at the typed path, or, when it does not exist yet, at the nearest
 * folder above it that does; a missing last folder is offered as the new one.
 */
async function loadNearest(path: string) {
  const parts = path.replace(/\/+$/, '').split('/')
  for (let missing = 0; missing < parts.length; missing++) {
    await load(parts.slice(0, parts.length - missing).join('/') || '/')
    if (!error.value) {
      if (missing === 1 && props.allowNew) {
        naming.value = true
        newName.value = parts[parts.length - 1]!
      }
      return
    }
  }
}

watch(open, (value) => {
  if (!value) return
  naming.value = false
  newName.value = ''
  if (model.value.trim()) void loadNearest(model.value.trim())
  else void load()
})

function choose() {
  model.value = browsing.value
  open.value = false
}

function chooseNew() {
  const value = newName.value.trim()
  if (!value || newNameProblem.value) return
  model.value = `${browsing.value.replace(/\/+$/, '')}/${value}`
  open.value = false
}
</script>

<template>
  <div class="flex gap-2">
    <UInput
      v-model="model"
      :placeholder="props.placeholder"
      icon="i-lucide-folder"
      class="flex-1"
      :ui="{ base: 'font-mono text-xs' }"
    />
    <UModal
      v-model:open="open"
      :title="props.title"
      :description="props.description"
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
            <!-- Right-to-left so a long path keeps its end, the part that says where you are, in view. -->
            <code class="min-w-0 flex-1 truncate rounded bg-elevated px-2 py-1 text-left text-xs" dir="rtl"><bdi dir="ltr">{{ browsing }}</bdi></code>
            <UButton
              v-if="allowNew && !naming"
              icon="i-lucide-folder-plus"
              label="New folder"
              color="neutral"
              variant="subtle"
              size="xs"
              :disabled="!browsing || !!error"
              @click="naming = true"
            />
          </div>

          <UFormField
            v-if="allowNew && naming"
            :error="newNameProblem ?? false"
            :help="newNameProblem ? undefined : 'Made when you add the project, not before.'"
          >
            <div class="flex gap-2">
              <UInput
                v-model="newName"
                placeholder="my-new-project"
                icon="i-lucide-folder-plus"
                class="min-w-0 flex-1"
                autofocus
                aria-label="New folder name"
                @keydown.enter.prevent="chooseNew"
                @keydown.esc.stop.prevent="naming = false"
              />
              <UButton label="Use" :disabled="!newName.trim() || !!newNameProblem" @click="chooseNew" />
            </div>
          </UFormField>

          <UAlert v-if="error" color="error" variant="subtle" :description="error" />

          <div class="max-h-[50dvh] overflow-y-auto rounded-lg border border-default sm:max-h-72">
            <div v-if="loading" class="space-y-2 p-3">
              <USkeleton v-for="index in 5" :key="index" class="h-6 w-full" />
            </div>
            <ul v-else-if="entries.length" class="divide-y divide-default">
              <li v-for="entry in entries" :key="entry.path">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm hover:bg-elevated sm:py-2"
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
