import { randomBytes } from 'node:crypto'

import { contentSecurityPolicy } from '../lib/csp'

/**
 * Attach the Content-Security-Policy (see `server/lib/csp.ts` for what each
 * directive is for) and give the document's inline scripts the nonce that lets
 * them run.
 *
 * Production builds only. Vite's dev server needs inline scripts, `eval` and
 * its own HMR socket, so a dev policy would have to be loose enough to prove
 * nothing — and a CSP that breaks `pnpm dev` is one that gets deleted.
 */
export default defineNitroPlugin((nitro) => {
  if (import.meta.dev) return

  nitro.hooks.hook('request', (event) => {
    const nonce = randomBytes(16).toString('base64')
    event.context.cspNonce = nonce
    setResponseHeader(
      event,
      'content-security-policy',
      contentSecurityPolicy(getRequestHeader(event, 'host'), nonce)
    )
  })

  // Nuxt writes its own inline scripts into the SPA shell and offers no nonce
  // hook, so stamp them here, once the renderer has built the document.
  nitro.hooks.hook('render:html', (html, { event }) => {
    const nonce = event.context.cspNonce
    if (!nonce) return
    for (const key of ['head', 'bodyPrepend', 'bodyAppend'] as const) {
      html[key] = html[key].map(chunk =>
        chunk.replace(/<script([\s>])/g, `<script nonce="${nonce}"$1`)
      )
    }
  })
})
