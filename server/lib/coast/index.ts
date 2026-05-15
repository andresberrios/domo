/**
 * Singleton coast client + a server-side "ensure reachable" helper.
 *
 * Read `coastApiUrl` from `runtimeConfig`. The default is
 * `http://127.0.0.1:31415`; override with the `DOMO_COAST_API_URL` env
 * var if coastd runs somewhere unusual.
 */
import { createCoastClient, type CoastClient } from './client'

let _client: CoastClient | null = null

export function coast(): CoastClient {
  if (_client) return _client
  const config = useRuntimeConfig()
  _client = createCoastClient({ baseUrl: config.coastApiUrl as string })
  return _client
}

export { CoastError } from './client'
export type * from './types'
