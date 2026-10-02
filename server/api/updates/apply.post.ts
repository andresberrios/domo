import { updater } from '../../lib/updates'

/** Build the channel's tip and switch to it at the first quiet moment. */
export default defineEventHandler(async () => {
  if (!updater.installed) throw createError({ statusCode: 409, message: 'This Domo is a development server, not an installed one; there is nothing to update.' })
  updater.clearFailure()
  void updater.apply().catch(error => console.error('[updates] apply failed', error))
  return { requested: true }
})
