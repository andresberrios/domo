import { useLiveQuery } from '@tanstack/vue-db'
import { boardDraftsCollection, boardElementsCollection, boardsCollection } from '~/lib/collections'
import { draftChangeCount, effectiveDraft, isCleared, sortBoardElements } from '~~/shared/board'
import type { Board, BoardDraft, BoardElement, BoardGroup } from '~~/shared/types/board'

function isUnseen(row: any): boolean {
  return !!row?.agent_changed_at && (!row.seen_at || row.agent_changed_at > row.seen_at)
}

/** Every board's row, by owner. */
function useBoardRows() {
  const { data } = useLiveQuery(q => q.from({ board: boardsCollection() }))
  const rows = computed(() => new Map<string, any>((data.value ?? []).map((row: any) => [row.owner_id, row])))
  return { rows }
}

/** The boards the agent has changed since the human last looked, by owner: the sidebar's dots. */
export function useUnseenBoards() {
  const { rows } = useBoardRows()
  return computed(() => new Set([...rows.value.values()].filter(isUnseen).map(row => row.owner_id as string)))
}

function toElement(row: any): BoardElement {
  return {
    id: row.id,
    group: row.group_title ?? null,
    position: Number(row.position),
    content: row.content,
    response: row.response ?? {},
    thread: row.thread ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const DRAFT_SAVE_MS = 400

/**
 * One status board, as Electric streams it, and the human's side of it.
 *
 * A draft is a row too, so it outlives a reload and shows on another device.
 * What this tab has just changed is held locally until the row comes back
 * saying the same, so a click shows at once and typing is never overwritten
 * by an older copy of itself on its way back.
 */
export function useBoard(ownerId: MaybeRefOrGetter<string | null | undefined>) {
  const toast = useToast()
  const id = computed(() => toValue(ownerId) || null)

  const { rows: boardRows } = useBoardRows()
  const { data: elementRows, isReady } = useLiveQuery(
    q => id.value ? q.from({ element: boardElementsCollection(id.value) }) : undefined,
    [id]
  )
  const { data: draftRows } = useLiveQuery(
    q => id.value ? q.from({ draft: boardDraftsCollection(id.value) }) : undefined,
    [id]
  )

  const board = computed<Board | null>(() => {
    if (!id.value) return null
    const row: any = boardRows.value.get(id.value)
    const groups: BoardGroup[] = row?.groups ?? []
    return {
      ownerId: id.value,
      headline: row?.headline ?? null,
      groups,
      folds: row?.folds ?? {},
      elements: sortBoardElements((elementRows.value ?? []).map(toElement), groups),
      agentChangedAt: row?.agent_changed_at ?? null,
      seenAt: row?.seen_at ?? null
    }
  })

  /** The agent has changed the board since the human last looked. */
  const unseen = computed(() => !!id.value && isUnseen(boardRows.value.get(id.value)))

  const local = reactive(new Map<string, BoardDraft>())
  const synced = computed(() => new Map<string, BoardDraft>((draftRows.value ?? []).map((row: any) => [row.element_id, row.draft])))
  watch(synced, (rows) => {
    for (const [elementId, draft] of local) {
      if (JSON.stringify(rows.get(elementId) ?? {}) === JSON.stringify(draft)) local.delete(elementId)
    }
  })
  watch(id, () => local.clear())

  function draftFor(elementId: string): BoardDraft {
    return local.get(elementId) ?? synced.value.get(elementId) ?? {}
  }

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  async function save(elementId: string) {
    timers.delete(elementId)
    const owner = id.value
    if (!owner) return
    const draft = local.get(elementId) ?? {}
    try {
      await $fetch(`/api/boards/${owner}/drafts/${encodeURIComponent(elementId)}`, {
        method: 'PUT',
        body: { draft: Object.keys(draft).length ? draft : null }
      })
    } catch (error: any) {
      toast.add({ title: 'Could not save your change', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
    }
  }

  /** Change one element's draft. Typing waits for a pause before it is saved; a click is saved at once. */
  function setDraft(elementId: string, draft: BoardDraft, options: { typing?: boolean } = {}) {
    const clean: BoardDraft = {}
    for (const [key, value] of Object.entries(draft) as Array<[keyof BoardDraft, any]>) {
      if (value === undefined || value === false || value === '' || (Array.isArray(value) && !value.length)) continue
      if (key === 'answer' && !value.options?.length && !value.text) continue
      ;(clean as any)[key] = value
    }
    local.set(elementId, clean)
    clearTimeout(timers.get(elementId))
    if (options.typing) timers.set(elementId, setTimeout(() => save(elementId), DRAFT_SAVE_MS))
    else void save(elementId)
  }

  function updateDraft(elementId: string, patch: Partial<BoardDraft>, options: { typing?: boolean } = {}) {
    setDraft(elementId, { ...draftFor(elementId), ...patch }, options)
  }

  /** Save anything still waiting on a typing pause. */
  async function flush() {
    const waiting = [...timers.keys()]
    for (const elementId of waiting) clearTimeout(timers.get(elementId))
    await Promise.all(waiting.map(save))
  }
  onScopeDispose(() => { void flush() })

  /** Pending changes per element, counted as the server will read them. */
  const pending = computed(() => {
    const counts = new Map<string, number>()
    for (const element of board.value?.elements ?? []) {
      const count = draftChangeCount(effectiveDraft(element, draftFor(element.id)))
      if (count) counts.set(element.id, count)
    }
    return counts
  })
  const pendingCount = computed(() => [...pending.value.values()].reduce((sum, count) => sum + count, 0))

  const visible = computed(() => (board.value?.elements ?? []).filter(element => !isCleared(element)))
  const cleared = computed(() => (board.value?.elements ?? []).filter(isCleared))

  const submitting = ref(false)
  async function submit(): Promise<boolean> {
    if (!id.value || submitting.value) return false
    submitting.value = true
    try {
      await flush()
      await $fetch(`/api/boards/${id.value}/submit`, { method: 'POST' })
      local.clear()
      return true
    } catch (error: any) {
      toast.add({ title: 'Could not send your changes', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
      return false
    } finally {
      submitting.value = false
    }
  }

  async function discard() {
    if (!id.value) return
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const element of board.value?.elements ?? []) local.set(element.id, {})
    try {
      await $fetch(`/api/boards/${id.value}/drafts`, { method: 'DELETE' })
    } catch (error: any) {
      toast.add({ title: 'Could not discard your changes', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
    }
  }

  /** Fold or unfold a group, for every device; see `isFolded`. */
  async function setFolded(group: string, folded: boolean) {
    if (!id.value) return
    await $fetch(`/api/boards/${id.value}/fold`, { method: 'POST', body: { group, folded } }).catch((error: any) => {
      toast.add({ title: 'Could not fold the group', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
    })
  }

  async function markSeen() {
    if (!id.value || !unseen.value) return
    await $fetch(`/api/boards/${id.value}/seen`, { method: 'POST' }).catch(() => {})
  }

  return {
    board,
    isReady,
    unseen,
    visible,
    cleared,
    draftFor,
    setDraft,
    updateDraft,
    pending,
    pendingCount,
    submitting,
    submit,
    discard,
    setFolded,
    markSeen
  }
}

export type BoardState = ReturnType<typeof useBoard>
