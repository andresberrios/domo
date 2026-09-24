<script setup lang="ts">
import type { DomoNotification } from '~~/shared/types'

/**
 * What agents asked the human to see (`notify_supervisor`), kept until it has
 * been seen: a voice conversation may not be live when an agent reports, and a
 * line in one agent's transcript is somewhere nobody is looking.
 *
 * The sidebar button carries the unseen count; a new one also raises a toast,
 * but only one that arrives while the page is open — the backlog is the
 * badge's job, not a burst of toasts on every load.
 */
const props = withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const { notifications, unseen, isReady } = useNotifications()
const toast = useToast()
const open = ref(false)
const showSeen = ref(false)

const shown = computed(() => showSeen.value ? notifications.value.slice(0, 50) : unseen.value)

function attachmentUrl(notification: DomoNotification, index: number): string {
  return `/api/notifications/${notification.id}/attachments/${index}`
}

function isImage(mimeType: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(mimeType)
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function markSeen(ids?: string[]) {
  try {
    await $fetch('/api/notifications/seen', { method: 'POST', body: ids ? { ids } : {} })
  } catch (error: any) {
    toast.add({ title: 'Could not mark it seen', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  }
}

const known = new Set<string>()
let loaded = false
watch([isReady, unseen], ([ready, list]) => {
  if (!ready) return
  for (const notification of list) {
    if (known.has(notification.id)) continue
    known.add(notification.id)
    if (!loaded) continue
    toast.add({
      title: `${notification.agentTitle}${notification.urgent ? ' (urgent)' : ''}`,
      description: truncate(notification.message, 200),
      icon: notification.urgent ? 'i-lucide-bell-ring' : 'i-lucide-bell',
      color: notification.urgent ? 'error' : 'primary',
      duration: notification.urgent ? 0 : 8000,
      actions: [{ label: 'Open', onClick: () => { open.value = true } }]
    })
  }
  loaded = true
}, { immediate: true })
</script>

<template>
  <USlideover v-model:open="open" title="Notifications" description="What agents asked you to see.">
    <UChip :show="unseen.length > 0" :text="unseen.length" size="3xl" color="primary" inset :class="props.collapsed ? '' : 'w-full'">
      <UButton
        icon="i-lucide-bell"
        :label="props.collapsed ? undefined : 'Notifications'"
        color="neutral"
        variant="ghost"
        :block="!props.collapsed"
        class="justify-start"
        :aria-label="`Notifications (${unseen.length} unseen)`"
      />
    </UChip>

    <template #body>
      <div class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <USwitch v-model="showSeen" label="Show seen" size="sm" />
          <UButton
            v-if="unseen.length"
            label="Mark all seen"
            icon="i-lucide-check-check"
            size="xs"
            color="neutral"
            variant="subtle"
            @click="markSeen()"
          />
        </div>

        <p v-if="!shown.length" class="py-8 text-center text-sm text-muted">
          Nothing new.
        </p>

        <UCard
          v-for="notification in shown"
          :key="notification.id"
          :ui="{ body: 'p-3 sm:p-3' }"
          :class="notification.seenAt ? 'opacity-60' : notification.urgent ? 'ring-error' : ''"
          data-testid="notification"
        >
          <div class="flex flex-col gap-2">
            <div class="flex items-start justify-between gap-2 text-xs text-muted">
              <span class="flex min-w-0 items-center gap-1">
                <UIcon v-if="notification.urgent" name="i-lucide-bell-ring" class="size-3.5 shrink-0 text-error" />
                <NuxtLink
                  v-if="notification.agentSessionId"
                  :to="`/agents/${notification.agentSessionId}`"
                  class="truncate font-medium text-highlighted hover:underline"
                  @click="open = false"
                >
                  {{ notification.agentTitle }}
                </NuxtLink>
                <span v-else class="truncate font-medium text-highlighted">{{ notification.agentTitle }}</span>
                <span class="shrink-0">· {{ relativeTime(notification.createdAt) }}</span>
              </span>
              <UButton
                v-if="!notification.seenAt"
                icon="i-lucide-check"
                size="xs"
                color="neutral"
                variant="ghost"
                aria-label="Mark seen"
                @click="markSeen([notification.id])"
              />
            </div>

            <MarkdownView :text="notification.message" class="text-sm" />

            <div v-if="notification.attachments.length" class="flex flex-col gap-2">
              <template v-for="(attachment, index) in notification.attachments" :key="index">
                <a
                  v-if="isImage(attachment.mimeType)"
                  :href="attachmentUrl(notification, index)"
                  target="_blank"
                  rel="noopener"
                >
                  <img
                    :src="attachmentUrl(notification, index)"
                    :alt="attachment.name"
                    class="max-h-64 rounded-md border border-default object-contain"
                  >
                </a>
                <UButton
                  v-else
                  :to="attachmentUrl(notification, index)"
                  target="_blank"
                  icon="i-lucide-paperclip"
                  :label="`${attachment.name} (${size(attachment.size)})`"
                  size="xs"
                  color="neutral"
                  variant="subtle"
                  class="self-start"
                />
              </template>
            </div>
          </div>
        </UCard>
      </div>
    </template>
  </USlideover>
</template>
