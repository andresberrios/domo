import { bus } from '../lib/bus'
import { patchSettings } from '../lib/settings'
import type { AppSettings } from '../../shared/types'

export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<AppSettings>>(event)
  const settings = await patchSettings(body ?? {})
  bus.publish({ type: 'settings-changed' })
  return settings
})
