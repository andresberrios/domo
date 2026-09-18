<script setup lang="ts">
import type { PendingPermission } from '~~/shared/types'

const props = defineProps<{ permission: PendingPermission }>()

const busy = ref<string | null>(null)
const toast = useToast()

const rawInput = computed(() => props.permission.toolCall?.rawInput ?? null)
const command = computed(() => rawInput.value?.command ?? rawInput.value?.cmd ?? null)

const diffs = computed(() =>
  (props.permission.toolCall?.content ?? []).filter((part: any) => part?.type === 'diff')
)

function optionColor(kind: string) {
  if (kind.startsWith('allow')) return kind === 'allow_always' ? 'primary' : 'primary'
  return 'neutral'
}

async function choose(optionId: string) {
  busy.value = optionId
  try {
    await $fetch(`/api/permissions/${props.permission.id}/answer`, {
      method: 'POST',
      body: { optionId }
    })
  } catch (error: any) {
    toast.add({
      title: 'Could not answer',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <UCard
    variant="outline"
    :ui="{ root: 'ring-warning/40 bg-warning/5', body: 'p-3 sm:p-4' }"
  >
    <div class="flex items-start gap-3">
      <UIcon name="i-lucide-shield-question" class="mt-0.5 size-5 shrink-0 text-warning" />
      <div class="min-w-0 flex-1 space-y-3">
        <div>
          <p class="text-sm font-medium">
            {{ permission.title }}
          </p>
          <p class="text-xs text-muted">
            The coding agent is asking for permission
          </p>
        </div>

        <pre v-if="command" class="overflow-x-auto rounded bg-default p-2 font-mono text-xs">{{ command }}</pre>

        <DiffView
          v-for="(diff, index) in diffs"
          :key="index"
          :path="diff.path"
          :old-text="diff.oldText"
          :new-text="diff.newText"
        />

        <div class="flex flex-wrap gap-2">
          <UButton
            v-for="option in permission.options"
            :key="option.optionId"
            :label="option.name"
            :color="optionColor(option.kind) as any"
            :variant="option.kind.startsWith('allow') ? 'solid' : 'outline'"
            size="sm"
            :loading="busy === option.optionId"
            :disabled="!!busy"
            @click="choose(option.optionId)"
          />
        </div>

        <p class="text-xs text-dimmed">
          You can also just say it out loud — the voice agent can answer this for you.
        </p>
      </div>
    </div>
  </UCard>
</template>
