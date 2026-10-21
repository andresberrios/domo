import type { TestProject } from 'vitest/node'

/**
 * Transform the whole Nuxt app, and every `nuxt` spec, before a single file
 * boots.
 *
 * Vitest transforms on the main thread, on demand, and caches the result for
 * the rest of the run. Left to demand, the first files to boot waited inside
 * their `setupNuxt` hook while that one thread transformed some 1,600 modules
 * for all of them at once, and the first test to mount a page waited inside
 * its 5 s for the page's components. Under load either ran out. Here the same
 * work has no deadline, and every file after it reads the cache.
 *
 * A module that fails to transform is skipped: the file that imports it
 * reports the real error.
 */
export default async function setup(project: TestProject) {
  const environment = project.vite.environments.client!
  const seen = new Set<string>()

  async function visit(url: string): Promise<void> {
    if (url.startsWith('/@id/__vite-browser-external')) return
    // What a transformed module imports, in the form it is served in.
    if (url.startsWith('/@id/')) url = url.slice('/@id/'.length).replace('__x00__', '\0')
    if (seen.has(url)) return
    seen.add(url)
    const result = await environment.transformRequest(url).catch(() => null)
    // `dynamicDeps` too: pages and components are imported lazily, at the
    // first mount, which is inside a test.
    await Promise.all([...result?.deps ?? [], ...result?.dynamicDeps ?? []].map(visit))
  }

  const entry = await environment.pluginContainer.resolveId('#app/nuxt-vitest-app-entry')
  const { testFiles } = await project.globTestFiles()
  await Promise.all([...entry ? [entry.id] : [], ...testFiles].map(visit))
}
