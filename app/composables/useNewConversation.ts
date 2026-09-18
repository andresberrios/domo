/** Create a voice conversation with a clean context and open it. */
export function useNewConversation() {
  const router = useRouter()
  const toast = useToast()
  const creating = ref(false)

  async function startConversation() {
    creating.value = true
    try {
      const session = await $fetch<{ id: string }>('/api/voice-sessions', { method: 'POST', body: {} })
      await router.push(`/voice/${session.id}`)
    } catch (error: any) {
      toast.add({
        title: 'Could not start a conversation',
        description: error?.data?.statusMessage ?? error?.message,
        color: 'error'
      })
    } finally {
      creating.value = false
    }
  }

  return { creating, startConversation }
}
