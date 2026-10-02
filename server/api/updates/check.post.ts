import { updater } from '../../lib/updates'

/** Look at the channel now. The result arrives through the `app_update` shape. */
export default defineEventHandler(async () => {
  if (!updater.installed) throw createError({ statusCode: 409, message: 'This Domo is a development server, not an installed one; there is nothing to update.' })
  void updater.check().catch(error => console.error('[updates] check failed', error))
  return { requested: true }
})
