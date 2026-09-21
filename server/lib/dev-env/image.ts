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
 * Build the environment's image. Always a build, even for a bare `image`: that is the
 * only way a Feature gets injected, and one path is easier to trust than two.
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
}): Promise<string> {
  if (!DEVCONTAINER_BIN) throw new Error('The packaged Dev Container CLI could not be found.')
  const imageName = environmentImageName(input.environmentId)
  const scratch = await mkdtemp(join(tmpdir(), 'domo-dev-env-'))
  try {
    const configPath = join(scratch, '.devcontainer', 'devcontainer.json')
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, JSON.stringify(generatedBuildConfig(input), null, 2), 'utf8')
    // A build failure is reported as an `{"outcome":"error"}` line *and* a non-zero exit, and
    // that line is the only readable part of it — take the output either way.
    const output = await run(process.execPath, [
      DEVCONTAINER_BIN, 'build',
      '--workspace-folder', scratch,
      '--config', configPath,
      '--image-name', imageName
    ], { allowFailure: true })
    const result = outcomeLine(output.stdout) ?? outcomeLine(output.stderr)
    if (result?.outcome !== 'success') {
      throw new Error(
        result?.message || output.stderr || 'The Dev Container CLI did not build an image.'
      )
    }
    return imageName
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function removeImage(imageName: string): Promise<void> {
  await run('docker', ['image', 'rm', imageName], { allowFailure: true }).catch(() => {})
}
