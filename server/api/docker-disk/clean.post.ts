import { cacheMaintenance } from '../../lib/dev-env/cache-maintenance'

/** Free what the shared caches can give back, now. The result arrives through the `docker_disk` shape. */
export default defineEventHandler(() => {
  const started = !cacheMaintenance.cleaning
  void cacheMaintenance.clean('pressure').catch(error => console.error('[caches] cleanup failed', error))
  return { started }
})
