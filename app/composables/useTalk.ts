/**
 * Talk: the default assistant, opened with the voice bar on — the one Settings
 * names, else the one talked to last (`talkAssistant`). With no assistant at
 * all it is a fresh coding session in the default workspace, named by its
 * first words.
 */
export function useTalk() {
  const router = useRouter()
  const toast = useToast()
  const voiceOpen = useAgentVoiceOpen()
  const creating = ref(false)

  const { all: assistants, isReady } = useAssistants()
  const { all: sessions } = useAgentSessions()
  const { data: settings } = useSettings()

  const assistant = computed(() => talkAssistant(assistants.value, sessions.value, settings.value?.defaultAssistantId))

  async function talk() {
    creating.value = true
    try {
      // Before the assistants have synced, "none" would be a guess that starts
      // a session nobody asked for.
      if (!isReady.value) {
        await new Promise<void>((resolve) => {
          const stop = watch(isReady, (ready) => {
            if (!ready) return
            stop()
            resolve()
          })
        })
      }
      if (assistant.value) {
        voiceOpen.value = true
        await router.push(`/assistants/${assistant.value.id}`)
        return
      }
      const session = await $fetch<{ id: string }>('/api/agents', { method: 'POST', body: {} })
      voiceOpen.value = true
      await router.push(`/agents/${session.id}`)
    } catch (error: any) {
      toast.add({
        title: 'Could not start a session',
        description: error?.data?.statusMessage ?? error?.message,
        color: 'error'
      })
    } finally {
      creating.value = false
    }
  }

  return { creating, talk, assistant }
}
