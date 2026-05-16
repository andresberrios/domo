/**
 * Markdown renderer for assistant text + reasoning, mirroring the chat
 * template's `Comark.ts`. Auto-imported as `<DomoComark>` (Domo prefix).
 *
 * The `highlight` plugin's `registerDefaultLanguages` defaults to true and
 * loads grammars on demand, so — unlike the template — we don't hand-import
 * `@shikijs/langs/*`; that keeps the dependency surface minimal (the
 * supply-chain-minimization call) and still highlights fenced code.
 */
import highlight from '@comark/nuxt/plugins/highlight'

export default defineComarkComponent({
  name: 'DomoComark',
  plugins: [highlight()],
  class: 'text-sm *:first:mt-0 *:last:mb-0',
})
