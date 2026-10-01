/**
 * Talk: a fresh coding session in the default workspace, opened with the
 * voice bar on. The session is the whole conversation, and its first words
 * name it.
 */
export function useTalk() {
  const router = useRouter()
  const toast = useToast()
  const voiceOpen = useAgentVoiceOpen()
  const creating = ref(false)

  async function talk() {
    creating.value = true
    try {
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

  return { creating, talk }
}
