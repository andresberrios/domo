import { bus } from '../../server/lib/bus'
import type { StreamEvent } from '~~/shared/types'

/**
 * Nothing may write to Postgres without the bus hearing about it — that is how
 * the voice runtime learns what the coding agents are doing.
 */
export function captureBus() {
  const events: StreamEvent[] = []
  const stop = bus.subscribe(event => events.push(event))

  return {
    events,
    types: () => events.map(event => event.type),
    clear: () => events.splice(0, events.length),
    stop
  }
}
