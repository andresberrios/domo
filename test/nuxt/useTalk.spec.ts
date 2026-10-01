import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTalk } from '~/composables/useTalk'

/** Talk has to make a session and open it with the voice bar on, or say why it could not. */
const toastAdd = vi.fn()
let respond: () => unknown

// The router is the real one: replacing it takes Nuxt's own plugins down with it.
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))

registerEndpoint('/api/agents', { method: 'POST', handler: () => respond() })

let push: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  respond = () => ({ id: 'ag_new' })
  push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
  useAgentVoiceOpen().value = false
})

describe('useTalk', () => {
  it('creates a session and opens it with the voice bar on', async () => {
    const { creating, talk } = useTalk()

    const pending = talk()
    expect(creating.value).toBe(true)
    await pending

    expect(push).toHaveBeenCalledWith('/agents/ag_new')
    expect(useAgentVoiceOpen().value).toBe(true)
    expect(creating.value).toBe(false)
  })

  it('stays put and explains itself when the server says no', async () => {
    respond = () => {
      throw createError({ statusCode: 503, statusMessage: 'Postgres is not reachable' })
    }
    const { creating, talk } = useTalk()

    await talk()

    expect(push).not.toHaveBeenCalled()
    expect(useAgentVoiceOpen().value).toBe(false)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not start a session',
      color: 'error'
    }))
    expect(creating.value).toBe(false)
  })
})
