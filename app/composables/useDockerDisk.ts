import { useLiveQuery } from '@tanstack/vue-db'
import { dockerDiskCollection } from '~/lib/collections'
import type { DockerDisk } from '~~/shared/types'

/** The one `docker_disk` row, or null before the first measurement or on an install that has never made an environment. */
export function useDockerDisk() {
  const { data } = useLiveQuery(q => q.from({ disk: dockerDiskCollection() }))
  const disk = computed<DockerDisk | null>(() => {
    const row: any = data.value?.[0]
    if (!row) return null
    const number = (value: unknown) => (value === null || value === undefined ? null : Number(value))
    return {
      totalBytes: Number(row.total_bytes),
      freeBytes: Number(row.free_bytes),
      level: row.level,
      caches: Array.isArray(row.caches) ? row.caches : [],
      docker: Array.isArray(row.docker) ? row.docker : [],
      reclaimableBytes: Number(row.reclaimable_bytes),
      measuredAt: row.measured_at ?? null,
      checkedAt: row.checked_at,
      cleaning: row.cleaning === true || row.cleaning === 'true',
      lastCleanupAt: row.last_cleanup_at ?? null,
      lastCleanupLevel: row.last_cleanup_level ?? null,
      lastFreedBytes: number(row.last_freed_bytes),
      lastError: row.last_error ?? null,
      updatedAt: row.updated_at
    }
  })

  const usedPercent = computed(() => {
    const d = disk.value
    return d && d.totalBytes > 0 ? Math.round((1 - d.freeBytes / d.totalBytes) * 100) : null
  })

  /** The sidebar's line, only when the disk needs attention. */
  const headline = computed<string | null>(() => {
    const d = disk.value
    if (!d || d.level === 'ok') return null
    return `Docker disk ${usedPercent.value}% full`
  })

  return { disk, usedPercent, headline }
}
