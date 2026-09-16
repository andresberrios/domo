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
  const parts = path.replace(/\/+$/, '').split('/')
  return parts.length <= segments ? path : `…/${parts.slice(-segments).join('/')}`
}

export function truncate(value: string, max = 140): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

export const AGENT_STATUS_META: Record<string, { label: string, color: 'neutral' | 'primary' | 'warning' | 'error' | 'success', dot: string }> = {
  idle: { label: 'Idle', color: 'neutral', dot: 'bg-muted' },
  starting: { label: 'Starting', color: 'primary', dot: 'bg-primary animate-pulse' },
  thinking: { label: 'Working', color: 'primary', dot: 'bg-primary animate-pulse' },
  'awaiting-permission': { label: 'Needs you', color: 'warning', dot: 'bg-warning animate-pulse' },
  error: { label: 'Error', color: 'error', dot: 'bg-error' },
  stopped: { label: 'Stopped', color: 'neutral', dot: 'bg-muted' }
}
