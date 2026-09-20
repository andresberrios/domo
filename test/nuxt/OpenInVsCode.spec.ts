import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'

import OpenInVsCode from '~/components/OpenInVsCode.vue'
import type { DevEnvironment } from '~~/shared/types'

// `UTooltip` reads the provider context `UApp` installs, so mount inside one.
const Harness = defineComponent({
  props: { environment: { type: Object as () => DevEnvironment, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(OpenInVsCode, { environment: props.environment })
  })
})

let vscodeSshHost = ''

registerEndpoint('/api/settings', () => ({ vscodeSshHost }))

const PREFIX = 'vscode://vscode-remote/attached-container+'

function environment(overrides: Partial<DevEnvironment> = {}): DevEnvironment {
  return {
    id: 'env_1',
    projectId: 'proj_1',
    name: 'feature-auth',
    containerName: 'domo-env-1',
    containerId: null,
    workspacePath: '/workspaces/domo',
    hostWorkspacePath: null,
    configSource: 'generated',
    configPath: null,
    remoteUser: null,
    status: 'running',
    lastError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  } as DevEnvironment
}

function decoded(href: string) {
  const rest = href.slice(PREFIX.length)
  const hex = rest.slice(0, rest.indexOf('/'))
  const bytes = new Uint8Array((hex.match(/../g) ?? []).map(pair => parseInt(pair, 16)))
  return { target: JSON.parse(new TextDecoder().decode(bytes)), path: rest.slice(hex.length) }
}

beforeEach(() => {
  vscodeSshHost = ''
  // The component shares one keyed `useFetch` across the page, so the payload
  // outlives a test unless it is dropped.
  clearNuxtData('settings')
})

describe('OpenInVsCode', () => {
  it('links a running environment straight at its container', async () => {
    const component = await mountSuspended(Harness, { props: { environment: environment() } })

    const href = component.get('a').attributes('href')!
    expect(decoded(href)).toEqual({ target: { containerName: '/domo-env-1' }, path: '/workspaces/domo' })
  })

  it('carries the SSH host from settings into the encoded target', async () => {
    vscodeSshHost = 'you@server'

    const component = await mountSuspended(Harness, { props: { environment: environment() } })

    // The settings fetch is lazy, so the host lands on the link a tick later.
    await expect.poll(() => decoded(component.get('a').attributes('href')!).target).toEqual({
      containerName: '/domo-env-1',
      settings: { host: 'ssh://you@server' }
    })
  })

  it('offers nothing to navigate to while the environment is stopped', async () => {
    const component = await mountSuspended(Harness, { props: { environment: environment({ status: 'stopped' }) } })

    expect(component.find('a').exists()).toBe(false)
    expect(component.html()).not.toContain('vscode://')
    expect(component.get('button').attributes('disabled')).toBeDefined()
  })

  it('stays disabled when the environment has no container yet', async () => {
    const component = await mountSuspended(Harness, { props: { environment: environment({ containerName: '' }) } })

    expect(component.find('a').exists()).toBe(false)
  })
})
