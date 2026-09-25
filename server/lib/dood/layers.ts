import type { DoodRequest, ResponseTransform, StreamTransform } from './http'

/**
 * How a request is handled by the proxy: a stack of layers, outermost first,
 * each of which may do async work, rewrite the request (line, headers, body),
 * answer it itself, and register a transform for its response.
 *
 * This is the extension point for everything the proxy does. Scoping and
 * names are one layer (`scope-layer.ts`); publishing on the environment's
 * `localhost`, binds outside the checkout and `network_mode: host` are meant
 * to be further layers, each owning one concern:
 *
 * - `wantsBody` is asked before anything else, because the body has to be
 *   buffered *before* the first layer runs. Say yes only for JSON bodies you
 *   read or rewrite — a build context or an archive upload is a stream, and
 *   buffering it is the one thing a splice must not do.
 * - `handle(request, next)`: do pre-work, change `request`, call `next` (or do
 *   not, and `answer`), and wrap what comes back with `withResponse` to see
 *   the response. A layer placed *inside* the scope layer sees references
 *   already resolved to the environment's real ids and host names.
 * - `ResponseTransform.after` runs once the response has been delivered: the
 *   place to reconcile after a `start` / `stop` without delaying the client.
 */

export type Outcome =
  | {
    kind: 'forward'
    request: DoodRequest
    response?: ResponseTransform
    /**
     * Rewrite a body the proxy streams rather than buffers (an image archive
     * being loaded): it is re-sent chunked, since its length changes.
     */
    requestBody?: StreamTransform
  }
  | { kind: 'answer', status: number, body: unknown }

export type Next = (request: DoodRequest) => Promise<Outcome>

export interface DoodLayer {
  wantsBody?(request: DoodRequest): boolean
  handle(request: DoodRequest, next: Next): Promise<Outcome>
}

export const answer = (status: number, body: unknown): Outcome => ({ kind: 'answer', status, body })

/** Two transforms as one: `inner` sees the daemon's answer first, `outer` sees what `inner` made of it. */
export function combineTransforms(inner: ResponseTransform | undefined, outer: ResponseTransform): ResponseTransform {
  if (!inner) return outer
  return {
    ...((inner.json || outer.json) && {
      json: (body: unknown) => {
        const first = inner.json ? inner.json(body) : body
        return outer.json ? outer.json(first) : first
      }
    }),
    ...((inner.line || outer.line) && {
      line: (line: unknown) => {
        const first = inner.line ? inner.line(line) : line
        if (first === null) return null
        return outer.line ? outer.line(first) : first
      }
    }),
    // One owner each: two layers rewriting the same stream would have to agree on its framing.
    ...((inner.stream || outer.stream) && { stream: (outer.stream ?? inner.stream)! }),
    ...((inner.hijack || outer.hijack) && { hijack: (outer.hijack ?? inner.hijack)! }),
    ...((inner.after || outer.after) && {
      after: async (status: number) => {
        await inner.after?.(status)
        await outer.after?.(status)
      }
    })
  }
}

/** Attach a response transform to a forwarded outcome; an answered one has no daemon response to transform. */
export function withResponse(outcome: Outcome, transform: ResponseTransform): Outcome {
  if (outcome.kind !== 'forward') return outcome
  return { ...outcome, response: combineTransforms(outcome.response, transform) }
}

/** The whole stack as one call. The innermost `next` forwards the request as it stands. */
export function runLayers(layers: DoodLayer[], request: DoodRequest): Promise<Outcome> {
  const at = (index: number): Next => async (current) => {
    const layer = layers[index]
    if (!layer) return { kind: 'forward', request: current }
    return layer.handle(current, at(index + 1))
  }
  return at(0)(request)
}

export const layersWantBody = (layers: DoodLayer[], request: DoodRequest) =>
  layers.some(layer => layer.wantsBody?.(request))
