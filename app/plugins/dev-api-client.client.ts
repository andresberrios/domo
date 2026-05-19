/**
 * Dev-only: expose the auto-imported `apiClient` on `window` so the smoke
 * procedures (`await apiClient.coastSmoke.call()`, `apiClient.health.call()`,
 * …) are callable from the browser console / Playwright `browser_evaluate`,
 * where Nuxt auto-imports aren't in scope. No-op in production.
 */
export default defineNuxtPlugin(() => {
  if (import.meta.dev) {
    ;(window as unknown as { apiClient: typeof apiClient }).apiClient =
      apiClient
  }
})
