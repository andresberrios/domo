import { cacheMaintenance } from '../../lib/dev-env/cache-maintenance'

/** Measure the disk and the caches now. The result arrives through the `docker_disk` shape. */
export default defineEventHandler(() => {
  void cacheMaintenance.measure().catch(error => console.error('[caches] measuring failed', error))
  return { requested: true }
})
