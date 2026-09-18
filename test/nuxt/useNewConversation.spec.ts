import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useNewConversation } from '~/composables/useNewConversation'

/**
 * "New conversation" is the only way to get fresh context — there is no context
 * reset — so it has to create a row and open it, or say why it could not.
 */
const toastAdd = vi.fn()
let respond: () => unknown

// The router is the real one: replacing it takes Nuxt's own plugins down with it.
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))

registerEndpoint('/api/voice-sessions', { method: 'POST', handler: () => respond() })

let push: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  respond = () => ({ id: 'vs_new' })
  push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
})

describe('useNewConversation', () => {
  it('creates a conversation and opens it', async () => {
    const { creating, startConversation } = useNewConversation()

    const pending = startConversation()
    expect(creating.value).toBe(true)
    await pending

    expect(push).toHaveBeenCalledWith('/voice/vs_new')
    expect(creating.value).toBe(false)
  })

  it('stays put and explains itself when the server says no', async () => {
    respond = () => {
      throw createError({ statusCode: 503, statusMessage: 'Postgres is not reachable' })
    }
    const { creating, startConversation } = useNewConversation()

    await startConversation()

    expect(push).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not start a conversation',
      color: 'error'
    }))
    expect(creating.value).toBe(false)
  })
})
