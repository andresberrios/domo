<script setup lang="ts">
import { observeElementRect, useVirtualizer } from '@tanstack/vue-virtual'
import { useNow } from '@vueuse/core'
import type { AgentEvent, AgentSession, PendingPermission } from '~~/shared/types'
import type { CondensedItem, TranscriptItem } from '~/utils/agentTranscript'

const props = withDefaults(defineProps<{
  /** `null` while the session is still being made from a draft, which counts as working. */
  session: AgentSession | null
  events: AgentEvent[]
  permissions: PendingPermission[]
  /** An assistant's face and name, for its side of the conversation. */
  avatar?: { src?: string, alt: string }
  /** Every event is loaded; false while earlier pages are still to be asked for (see `useSyncedLog`). */
  complete?: boolean
  loadingEarlier?: boolean
}>(), { avatar: undefined, complete: true, loadingEarlier: false })

const emit = defineEmits<{
  /** The reader is near the top of what is loaded, and there is more above it. */
  loadEarlier: []
}>()

/**
 * Two passes, and only the first one is about the log: `buildTranscript()` says
 * what happened, `condenseTranscript()` decides what to draw.
 *
 * Both fold the log from the beginning, so both hand back a fresh object for
 * every line on every delta. The `reconcile*` passes put the previous objects
 * back wherever nothing changed, which is what stops a streamed word from
 * re-rendering — and re-highlighting — the rows above it. The caches are plain
 * variables: they are memoisation, not state, and nothing may re-run when they
 * are written.
 */
let lastBuilt: TranscriptItem[] = []
let lastItems: CondensedItem[] = []

const built = computed(() => {
  lastBuilt = reconcileTranscript(lastBuilt, buildTranscript(props.events, props.permissions))
  return lastBuilt
})

/** A trailing thought is the live tail only while the agent is still working. */
const live = computed(() => !props.session || props.session.status === 'thinking' || props.session.status === 'starting')

const items = computed<CondensedItem[]>(() => {
  lastItems = reconcileCondensed(lastItems, condenseTranscript(built.value, { live: live.value }))
  return lastItems
})

/**
 * `UChatMessage` speaks UIMessage: the rich item rides in `metadata` and is
 * rendered by the `#content` slot, while `parts` carries a plain-text version
 * (a message with no parts renders as the typing indicator, and the text is
 * what a copy or a screen reader gets).
 *
 * The wrappers are cached per item, for the same reason the items themselves
 * are. Keyed on the item, so one carried forward keeps its wrapper and one that
 * changed gets a new one.
 */
const wrappers = new WeakMap<object, any>()

function plainText(item: CondensedItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'thought':
      return item.text
    case 'tool':
      return item.tool.title
    case 'plan':
      return item.entries.map(entry => `${entry.status}: ${entry.content}`).join('\n')
    case 'permission':
      return item.title
    case 'notice':
    case 'mesh':
      return item.text
    case 'handoff':
      return item.note
    case 'activity':
      return activityLabel(item)
  }
}

function messageFor(item: CondensedItem) {
  const cached = wrappers.get(item)
  if (cached) return cached
  const wrapper = {
    id: item.id,
    role: item.kind === 'user' ? ('user' as const) : ('assistant' as const),
    parts: [{ type: 'text', text: plainText(item) }] as any[],
    metadata: { item }
  }
  wrappers.set(item, wrapper)
  return wrapper
}

const USER_PROPS = { side: 'right', variant: 'soft', avatar: { icon: 'i-lucide-user' } } as const
const ASSISTANT_PROPS = computed(() => ({
  side: 'left',
  variant: 'naked',
  avatar: props.avatar ? { src: props.avatar.src, alt: props.avatar.alt } : { icon: 'i-lucide-sparkles' }
}) as const)
/** A handoff is a divider across the conversation, not something either side said. */
const DIVIDER_PROPS = { side: 'left', variant: 'naked', avatar: undefined } as const
/** A message that reached this agent from another one, or from Domo. */
const INBOUND_PROPS = { side: 'left', variant: 'naked', avatar: { icon: 'i-lucide-message-square' } } as const

function rowProps(item: CondensedItem) {
  if (item.kind === 'user') return USER_PROPS
  if (item.kind === 'handoff') return DIVIDER_PROPS
  if (item.kind === 'mesh' && item.direction === 'in') return INBOUND_PROPS
  return ASSISTANT_PROPS.value
}

