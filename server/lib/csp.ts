/**
 * The Content-Security-Policy, as defence in depth around the one place
 * untrusted text reaches the DOM: `MarkdownView`'s `v-html`, fed by coding-agent
 * output. `app/utils/markdown.ts` is what actually makes that safe; this is what
 * contains the next bug in it. Domo runs on the machine that runs coding agents
 * with shell and filesystem access, so script execution in the tab is not a
 * small problem.
 *
 * Kept free of Nitro imports so the policy can be asserted directly in a unit
 * test — `server/plugins/csp.ts` is the part that talks to the request.
 */

/** Hosts are echoed into the policy, so only accept what can appear in one. */
const SAFE_HOST = /^[A-Za-z0-9.\-[\]]+(:\d+)?$/

/**
 * `'self'` covers same-origin WebSockets in CSP3, but not in every browser that
 * ships one, so name the origin explicitly. An unusable `Host` — including one
 * carrying a `;` that would end the directive — falls back to `'self'` alone
 * rather than widening the policy.
 */
function socketOrigins(host: string | undefined): string[] {
  if (!host || !SAFE_HOST.test(host)) return []
  return [`ws://${host}`, `wss://${host}`]
}

export function contentSecurityPolicy(host: string | undefined, nonce: string): string {
  return [
    `default-src 'self'`,
    // The SPA shell carries inline scripts Nuxt writes itself (the importmap,
    // the colour-mode preamble and `window.__NUXT__.config`); the nonce is what
    // lets those run without opening the door to injected ones.
    // `blob:` is the microphone's AudioWorklet module, which `useVoiceChannel`
    // builds with `URL.createObjectURL`; a worklet module is checked against
    // `script-src`, not `worker-src` (measured in Chromium, not assumed).
    // `'wasm-unsafe-eval'` is Shiki's oniguruma engine: it permits WebAssembly
    // compilation and nothing else — `eval` and `new Function` stay blocked.
    `script-src 'self' 'nonce-${nonce}' blob: 'wasm-unsafe-eval'`,
    // `'unsafe-inline'`, and there is no honest way around it. Three separate
    // things need it, none of them ours:
    //   - Nuxt UI builds its entire colour palette at runtime and injects it as
    //     `<style id="nuxt-ui-colors">` (`@nuxt/ui/runtime/plugins/colors`).
    //     Blocked, the whole app renders in black and white.
    //   - Vaul (Nuxt UI's `UDrawer`) injects its `[data-vaul-drawer]` rules the
    //     first time a drawer mounts.
    //   - Shiki's dual-theme output carries `--shiki-light` / `--shiki-dark` in
    //     a `style` attribute on every token, and it reaches the DOM through
    //     `v-html`, so the browser parses and checks it.
    // Both `<style>` bodies are build-derived and could be hashed, but a hash
    // that drifts on a dependency bump fails silently and colourless, which is
    // worse than the CSS injection it would prevent. `script-src` is where the
    // teeth are, and that one stays closed.
    `style-src 'self' 'unsafe-inline'`,
    // Agent output legitimately quotes remote images, and Nuxt Icon's CSS mode
    // draws every icon from a `data:` mask. `http:` is deliberately absent: a
    // plaintext remote image is never a real need, and local ones are already
    // covered by `'self'`.
    `img-src 'self' data: https:`,
    // @nuxt/fonts downloads the webfonts at build time; nothing is fetched from
    // a font CDN at runtime.
    `font-src 'self'`,
    // `/api/shape` (Electric long-polls it) and `/api/voice/ws`.
    `connect-src ${['\'self\'', ...socketOrigins(host)].join(' ')}`,
    // Nothing spawns a worker. Naming `'self'` rather than letting this fall
    // back to `script-src` keeps the worklet's `blob:` exception from quietly
    // becoming a worker exception.
    `worker-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-src 'none'`,
    // Nothing here is meant to be embedded, and nothing posts a form anywhere.
    `frame-ancestors 'none'`,
    `form-action 'self'`
  ].join('; ')
}
