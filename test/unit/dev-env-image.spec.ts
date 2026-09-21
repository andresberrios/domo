import { describe, expect, it } from 'vitest'

import { defaultEnvironmentConfig, DIND_FEATURE } from '../../server/lib/dev-env/config'
import { generatedBuildConfig } from '../../server/lib/dev-env/image'

/**
 * The Dev Container CLI is used as an image builder and nothing else, so the config it
 * is handed must carry only what an image can hold. Anything else there would be a
 * setting Domo pretends to honour and then ignores when it runs the container itself.
 */

const repoPath = '/home/dev/projects/api'

describe('generatedBuildConfig', () => {
  it('passes an image through with the Features to bake in', () => {
    expect(generatedBuildConfig({ config: defaultEnvironmentConfig(), name: 'API work', repoPath })).toEqual({
      name: 'API work',
      image: defaultEnvironmentConfig().image,
      features: {
        'ghcr.io/devcontainers/features/node:1': { version: '22' },
        'ghcr.io/devcontainers/features/github-cli:1': { version: 'latest' },
        [DIND_FEATURE]: { version: 'latest' }
      }
    })
  })

  it('makes the Dockerfile and its context absolute, against the project\'s own checkout', () => {
    const config = {
      ...defaultEnvironmentConfig(),
      image: undefined,
      features: {},
      docker: false,
      build: { dockerfile: '.devcontainer/Dockerfile', context: '.', args: { MARK: 'yes' }, target: 'dev' }
    }

    expect(generatedBuildConfig({ config, name: 'api', repoPath })).toEqual({
      name: 'api',
      build: {
        dockerfile: `${repoPath}/.devcontainer/Dockerfile`,
        context: repoPath,
        args: { MARK: 'yes' },
        target: 'dev'
      }
    })
  })

  it('carries nothing about running the container', () => {
    const config = {
      ...defaultEnvironmentConfig(),
      features: {},
      docker: false,
      remoteUser: 'dev',
      containerEnv: { A: 'b' },
      forwardPorts: [3000],
      portsAttributes: { 3000: { label: 'web' } },
      postCreateCommand: 'pnpm install'
    }

    expect(Object.keys(generatedBuildConfig({ config, name: 'api', repoPath })).sort())
      .toEqual(['image', 'name'])
  })
})
