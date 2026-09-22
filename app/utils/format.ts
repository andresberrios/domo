export function relativeTime(value?: string | null): string {
  if (!value) return ''
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 90) return 'a minute ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(value).toLocaleDateString()
}

export function shortPath(path?: string | null, segments = 2): string {
  if (!path) return ''
  const trimmed = path.replace(/\/+$/, '')
  // The leading slash is not a segment of its own: without the filter `/a/b`
  // splits into three and gets an ellipsis promising a truncation that never
  // happened. Empty segments in the middle of a path are noise for the same reason.
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length <= segments) return trimmed || '/'
  return `…/${parts.slice(-segments).join('/')}`
}

export function truncate(value: string, max = 140): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

export const AGENT_STATUS_META: Record<string, { label: string, color: 'neutral' | 'primary' | 'warning' | 'error' | 'success', dot: string, icon: string }> = {
  idle: { label: 'Idle', color: 'neutral', dot: 'bg-muted', icon: 'text-dimmed' },
  starting: { label: 'Starting', color: 'primary', dot: 'bg-primary animate-pulse', icon: 'text-primary animate-pulse' },
  thinking: { label: 'Working', color: 'primary', dot: 'bg-primary animate-pulse', icon: 'text-primary animate-pulse' },
  'awaiting-permission': { label: 'Needs you', color: 'warning', dot: 'bg-warning animate-pulse', icon: 'text-warning animate-pulse' },
  error: { label: 'Error', color: 'error', dot: 'bg-error', icon: 'text-error' },
  stopped: { label: 'Stopped', color: 'neutral', dot: 'bg-muted', icon: 'text-dimmed' }
}

/**
 * What a dev environment's status looks like in the tree and on its page.
 *
 * `icon` is the colour the container glyph takes, mirroring what `dot` is for
 * an agent: a running environment has to read as *on* at a glance, which the
 * old always-dark `StatusDot` never did. `starting` is not in
 * `DevEnvironmentStatus` today but is answered for anyway — a status this map
 * has never heard of falls back to `stopped` rather than rendering nothing.
 */
export const ENVIRONMENT_STATUS_META: Record<string, { label: string, color: 'neutral' | 'primary' | 'warning' | 'error' | 'success', icon: string }> = {
  creating: { label: 'Creating', color: 'warning', icon: 'text-warning animate-pulse' },
  starting: { label: 'Starting', color: 'warning', icon: 'text-warning animate-pulse' },
  running: { label: 'Running', color: 'success', icon: 'text-primary' },
  stopped: { label: 'Stopped', color: 'neutral', icon: 'text-dimmed' },
  error: { label: 'Error', color: 'error', icon: 'text-error' }
}
