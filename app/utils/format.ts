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

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' })
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
const DATED = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })

/** "14:05:09", or "2:05:09 PM": when, within its day. */
export function clockTime(value?: string | null): string {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? CLOCK.format(date) : ''
}

/**
 * The same time in two pieces, for a narrow column: "4:52:09" and "AM", or
 * "16:52:09" and nothing where the clock has no day period.
 */
export function clockParts(value?: string | null): { time: string, period: string } {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return { time: '', period: '' }
  const parts = CLOCK.formatToParts(date)
  return {
    time: parts.filter(part => part.type !== 'dayPeriod').map(part => part.value).join('').trim(),
    period: parts.find(part => part.type === 'dayPeriod')?.value ?? ''
  }
}

/** The whole instant, for a tooltip. */
export function fullTime(value?: string | null): string {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? FULL.format(date) : ''
}

/** The local calendar day an instant falls on, as a comparable key. */
export function dayKey(value: string | number | Date): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** "Today", "Yesterday", "Monday, Oct 12" — or with the year, once it is not this one. */
export function dayLabel(value: string, today: string = dayKey(Date.now())): string {
  const date = new Date(value)
  if (dayKey(date) === today) return 'Today'
  const [year, month, day] = today.split('-').map(Number) as [number, number, number]
  if (dayKey(date) === dayKey(new Date(year, month - 1, day - 1))) return 'Yesterday'
  return (date.getFullYear() === year ? WEEKDAY : DATED).format(date)
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

/** Bytes as people read a disk: `7.8 GB`, `420 MB`. Binary units, as `df -h` and Docker Desktop show them. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** power
  return `${value >= 100 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`
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
  upgrading: { label: 'Upgrading', color: 'warning', icon: 'text-warning animate-pulse' },
  starting: { label: 'Starting', color: 'warning', icon: 'text-warning animate-pulse' },
  running: { label: 'Running', color: 'success', icon: 'text-primary' },
  stopped: { label: 'Stopped', color: 'neutral', icon: 'text-dimmed' },
  error: { label: 'Error', color: 'error', icon: 'text-error' }
}
