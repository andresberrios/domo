import { useLiveQuery } from '@tanstack/vue-db'
import { appUpdateCollection } from '~/lib/collections'
import type { AppUpdate } from '~~/shared/types'

/**
 * The one `app_update` row, or null on a development server, which has no
 * release to update and writes no row.
 */
export function useAppUpdate() {
  const { data, isReady } = useLiveQuery(q => q.from({ update: appUpdateCollection() }))
  const update = computed<AppUpdate | null>(() => {
    const row: any = data.value?.[0]
    if (!row) return null
    return {
      installedCommit: row.installed_commit,
      installedAt: row.installed_at,
      channel: row.channel,
      targetCommit: row.target_commit ?? null,
      behind: row.behind === null || row.behind === undefined ? null : Number(row.behind),
      commits: Array.isArray(row.commits) ? row.commits : [],
      checkedAt: row.checked_at ?? null,
      state: row.state,
      blockers: Array.isArray(row.blockers) ? row.blockers : [],
      lastError: row.last_error ?? null,
      lastAppliedAt: row.last_applied_at ?? null,
      updatedAt: row.updated_at
    }
  })

  /** The one line the badge and the card both lead with, or null when there is nothing to say. */
  const headline = computed<string | null>(() => {
    const u = update.value
    if (!u) return null
    switch (u.state) {
      case 'building': return 'Building an update…'
      case 'ready': return 'Update built, restart pending'
      case 'restarting': return 'Restarting…'
      case 'failed': return 'Update failed'
      default:
        if (u.behind === null) return u.checkedAt ? 'Update available' : null
        if (u.behind === 0) return null
        return `${u.behind} commit${u.behind === 1 ? '' : 's'} behind`
    }
  })

  return { update, headline, isReady }
}
