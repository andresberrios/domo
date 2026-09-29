import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { buildFeatures } from './config'
import { resourcePrefix, run } from './docker'
import type { DevEnvironmentConfig } from './types'

const DEVCONTAINER_BIN = (() => {
  try {
    const require = createRequire(process.argv[1] || import.meta.url)
    return join(dirname(require.resolve('@devcontainers/cli/package.json')), 'devcontainer.js')
  } catch (error) {
    console.error('[dev-env] could not resolve the Dev Container CLI:', error)
    return null
  }
})()

export function environmentImageName(environmentId: string): string {
  return `${resourcePrefix()}${environmentId}`.toLowerCase()
}

/**
 * The image a definition built, kept under a name of its own so the next
 * environment with the same definition is tagged from it instead of built:
 * the Dev Container CLI takes 5-8 s even when every layer is cached (it
 * resolves each Feature over the network), and a first build with a Feature
 * such as Caddy took 48 s. Each environment still gets its own tag, which is
 * what its row claims and what retiring it removes; the image stays under this
 * one.
 */
export function cachedImageName(key: string): string {
  return `${resourcePrefix()}image-${key}`.toLowerCase()
}

/**
 * A cached image older than this is built again: a Feature or a base tag such
 * as `latest` moves without the definition changing, and this bounds how long
 * an environment can be behind it. Also the age at which an unused one goes.
 */
export const CACHED_IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The devcontainer.json handed to `devcontainer build`. The CLI is used as an image
 * builder and nothing else, so this holds only what an image can carry: the base
 * (`image` or `build`) and the Features to bake in. Everything about *running* the
 * container is Domo's own business — see `container.ts`.
 */
export function generatedBuildConfig(input: {
  config: DevEnvironmentConfig
  name: string
  repoPath: string
}): Record<string, unknown> {
  const { config, repoPath } = input
  const generated: Record<string, unknown> = { name: input.name }
  if (config.build) {
    generated.build = {
      // Absolute, and pointing into the project's own checkout: the CLI is run from a
      // scratch folder, so a relative path would resolve against that instead.
      dockerfile: resolve(repoPath, config.build.dockerfile),
      context: resolve(repoPath, config.build.context),
      ...(config.build.args && { args: config.build.args }),
      ...(config.build.target && { target: config.build.target })
    }
  } else {
    generated.image = config.image
  }
  const features = buildFeatures(config)
  if (Object.keys(features).length) generated.features = features
  return generated
}

/** The CLI ends with a single JSON line saying how it went; everything before it is build log. */
function outcomeLine(stream: string): { outcome?: string, message?: string } | null {
  for (const line of stream.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line)
    } catch { /* a stray brace in the build log */ }
  }
  return null
}

/**
 * What makes two definitions build the same image: the generated config and
 * the id of the base image as this daemon has it, so pulling a newer base
 * builds again. Null for a Dockerfile (`build`): its context can change with
 * nothing in the definition changing, so it is always built, and Docker's own
 * layer cache is what makes that fast.
 */
async function definitionKey(input: { config: DevEnvironmentConfig, repoPath: string }): Promise<string | null> {
  if (input.config.build || !input.config.image) return null
  const base = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', input.config.image], { allowFailure: true })
    .then(output => output.stdout.trim(), () => '')
  if (!base.startsWith('sha256:')) return null
  const { name: _name, ...definition } = generatedBuildConfig({ ...input, name: '' })
  return createHash('sha256').update(JSON.stringify({ definition, base })).digest('hex').slice(0, 16)
}

/** When a cached image was built, or null when there is none by that name. */
async function builtAt(image: string): Promise<number | null> {
  const output = await run('docker', ['image', 'inspect', '--format', '{{.Created}}', image], { allowFailure: true })
    .catch(() => ({ stdout: '' }))
  const created = Date.parse(output.stdout.trim())
  return Number.isNaN(created) ? null : created
}

/**
 * Build the environment's image, or tag it from the cached image of the same
 * definition (`cachedImageName`). Always a build, never the bare `image`: that
 * is the only way a Feature gets injected, and one path is easier to trust than two.
 *
 * The CLI writes its Feature lockfile beside the config it was given, so the config goes
 * in a scratch `.devcontainer/` that is deleted afterwards — the user's checkout is only
 * ever read from (build context, Dockerfile).
 */
export async function buildEnvironmentImage(input: {
  config: DevEnvironmentConfig
  environmentId: string
  name: string
  repoPath: string
  /** Stops a build that is under way. A cached image is only tagged, which is too quick to be worth stopping. */
  signal?: AbortSignal
}): Promise<string> {
  if (!DEVCONTAINER_BIN) throw new Error('The packaged Dev Container CLI could not be found.')
  const imageName = environmentImageName(input.environmentId)
  const key = await definitionKey(input)
  if (key) {
    const cached = cachedImageName(key)
    const created = await builtAt(cached)
    if (created !== null && Date.now() - created < CACHED_IMAGE_MAX_AGE_MS) {
      await run('docker', ['tag', cached, imageName])
      return imageName
    }
  }
  await buildImage(input, imageName)
  if (key) await run('docker', ['tag', imageName, cachedImageName(key)])
  return imageName
}

async function buildImage(
  input: { config: DevEnvironmentConfig, name: string, repoPath: string, signal?: AbortSignal },
  imageName: string
): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'domo-dev-env-'))
  try {
    const configPath = join(scratch, '.devcontainer', 'devcontainer.json')
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, JSON.stringify(generatedBuildConfig(input), null, 2), 'utf8')
    // A build failure is reported as an `{"outcome":"error"}` line *and* a non-zero exit, and
    // that line is the only readable part of it — take the output either way.
    const output = await run(process.execPath, [
      DEVCONTAINER_BIN!, 'build',
      '--workspace-folder', scratch,
      '--config', configPath,
      '--image-name', imageName
    ], { allowFailure: true, signal: input.signal })
    const result = outcomeLine(output.stdout) ?? outcomeLine(output.stderr)
    if (result?.outcome !== 'success') {
      throw new Error(
        result?.message || output.stderr || 'The Dev Container CLI did not build an image.'
      )
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Untag the cached images older than `CACHED_IMAGE_MAX_AGE_MS`. An environment
 * built from one keeps it through its own tag, so this never takes an image
 * anything runs on; the next creation with that definition builds afresh.
 */
export async function collectCachedImages(): Promise<void> {
  const { stdout } = await run('docker', [
    'image', 'ls', '--format', '{{.Repository}}', '--filter', `reference=${resourcePrefix()}image-*`
  ], { allowFailure: true }).catch(() => ({ stdout: '' }))
  for (const image of new Set(stdout.split('\n').map(line => line.trim()).filter(Boolean))) {
    const created = await builtAt(image)
    if (created !== null && Date.now() - created >= CACHED_IMAGE_MAX_AGE_MS) {
      await run('docker', ['image', 'rm', image], { allowFailure: true }).catch(() => {})
    }
  }
}
