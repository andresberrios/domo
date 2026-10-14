import { updater } from '../../lib/updates'

/**
 * Restart onto the built version now, whatever is running. Only meaningful
 * in the `ready` state; answers whether the restart was started.
 */
export default defineEventHandler(async () => {
  if (!updater.installed) throw createError({ statusCode: 409, message: 'This Domo is a development server, not an installed one; there is nothing to update.' })
  const restarting = await updater.tryRestart(true)
  return { restarting }
})
