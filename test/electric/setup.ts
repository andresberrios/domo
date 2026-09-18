import { createFetch } from 'ofetch'

import { TEST_SERVER_ORIGIN } from './origin'

/**
 * Let the mounted app's `/api/…` requests reach the real Nitro server.
 *
 * The `nuxt` Vitest environment replaces `window.fetch` with one that routes
 * *relative* URLs into an in-memory h3 app — that is what makes
 * `registerEndpoint()` work, and it is exactly what this layer does not want.
 * Absolute URLs already fall through to Node's real `fetch`, so all that is
 * needed is to resolve `/api/…` against the document's origin, which is what a
 * browser would have done anyway.
 *
 * Everything else (Nuxt's build manifest, `/_nuxt/…`) is left with the in-memory
 * app: those are served out of the test environment's own virtual build, and a
 * real request for them would answer with a *different* build's manifest.
 */
const inner = globalThis.fetch

function rewrite(input: RequestInfo | URL): RequestInfo | URL {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('/api/')) return input
  const absolute = new URL(url, TEST_SERVER_ORIGIN).href
  return typeof input === 'string' || input instanceof URL ? absolute : new Request(absolute, input)
}

const forwarding: typeof fetch = (input, init) => inner(rewrite(input) as RequestInfo, init)

globalThis.fetch = forwarding
// `$fetch` captured the environment's fetch by value when the window was built.
globalThis.$fetch = createFetch({ fetch: forwarding }) as typeof globalThis.$fetch
