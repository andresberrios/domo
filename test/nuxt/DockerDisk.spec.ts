import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { computed, defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DockerDiskBadge from '~/components/DockerDiskBadge.vue'
import DockerDiskCard from '~/components/DockerDiskCard.vue'
import type { DockerDisk } from '~~/shared/types'

/**
 * The warning has to show before the disk is full, say what freeing would
 * give back, and the button has to reach the server; the rest arrives
 * through the `docker_disk` shape.
 */

const GB = 1024 ** 3
const row = ref<DockerDisk | null>(null)
mockNuxtImport('useDockerDisk', () => () => ({
  disk: row,
  usedPercent: computed(() => row.value ? Math.round((1 - row.value.freeBytes / row.value.totalBytes) * 100) : null),
  headline: computed(() => row.value && row.value.level !== 'ok' ? `Docker disk ${Math.round((1 - row.value.freeBytes / row.value.totalBytes) * 100)}% full` : null)
}))

const cleaned = vi.fn()
registerEndpoint('/api/docker-disk/clean', {
  method: 'POST',
  handler: () => {
    cleaned()
    return { started: true }
  }
})

function disk(overrides: Partial<DockerDisk> = {}): DockerDisk {
  return {
    totalBytes: 58 * GB,
    freeBytes: 7.5 * GB,
    level: 'low',
    caches: [
      { key: 'pnpm-store', label: 'pnpm package store', bytes: 5.8 * GB, reclaimable: 2.45 * GB },
      { key: 'npm', label: 'npm cache', bytes: 1.28 * GB, reclaimable: 1.28 * GB }
    ],
    docker: [{ type: 'Build Cache', bytes: 9 * GB, reclaimable: 6 * GB }],
    reclaimableBytes: 3.73 * GB,
    measuredAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    cleaning: false,
    lastCleanupAt: null,
    lastCleanupLevel: null,
    lastFreedBytes: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

const harness = (component: any) => defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(component, { collapsed: false }) })
})

beforeEach(() => {
  cleaned.mockClear()
  row.value = null
})

describe('DockerDiskBadge', () => {
  it('says nothing while there is room, and warns when the disk runs low', async () => {
    row.value = disk({ level: 'ok', freeBytes: 30 * GB })
    const quiet = await mountSuspended(harness(DockerDiskBadge))
    expect(quiet.text()).toBe('')

    row.value = disk()
    const warning = await mountSuspended(harness(DockerDiskBadge))
    expect(warning.text()).toContain('Docker disk 87% full')
  })
})

describe('DockerDiskCard', () => {
  it('says what freeing would give back, cache by cache, and frees it on request', async () => {
    row.value = disk()
    const card = await mountSuspended(harness(DockerDiskCard))

    expect(card.text()).toContain('7.5 GB free of 58.0 GB')
    expect(card.text()).toContain('2.5 GB freeable')
    expect(card.text()).toContain('Build Cache')
    const button = card.findAll('button').find(candidate => candidate.text() === 'Free 3.7 GB')
    expect(button, 'the card should offer to free the space').toBeTruthy()
    await button!.trigger('click')

    await vi.waitFor(() => expect(cleaned).toHaveBeenCalledTimes(1))
  })

  it('shows what part of the last cleanup failed', async () => {
    row.value = disk({ level: 'ok', lastCleanupAt: new Date().toISOString(), lastCleanupLevel: 'routine', lastFreedBytes: GB, lastError: 'uv: took longer than 5 minutes' })
    const card = await mountSuspended(harness(DockerDiskCard))

    expect(card.text()).toContain('1.0 GB freed')
    expect(card.text()).toContain('uv: took longer than 5 minutes')
  })
})
