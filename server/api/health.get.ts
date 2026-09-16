import { query } from '../lib/db'

const ELECTRIC_URL = process.env.ELECTRIC_URL || process.env.NUXT_ELECTRIC_URL || 'http://localhost:30000'

/** Are the two backing services (Postgres, Electric) actually up? */
export default defineEventHandler(async () => {
  const result = {
    db: false,
    electric: false,
    electricUrl: ELECTRIC_URL,
    message: ''
  }

  try {
    await query('select 1')
    result.db = true
  } catch (error) {
    result.message = error instanceof Error ? error.message : String(error)
  }

  try {
    const response = await fetch(new URL('/v1/health', ELECTRIC_URL), {
      signal: AbortSignal.timeout(2500)
    })
    result.electric = response.ok
  } catch {
    result.electric = false
  }

  return result
})