/* -------------------------------------------------------------------------
 * When each row happened
 *
 * A row's time — to the second — sits in the strip under it, beside the
 * buttons that act on it. Nuxt UI already leaves that strip empty under every
 * message, so a time takes no room and moves nothing whether it shows or not:
 * it fades in under the pointer, or for the row last tapped on a phone, and
 * the clock button beside it keeps every time showing, everywhere, until it is
 * pressed again. The first row of each day gets a line naming the day; whether
 * a row opens a day depends only on the row before it, which never changes
 * once drawn. Clock times rather than "2m ago": they do not tick.
 *
 * `today` only changes at midnight, so the day lines re-render once a day.
 * ------------------------------------------------------------------------- */

const now = useNow({ interval: 60_000 })
const today = computed(() => dayKey(now.value))

function opensDay(index: number) {
  const item = items.value[index]
  const before = items.value[index - 1]
  return !!item && (!before || dayKey(before.at) !== dayKey(item.at))
}

const alwaysShowTimes = useAlwaysShowTimes()
const { revealed, reveal } = useRevealedRow()
const { replay } = useAgentVoiceReplay()

const pendingPermissionIds = computed(() =>
  props.permissions.filter(permission => !permission.resolvedAt).map(permission => permission.id)
)

/* -------------------------------------------------------------------------
 * The window on screen
 *
 * A transcript is unbounded — a long session condenses to hundreds of rows,
 * each of which may be a rendered diff or a page of highlighted markdown — so
 * the rows are virtualised: only what fits on screen, plus a little either
 * side, is ever in the DOM. Each row is still a `UChatMessage`, so what a row
 * looks like does not live in two places.
 *
 * The scroll box holds three things: a band at the top that says whether
 * there is more history, the rows, and an empty space under the last row.
 * ------------------------------------------------------------------------- */

const scroller = ref<HTMLElement | null>(null)

/** The band above the first row: where "loading earlier" shows, and room for the first row's day line. */
const HISTORY_BAND = 40

/**
 * How tall to assume the box is when it says it is nothing.
 *
 * A window is only as good as the measurement behind it, and a scroller that
 * reports no height — laid out but not yet painted, or a DOM with no layout at
 * all, which is what a component test runs in — would window the transcript
 * down to nothing and render an empty page. Guessing a screen is wrong by a
 * few rows; believing the zero is wrong by all of them.
 */
const UNMEASURED_VIEWPORT = (typeof window !== 'undefined' && window.innerHeight) || 1200

/** What an unmeasured row is assumed to be. */
const ESTIMATED_ROW = 120

/**
 * A row above the screen that changes height moves everything under it, so
 * the scroll position moves by the same amount and the reader sees nothing
 * move. The virtualiser does this itself, except while the reader scrolls
 * up — and scrolling up through history is when rows above the screen are
 * mounted and measured. A row the screen cuts through is left alone unless it
 * has never been measured: one streaming in grows at its bottom, below where
 * the reader is looking.
 */
function keepsPlace(item: { start: number, end: number, size: number }, _delta: number, instance: any) {
  const top = instance.getScrollOffset()
  return item.end <= top || (item.start < top && item.size === ESTIMATED_ROW)
}

/** The scroll box's height, as the virtualiser last measured it. */
let viewport = UNMEASURED_VIEWPORT

/**
 * The row at the top of the screen, noted before earlier rows go in above it
 * (see below). Declared before the virtualiser, and it has to be: both watch
 * the items in the same flush, in the order they were made, and the
 * virtualiser's own watcher re-lays the rows out for the new ones. Running
 * after it, this read the new layout and noted the wrong row.
 */
let anchor: { key: string, offset: number } | null = null

watch(items, (next, previous) => {
  const el = scroller.value
  if (!el || !previous.length || next[0]?.id === previous[0]?.id) return
  const top = el.scrollTop
  const row = virtualizer.value.getVirtualItems().find(entry => entry.end > top)
  if (row) anchor = { key: String(row.key), offset: row.start - top }
}, { flush: 'pre' })

