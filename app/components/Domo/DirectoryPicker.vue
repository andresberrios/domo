<script setup lang="ts">
const props = defineProps<{ initialPath?: string }>()
const emit = defineEmits<{
  select: [path: string]
  cancel: []
}>()

const path = ref(props.initialPath ?? '')

const { data, refresh, status, error } = await apiClient.fs.browse.useCall({ path: path.value || undefined })

watch(path, () => { refresh() })

function descend(p: string): void { path.value = p }
function up(): void { if (data.value?.parent) path.value = data.value.parent }
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <UButton
        size="xs"
        variant="ghost"
        icon="i-lucide-arrow-up"
        :disabled="!data?.parent"
        title="Up"
        @click="up()"
      />
      <UInput
        v-model="path"
        size="xs"
        class="flex-1"
        placeholder="/absolute/path"
        @keydown.enter="refresh()"
      />
      <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" title="Refresh" @click="refresh()" />
    </div>

    <div
      class="border border-default rounded-md max-h-72 overflow-auto min-h-32"
      :class="{ 'opacity-50': status === 'pending' }"
    >
      <p v-if="error" class="p-3 text-sm text-error">
        {{ error.message ?? 'Could not read directory' }}
      </p>
      <ul v-else-if="data && data.entries.length > 0" class="text-sm">
        <li
          v-for="e in data.entries"
          :key="e.path"
          class="px-3 py-1 hover:bg-elevated cursor-pointer flex items-center gap-2"
          :class="{ 'text-muted': e.hidden }"
          @dblclick="descend(e.path)"
          @click="descend(e.path)"
        >
          <UIcon name="i-lucide-folder" class="size-3.5 text-muted" />
          <span class="truncate">{{ e.name }}</span>
        </li>
      </ul>
      <p v-else class="p-3 text-sm text-muted">
        No subdirectories.
      </p>
    </div>

    <div class="flex items-center justify-end gap-2 pt-1">
      <UButton size="sm" variant="ghost" @click="emit('cancel')">
        Cancel
      </UButton>
      <UButton
        size="sm"
        color="primary"
        :disabled="!data?.path"
        @click="data && emit('select', data.path)"
      >
        Select {{ data?.path ? `"${data.path}"` : '' }}
      </UButton>
    </div>
  </div>
</template>
