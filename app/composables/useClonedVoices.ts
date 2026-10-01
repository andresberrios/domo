import type { ClonedVoice } from '~~/shared/types'
import { CLONED_VOICE_PREFIX, POCKET_VOICES } from '~~/shared/agent-voice'

/** One request for every picker that lists them; refreshed by key after a change. */
export const CLONED_VOICES_KEY = 'cloned-voices'

export function useClonedVoices() {
  return useFetch<ClonedVoice[]>('/api/agent-voice/voices', { key: CLONED_VOICES_KEY, lazy: true, default: () => [] })
}

export const CLONED_VOICE_ICON = 'i-lucide-user-round'

/**
 * Pocket's voices for a picker: the user's own first, marked as theirs,
 * then the built-in ones. A stored clone that is gone keeps an entry, so the
 * picker does not show an empty choice while it is still the setting.
 */
export function pocketVoiceItems(clones: ClonedVoice[], selected: string) {
  const items = [
    ...clones.map(voice => ({ value: `${CLONED_VOICE_PREFIX}${voice.id}`, label: voice.name, description: 'Your voice', icon: CLONED_VOICE_ICON })),
    ...POCKET_VOICES.map(name => ({ value: name, label: name, description: undefined as string | undefined, icon: undefined as string | undefined }))
  ]
  if (selected && !items.some(item => item.value === selected)) {
    items.unshift({ value: selected, label: selected.startsWith(CLONED_VOICE_PREFIX) ? 'A deleted voice' : selected, description: 'No longer available', icon: undefined })
  }
  return items
}
