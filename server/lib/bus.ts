import { EventEmitter } from 'node:events'
import type { StreamEvent } from '../../shared/types'

/**
 * In-process fan-out for everything the UI needs to see live.
 * `/api/stream` (SSE) is the only consumer in the browser.
 */
class Bus extends EventEmitter {
  publish(event: StreamEvent) {
    this.emit('event', event)
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }
}

const globalKey = '__domo_bus__'
const g = globalThis as any
export const bus: Bus = g[globalKey] ?? (g[globalKey] = new Bus())
bus.setMaxListeners(0)
