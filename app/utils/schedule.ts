import type { CronJob, CronRunNowResult } from '~~/shared/types'

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const NUMBER = /^\d+$/

function clock(hour: number, minute: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
    .format(new Date(2000, 0, 1, hour, minute))
}

function list(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

function ordinal(day: number): string {
  const tens = day % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'
  return `${day}${suffix}`
}

/** Which days a weekday field names, or null when it is more than a plain list or range. */
function weekdays(field: string): string | null {
  if (field === '*') return 'Every day'
  if (field === '1-5') return 'Weekdays'
  if (field === '0,6' || field === '6,0') return 'Weekends'
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const [from, to = from] = part.split('-')
    if (!NUMBER.test(from ?? '') || !NUMBER.test(to ?? '')) return null
    for (let day = Number(from); day <= Number(to); day++) days.add(day % 7)
  }
  return list([...days].sort().map(day => DAY_NAMES[day]!))
}

/**
 * A five-field cron expression in words: "Weekdays at 9:00 AM". The common
 * shapes only; anything else is shown as it was written.
 */
export function cronInWords(expression: string): string {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return expression
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string]
  if (month !== '*') return expression

  if (day === '*' && weekday === '*') {
    if (minute === '*' && hour === '*') return 'Every minute'
    const everyMinutes = minute.match(/^\*\/(\d+)$/)
    if (everyMinutes && hour === '*') return `Every ${everyMinutes[1]} minutes`
    if (NUMBER.test(minute) && hour === '*') return `Every hour at :${minute.padStart(2, '0')}`
    const everyHours = hour.match(/^\*\/(\d+)$/)
    if (NUMBER.test(minute) && everyHours) return `Every ${everyHours[1]} hours at :${minute.padStart(2, '0')}`
  }

  if (!NUMBER.test(minute)) return expression
  const hours = hour.split(',')
  if (!hours.every(item => NUMBER.test(item))) return expression
  const at = list(hours.map(item => clock(Number(item), Number(minute))))

  if (day === '*') {
    const days = weekdays(weekday)
    return days ? `${days} at ${at}` : expression
  }
  if (NUMBER.test(day) && weekday === '*') return `Monthly on the ${ordinal(Number(day))} at ${at}`
  return expression
}

/** When a job fires, in words, with its zone when that is not the viewer's. */
export function scheduleInWords(job: Pick<CronJob, 'scheduleType' | 'cronExpression' | 'timezone' | 'runAt'>): string {
  if (job.scheduleType === 'once') {
    return job.runAt
      ? `Once, ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(job.runAt))}`
      : 'Once'
  }
  const words = cronInWords(job.cronExpression ?? '')
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  return job.timezone && job.timezone !== local ? `${words} (${job.timezone})` : words
}

/** "in 5m", "in 3h", "in 2d": how long until an instant. */
export function timeUntil(value?: string | null, now = Date.now()): string {
  if (!value) return ''
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((then - now) / 60_000)
  if (minutes < 1) return 'any moment'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

/**
 * What a Run now did, for its toast. "Prompted" covers an idle agent and an
 * interrupted turn alike: the delivery result does not tell them apart.
 */
export function runNowOutcome(result: Pick<CronRunNowResult, 'outcome'>): string {
  if (result.outcome === 'queued') return 'Queued: it runs when the current turn ends.'
  if (result.outcome === 'steered') return 'Delivered into the running turn.'
  return 'Delivered: a turn started.'
}