const virtualizer = useVirtualizer(computed(() => ({
  count: items.value.length,
  getScrollElement: () => scroller.value,
  // Rows vary from a one-line notice to a long answer, so this is only what an
  // unmeasured row is assumed to be; each one is measured as it is drawn.
  estimateSize: () => ESTIMATED_ROW,
  getItemKey: (index: number) => items.value[index]?.id ?? index,
  overscan: 4,
  scrollMargin: HISTORY_BAND,
  shouldAdjustScrollPositionOnItemSizeChange: keepsPlace,
  initialRect: { width: 0, height: UNMEASURED_VIEWPORT },
  // A transcript opens at its end. Starting the window at the top drew the
  // first rows of the log, only to throw them away a frame later.
  initialOffset: () => Math.max(0, HISTORY_BAND + items.value.length * ESTIMATED_ROW - UNMEASURED_VIEWPORT),
  observeElementRect: (instance: any, callback: (rect: { width: number, height: number }) => void) =>
    observeElementRect(instance, (rect) => {
      const height = rect.height || UNMEASURED_VIEWPORT
      callback({ width: rect.width, height })
      onViewportResize(height)
    })
})))

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

/**
 * Each row is measured once, when it is drawn, and its resize observer takes
 * it from there. A function ref runs on every render of this component, and
 * measuring there read every row's layout again for each streamed word.
 */
const measured = new WeakSet<Element>()
function measure(el: Element | null) {
  if (!el || measured.has(el)) return
  measured.add(el)
  virtualizer.value.measureElement(el)
}

/** Where a row is laid out now. Totalling the rows is what brings the layout up to date. */
function rowAt(index: number) {
  virtualizer.value.getTotalSize()
  return virtualizer.value.measurementsCache[index]
}

/** Where the last row ends, in the scroll box's coordinates. */
function contentEnd() {
  return HISTORY_BAND + totalSize.value
}

/**
 * Whether the view follows the newest row.
 *
 * Following is the default and the state we return to, because a transcript
 * is read from the bottom. It means the end of the last row is on screen:
 * anywhere in the space below it counts, so the reader can sit there and
 * watch text arrive. It is given up when the reader scrolls back far enough
 * that the end goes off the bottom of the box, and taken back when they come
 * down to it again — reading back through what an agent did must not be
 * yanked away by the next thing it says.
 */
const pinned = ref(true)
/** How close to the end a reader scrolling down has to come to be following again. */
const BOTTOM_THRESHOLD = 64

/** How far the end of the last row is below the bottom of the box; negative when it is above. */
function overflow(el: HTMLElement) {
  return contentEnd() - (el.scrollTop + el.clientHeight)
}

/**
 * Scrolls this component makes are not the reader's. Each one notes where it
 * left the box, and a scroll event that finds the box anywhere else was the
 * reader. Not a time window: while text streams the view follows every few
 * frames, so a window was nearly always open, and a reader scrolling back was
 * taken for the follow and pulled down again.
 */
let ownTop: number | null = null

function scrollTo(top: number) {
  virtualizer.value.scrollToOffset(Math.max(0, top))
  ownTop = scroller.value?.scrollTop ?? null
}

/**
 * Following glides: while text streams in, the view eases toward the end in
 * one continuous motion instead of stepping a chunk at a time. There is one
 * glide, never a queue of them: new content moves its target and the same
 * loop carries on toward it, so fast streaming cannot pile up animations that
 * lag behind. Each frame covers a share of what is left, measured in time
 * rather than frames, so a slow phone arrives as soon as a fast one.
 *
 * Instant instead when the motion would only be in the way: when the reader
 * asks for less motion, when the destination is more than a screen away
 * (opening a transcript, jumping back from far up), when the box resizes
 * (the end must stay on screen in the frame it would leave it), and when
 * earlier rows are put in above the reader.
 */
const GLIDE_MS = 90
let glideTarget: number | null = null
let glideFrame = 0
let glideLast = 0

function prefersLessMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function stopGlide() {
  if (glideFrame) cancelAnimationFrame(glideFrame)
  glideFrame = 0
  glideTarget = null
}

function moveTo(top: number, { instant = false } = {}) {
  const el = scroller.value
  if (!el) return
  const destination = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight))
  if (instant || prefersLessMotion() || Math.abs(destination - el.scrollTop) > el.clientHeight) {
    stopGlide()
    scrollTo(destination)
    return
  }
  glideTarget = destination
  if (!glideFrame) {
    glideLast = performance.now()
    glideFrame = requestAnimationFrame(glide)
  }
}

