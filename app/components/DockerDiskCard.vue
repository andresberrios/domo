<script setup lang="ts">
/**
 * How full the disk under Docker is, what Domo's shared environment caches
 * hold on it, and a way to free what they can give back. Domo cleans up by
 * itself once a day and when the disk runs low; this is for the person who
 * sees the warning and wants the space now.
 */
const toast = useToast()
const { disk, usedPercent } = useDockerDisk()

const busy = ref<'check' | 'clean' | null>(null)
async function act(action: 'check' | 'clean') {
  busy.value = action
  try {
    await $fetch(`/api/docker-disk/${action}`, { method: 'POST' })
  } catch (error: any) {
    toast.add({
      title: action === 'check' ? 'Could not measure the disk' : 'Could not free space',
      description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    busy.value = null
  }
}

const color = computed(() => {
  switch (disk.value?.level) {
    case 'critical': return 'error' as const
    case 'low': return 'warning' as const
    default: return 'success' as const
  }
})
const levelLabel = computed(() => {
  switch (disk.value?.level) {
    case 'critical': return 'Almost full'
    case 'low': return 'Running low'
    default: return 'Enough space'
  }
})
/** What Docker itself holds beside the caches, which Domo never removes. */
const dockerOwn = computed(() => (disk.value?.docker ?? []).filter(row => row.bytes > 0))
</script>

<template>
  <UCard id="docker-disk">
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="font-medium">Docker disk</span>
          <UBadge v-if="disk" :color="color" variant="subtle" :label="levelLabel" />
        </div>
        <div v-if="disk" class="flex items-center gap-2">
          <UButton
            label="Measure now"
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="subtle"
            :loading="busy === 'check'"
            :disabled="disk.cleaning"
            @click="act('check')"
          />
          <UButton
            :label="disk.reclaimableBytes > 0 ? `Free ${formatBytes(disk.reclaimableBytes)}` : 'Free space'"
            icon="i-lucide-eraser"
            :color="disk.level === 'ok' ? 'neutral' : 'primary'"
            :variant="disk.level === 'ok' ? 'subtle' : 'solid'"
            :loading="busy === 'clean' || disk.cleaning"
            @click="act('clean')"
          />
        </div>
      </div>
    </template>

    <p v-if="!disk" class="text-sm text-muted">
      Measured once an environment has been made: Domo looks at the disk a minute after it starts and every ten minutes after that.
    </p>

    <div v-else class="flex flex-col gap-4 text-sm">
      <div class="flex flex-col gap-1">
        <UProgress :model-value="usedPercent ?? 0" :color="color" size="sm" />
        <div class="text-muted">
          {{ formatBytes(disk.freeBytes) }} free of {{ formatBytes(disk.totalBytes) }} ({{ usedPercent }}% used), checked {{ relativeTime(disk.checkedAt) }}.
        </div>
      </div>

      <UAlert
        v-if="disk.level !== 'ok'"
        :color="color"
        variant="subtle"
        icon="i-lucide-hard-drive"
        :title="disk.level === 'critical' ? 'Builds and installs in environments are about to fail' : 'The disk under Docker is running low'"
        :description="disk.reclaimableBytes >= 100 * 1024 ** 2
          ? `Domo frees what its caches can give back by itself when the disk runs low: the pnpm packages no environment uses, and npm's and uv's downloads, which are fetched again when needed. Right now that is about ${formatBytes(disk.reclaimableBytes)}. Anything more has to come from Docker's own images, build cache and volumes below.`
          : `Domo's caches have nothing left to give back. The space has to come from Docker's own images, build cache and volumes below, or from retiring environments you no longer need.`"
      />

      <div v-if="disk.caches.length">
        <div class="mb-1 font-medium">Shared environment caches</div>
        <ul class="flex flex-col gap-1">
          <li v-for="cache in disk.caches" :key="cache.key" class="flex items-baseline justify-between gap-3">
            <span>{{ cache.label }}</span>
            <span class="shrink-0 tabular-nums text-muted">
              {{ formatBytes(cache.bytes) }}<template v-if="cache.reclaimable > 0">, {{ formatBytes(cache.reclaimable) }} freeable</template>
            </span>
          </li>
        </ul>
        <div class="mt-1 text-xs text-dimmed">
          Measured {{ relativeTime(disk.measuredAt) }}, counting each hardlinked file once.
        </div>
      </div>

      <div v-if="dockerOwn.length">
        <div class="mb-1 font-medium">Docker itself</div>
        <ul class="flex flex-col gap-1">
          <li v-for="row in dockerOwn" :key="row.type" class="flex items-baseline justify-between gap-3">
            <span>{{ row.type }}</span>
            <span class="shrink-0 tabular-nums text-muted">
              {{ formatBytes(row.bytes) }}<template v-if="row.reclaimable > 0">, {{ formatBytes(row.reclaimable) }} unused</template>
            </span>
          </li>
        </ul>
        <div class="mt-1 text-xs text-dimmed">
          Domo leaves these alone, since some are yours. <code>docker builder prune</code> and <code>docker image prune</code> free the unused part.
        </div>
      </div>

      <div v-if="disk.lastCleanupAt" class="text-muted">
        Last cleaned up {{ relativeTime(disk.lastCleanupAt) }}<template v-if="disk.lastCleanupLevel === 'pressure'">, download caches included</template>: {{ formatBytes(disk.lastFreedBytes) }} freed.
      </div>
      <UAlert
        v-if="disk.lastError"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="Part of the last cleanup did not run"
        :description="disk.lastError"
      />
    </div>
  </UCard>
</template>
