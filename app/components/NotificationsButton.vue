<script setup lang="ts">
import type { DomoNotification } from '~~/shared/types'

/**
 * What agents asked the human to see (`notify_supervisor`), kept until it has
 * been seen: a line in one agent's transcript is somewhere nobody is looking.
 *
 * The sidebar button carries the unseen count; a new one also raises a toast,
 * but only one that arrives while the page is open — the backlog is the
 * badge's job, not a burst of toasts on every load.
 */
const props = withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const { notifications, unseen } = useNotifications()
const toast = useToast()
const open = ref(false)
const showSeen = ref(false)

const count = computed(() => (unseen.value.length > 999 ? '999+' : String(unseen.value.length)))
const label = computed(() => `Notifications (${unseen.value.length} unseen)`)

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

// Only what arrives while the page is open is toasted. Readiness is no
// guide to that — the rows can land after the collection says it is ready —
// so the test is the notification's own time, with a little slack for clocks.
const openedAt = Date.now() - 10_000
const toasted = new Set<string>()
watch(unseen, (list) => {
  for (const notification of list) {
    if (toasted.has(notification.id) || Date.parse(notification.createdAt) < openedAt) continue
    toasted.add(notification.id)
    toast.add({
      title: `${notification.agentTitle}${notification.urgent ? ' (urgent)' : ''}`,
      description: truncate(notification.message, 200),
      icon: notification.urgent ? 'i-lucide-bell-ring' : 'i-lucide-bell',
      color: notification.urgent ? 'error' : 'primary',
      duration: notification.urgent ? 0 : 8000,
      actions: [{ label: 'Open', onClick: () => { open.value = true } }]
    })
  }
}, { immediate: true })
</script>

<template>
  <USlideover v-model:open="open" title="Notifications" description="What agents asked you to see.">
    <!--
      Expanded, the count is a badge right after the label; collapsed, there is
      no label, so it sits on the icon's corner. Both are sized to hold three
      digits, and a count beyond that reads "999+".
    -->
    <UChip
      v-if="props.collapsed"
      :show="unseen.length > 0"
      :text="count"
      color="primary"
      size="3xl"
      inset
      :ui="{ base: 'h-4 min-w-4 px-1 text-[10px] leading-none' }"
    >
      <UButton
        icon="i-lucide-bell"
        color="neutral"
        variant="ghost"
        :aria-label="label"
      />
    </UChip>
    <UButton
      v-else
      icon="i-lucide-bell"
      label="Notifications"
      color="neutral"
      variant="ghost"
      block
      class="justify-start"
      :aria-label="label"
    >
      <template v-if="unseen.length" #trailing>
        <UBadge :label="count" color="primary" size="sm" class="min-w-5 justify-center rounded-full tabular-nums" />
      </template>
    </UButton>

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