function glide(now: number) {
  glideFrame = 0
  const el = scroller.value
  if (!el || glideTarget === null) return
  const elapsed = Math.min(64, now - glideLast)
  glideLast = now
  const left = glideTarget - el.scrollTop
  if (Math.abs(left) <= 1) {
    scrollTo(glideTarget)
    glideTarget = null
    return
  }
  // At least a pixel a frame: the browser rounds the position, and a step
  // smaller than that would never arrive.
  const step = left * (1 - Math.exp(-elapsed / GLIDE_MS))
  scrollTo(el.scrollTop + Math.sign(left) * Math.max(1, Math.abs(step)))
  glideFrame = requestAnimationFrame(glide)
}

onBeforeUnmount(stopGlide)

/** Within this far of the top of what is loaded, the page before it is asked for. */
const EARLIER_THRESHOLD = 800

let lastScrollTop = 0

/**
 * The end in view is following, whatever got it there. Otherwise only the
 * reader decides: going up leaves, and coming down to within a short way of
 * the end comes back — the follow then brings the end the rest of the way.
 */
function onScroll() {
  const el = scroller.value
  if (!el) return
  const below = overflow(el)
  const own = ownTop !== null && Math.abs(el.scrollTop - ownTop) <= 1
  ownTop = null
  if (below <= 1) pinned.value = true
  else if (!own) {
    if (el.scrollTop < lastScrollTop) pinned.value = false
    else if (below <= BOTTOM_THRESHOLD) pinned.value = true
  }
  // The reader took over: a glide toward the end must not pull against them.
  if (!own && glideTarget !== null && !pinned.value) stopGlide()
  lastScrollTop = el.scrollTop
  askForEarlier()
}

function askForEarlier() {
  const el = scroller.value
  if (!el || props.complete || props.loadingEarlier || !items.value.length) return
  if (el.scrollTop < EARLIER_THRESHOLD) emit('loadEarlier')
}

/**
 * Keep the end of the last row on screen, and do nothing else: while it is
 * in the space below, new text has room to arrive without anything moving,
 * and once it would pass the bottom of the box the view glides after it.
 */
function follow({ instant = false } = {}) {
  const el = scroller.value
  if (!el || !pinned.value) return
  const end = contentEnd() - el.clientHeight
  // Measured from where the view is headed, so a glide already under way is
  // retargeted rather than started again.
  if (end > (glideTarget ?? el.scrollTop)) moveTo(end, { instant })
}

/**
 * The box changes height when what is under it does — the composer growing a
 * line, the voice bar opening, a phone's keyboard. The end of the last row
 * stays where it was on screen if it still fits, and moves up with the bottom
 * edge if it no longer does. This runs in the resize observer, before the
 * frame is painted, so the frame between never shows the row cut off.
 */
function onViewportResize(height: number) {
  if (height === viewport) return
  viewport = height
  follow({ instant: true })
}

/**
 * What to follow: the height of the content, not the list behind it. The
 * items change first; the content only grows once the virtualiser has
 * measured the rows for them, and following on the item change found a box
 * that still had its old height.
 */
watch(totalSize, () => {
  follow()
  askForEarlier()
})

/**
 * A message the person has just sent, while they are following: the view
 * moves so it sits at the top of the screen — or, if it is short, so it ends
 * a quarter of the way down — and the reply is written into the space below
 * it. That is the one time this component scrolls further than it has to,
 * and it happens as the turn starts, not while it streams.
 */
watch(() => items.value[items.value.length - 1], (last, before) => {
  if (!last || !before || last.id === before.id || last.kind !== 'user' || !pinned.value) return
  const index = items.value.length - 1
  void nextTick(() => {
    const el = scroller.value
    const row = rowAt(index)
    if (!el || !row) return
    moveTo(row.start - 16)
  })
})

/**
 * Earlier rows arrive above the ones on screen. A virtual list places rows by
 * their offsets, not by the browser's flow, so nothing keeps the reader's
 * place for them: the row at the top of the screen is noted before the new
 * rows go in, and the view is put back on it after. Rows that then measure
 * differently from their estimate are above the view, and the virtualiser
 * corrects the scroll position for those itself.
 */
watch(items, () => {
  const held = anchor
  anchor = null
  if (!held) return
  const index = items.value.findIndex(item => item.id === held.key)
  if (index < 0) return
  const row = rowAt(index)
  if (row) {
    stopGlide()
    scrollTo(row.start - held.offset)
  }
}, { flush: 'post' })

