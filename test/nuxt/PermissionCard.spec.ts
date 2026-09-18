import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import PermissionCard from '~/components/PermissionCard.vue'
import { permission } from '../helpers/events'

/**
 * Answering from the UI is one of the three ways a permission row gets
 * resolved, and the only one a person clicks. The route is stubbed; what
 * matters is that the exact `optionId` the agent offered goes back out.
 */
const answered = vi.fn()

registerEndpoint('/api/permissions/pm_1/answer', {
  method: 'POST',
  handler: async (event) => {
    answered(await readBody(event))
    return { ok: true }
  }
})

const request = permission({
  id: 'pm_1',
  title: 'Run `pnpm install`',
  options: [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' }
  ],
  toolCall: { title: 'Bash', rawInput: { command: 'pnpm install --frozen-lockfile' } }
})

beforeEach(() => answered.mockClear())

describe('PermissionCard', () => {
  it('shows what the agent wants to do, and the command it would run', async () => {
    const component = await mountSuspended(PermissionCard, { props: { permission: request } })

    expect(component.text()).toContain('Run `pnpm install`')
    expect(component.find('pre').text()).toBe('pnpm install --frozen-lockfile')
  })

  it('renders one button per offered option', async () => {
    const component = await mountSuspended(PermissionCard, { props: { permission: request } })

    expect(component.findAll('button').map(button => button.text()))
      .toEqual(['Allow once', 'Always allow', 'Deny'])
  })

  it('sends the exact optionId that was offered', async () => {
    const component = await mountSuspended(PermissionCard, { props: { permission: request } })

    await component.findAll('button')[1]!.trigger('click')

    await expect.poll(() => answered.mock.calls).toEqual([[{ optionId: 'allow_always' }]])
  })

  it('shows the diff of an edit the agent is asking to make', async () => {
    const component = await mountSuspended(PermissionCard, {
      props: {
        permission: permission({
          id: 'pm_1',
          toolCall: {
            title: 'Write',
            content: [{ type: 'diff', path: 'src/index.ts', oldText: 'a', newText: 'b' }]
          }
        })
      }
    })

    expect(component.text()).toContain('src/index.ts')
    expect(component.find('pre').exists()).toBe(false)
  })

  it('says the request can also be answered out loud', async () => {
    const component = await mountSuspended(PermissionCard, { props: { permission: request } })

    expect(component.text()).toContain('say it out loud')
  })
})
