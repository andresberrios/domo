import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTalk } from '~/composables/useTalk'
import type { AgentSession, Assistant } from '~~/shared/types'

/**
 * Talk opens the default assistant with the voice bar on; with no assistant it
 * makes a session instead. Either way it lands on a page with the bar open, or
 * says why it could not.
 */
const toastAdd = vi.fn()
let respond: () => unknown
const created = vi.fn()

const assistants = ref<Assistant[]>([])
const assistantsReady = ref(true)
const sessions = ref<AgentSession[]>([])
let defaultAssistantId = ''

// The router is the real one: replacing it takes Nuxt's own plugins down with it.
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
mockNuxtImport('useAssistants', () => () => ({ assistants: computed(() => assistants.value), all: computed(() => assistants.value), isReady: assistantsReady }))
mockNuxtImport('useAgentSessions', () => () => ({ sessions: computed(() => sessions.value), all: computed(() => sessions.value), isReady: ref(true) }))
mockNuxtImport('useSettings', () => () => ({ data: computed(() => ({ defaultAssistantId })) }))

registerEndpoint('/api/agents', {
  method: 'POST',
  handler: () => {
    created()
    return respond()
  }
})

const assistant = (id: string, currentSessionId: string) =>
  ({ id, name: id, currentSessionId, archived: false, updatedAt: '2026-01-01T00:00:00.000Z' }) as Assistant
const session = (id: string, lastActivityAt: string) => ({ id, lastActivityAt, createdAt: lastActivityAt }) as AgentSession

let push: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  respond = () => ({ id: 'ag_new' })
  push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
  useAgentVoiceOpen().value = false
  assistants.value = []
  assistantsReady.value = true
  sessions.value = []
  defaultAssistantId = ''
})

describe('useTalk', () => {
  it('opens the assistant Settings names, with the voice bar on, and makes nothing', async () => {
    assistants.value = [assistant('as_a', 'ag_a'), assistant('as_b', 'ag_b')]
    sessions.value = [session('ag_a', '2026-01-01T00:00:00.000Z'), session('ag_b', '2026-06-01T00:00:00.000Z')]
    defaultAssistantId = 'as_a'

    await useTalk().talk()

    expect(push).toHaveBeenCalledWith('/assistants/as_a')
    expect(useAgentVoiceOpen().value).toBe(true)
    expect(created).not.toHaveBeenCalled()
  })

  it('opens the one talked to last when Settings names none', async () => {
    assistants.value = [assistant('as_a', 'ag_a'), assistant('as_b', 'ag_b')]
    sessions.value = [session('ag_a', '2026-01-01T00:00:00.000Z'), session('ag_b', '2026-06-01T00:00:00.000Z')]

    const { talk, assistant: target } = useTalk()
    expect(target.value?.id).toBe('as_b')
    await talk()

    expect(push).toHaveBeenCalledWith('/assistants/as_b')
  })

  it('waits for the assistants to sync rather than guessing there are none', async () => {
    assistantsReady.value = false
    const pending = useTalk().talk()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(created).not.toHaveBeenCalled()

    assistants.value = [assistant('as_a', 'ag_a')]
    assistantsReady.value = true
    await pending

    expect(push).toHaveBeenCalledWith('/assistants/as_a')
    expect(created).not.toHaveBeenCalled()
  })

  it('with no assistant, creates a session and opens it with the voice bar on', async () => {
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