function jumpToLatest() {
  pinned.value = true
  const el = scroller.value
  if (el) moveTo(contentEnd() - el.clientHeight)
}

/**
 * Arriving at the end of a virtual list is not one scroll: a row's height is a
 * guess until it is drawn, and scrolling there is what draws the rows that
 * correct it. The virtualiser's own `scrollToIndex` keeps going until it has
 * arrived, and the follow above keeps it there.
 */
onMounted(() => nextTick(() => {
  if (items.value.length) virtualizer.value.scrollToIndex(items.value.length - 1, { align: 'end' })
}))
</script>

<template>
  <div :data-status="live ? 'streaming' : 'ready'" class="relative flex h-full min-h-0 flex-col">
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [container-type:size]"
      data-testid="transcript-scroller"
      @scroll.passive="onScroll"
    >
      <div class="mx-auto w-full max-w-3xl px-1">
        <div
          class="flex items-center justify-center gap-2 text-xs text-dimmed"
          :style="{ height: `${HISTORY_BAND}px` }"
          data-testid="transcript-history"
        >
          <template v-if="!complete">
            <UIcon :name="loadingEarlier ? 'i-lucide-loader-circle' : 'i-lucide-arrow-up'" class="size-3.5" :class="loadingEarlier ? 'animate-spin' : ''" />
            <span>Earlier messages</span>
          </template>
        </div>

        <div class="relative" :style="{ height: `${totalSize}px` }">
          <div
            v-for="row in virtualRows"
            :key="row.key as string"
            :ref="(el) => measure(el as Element | null)"
            :data-index="row.index"
            class="absolute inset-x-0 top-0 pb-4"
            :style="{ transform: `translateY(${row.start - HISTORY_BAND}px)` }"
          >
            <div
              v-if="opensDay(row.index)"
              role="separator"
              class="flex items-center gap-3 pb-4 text-xs text-dimmed"
              data-testid="day-separator"
            >
              <span class="h-px flex-1 bg-(--ui-border)" />
              <time :datetime="items[row.index]!.at">{{ dayLabel(items[row.index]!.at, today) }}</time>
              <span class="h-px flex-1 bg-(--ui-border)" />
            </div>
            <UChatMessage
              v-bind="{
                ...rowProps(items[row.index]!),
                ...messageFor(items[row.index]!)
              }"
              @pointerup="reveal(items[row.index]!.id, $event)"
            >
              <template #content>
                <ActivityGroup
                  v-if="items[row.index]!.kind === 'activity'"
                  :group="(items[row.index] as any)"
                />
                <TranscriptItemView
                  v-else
                  :item="(items[row.index] as any)"
                  :pending-permission-ids="pendingPermissionIds"
                />
                <!--
                  In the strip Nuxt UI leaves under every message: outside the
                  content's box, so nothing here changes a row's height.
                -->
                <TranscriptRowMeta
                  :at="items[row.index]!.at"
                  :side="rowProps(items[row.index]!).side"
                  :shown="alwaysShowTimes || revealed === items[row.index]!.id"
                  :revealed="revealed === items[row.index]!.id"
                  :always="alwaysShowTimes"
                  :replay="items[row.index]!.kind === 'assistant' ? () => replay((items[row.index] as any).text) : undefined"
                  @toggle-always="alwaysShowTimes = !alwaysShowTimes"
                />
              </template>
            </UChatMessage>
          </div>
        </div>

        <!--
          The empty space under the last row: three quarters of the box.
          Scrolled all the way down, the newest row ends a quarter of the way
          down the screen, and what the agent says next is written into the
          space below it without anything moving. Sized by CSS against the
          box (a container query unit), so it changes in the same layout as
          the box does: sized by script, it lagged a frame behind the composer
          shrinking, and the browser clamped the scroll position meanwhile and
          moved every row down.
        -->
        <div aria-hidden="true" class="h-[75cqh]" data-testid="transcript-tail" />
      </div>
    </div>

    <UButton
      v-if="!pinned"
      icon="i-lucide-arrow-down"
      color="neutral"
      variant="outline"
      size="sm"
      aria-label="Jump to the latest message"
      class="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-default shadow-lg"
      @click="jumpToLatest"
    />
  </div>
</template>
