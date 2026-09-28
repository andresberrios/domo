<script setup lang="ts">
import { observeElementRect, useVirtualizer } from '@tanstack/vue-virtual'
import type { AgentEvent, AgentSession, PendingPermission } from '~~/shared/types'
import type { CondensedItem, TranscriptItem } from '~/utils/agentTranscript'

const props = withDefaults(defineProps<{
  session: AgentSession
  events: AgentEvent[]
  permissions: PendingPermission[]
  /** Collapse runs of tool activity into one row. On unless told otherwise. */
  condensed?: boolean
}>(), { condensed: true })

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
const live = computed(() => props.session.status === 'thinking' || props.session.status === 'starting')

const items = computed<CondensedItem[]>(() => {
  const next = props.condensed
    ? condenseTranscript(built.value, { live: live.value })
    : built.value
  lastItems = reconcileCondensed(lastItems, next)
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
      return item.text
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
const ASSISTANT_PROPS = { side: 'left', variant: 'naked', avatar: { icon: 'i-lucide-sparkles' } } as const

const pendingPermissionIds = computed(() =>
  props.permissions.filter(permission => !permission.resolvedAt).map(permission => permission.id)
)

/* -------------------------------------------------------------------------
 * The window on screen
 *
 * A transcript is unbounded — a long session condenses to hundreds of rows,
 * each of which may be a rendered diff or a page of highlighted markdown — and
 * the container Nuxt UI ships renders every one of them, watches the whole
 * list deeply, and re-scrolls on every DOM mutation underneath it. That is
 * work proportional to everything the agent has ever done, repeated for every
 * word it streams, and it is what made a long session unusable on a phone.
 *
 * So the rows are virtualised: only what fits on screen, plus a little either
 * side, is ever in the DOM. Each row is still a `UChatMessage`, so what a row
 * looks like has not changed and does not live in two places.
 * ------------------------------------------------------------------------- */

const scroller = ref<HTMLElement | null>(null)

/**
 * How tall to assume the box is when it says it is nothing.
 *
 * A window is only as good as the measurement behind it, and a scroller that
 * reports no height — laid out but not yet painted, or a DOM with no layout at
 * all, which is what a component test runs in — would window the transcript
 * down to nothing and render an empty page. Guessing a screen is wrong by a
 * few rows; believing the zero is wrong by all of them.
 */
const UNMEASURED_VIEWPORT = 1200

const virtualizer = useVirtualizer(computed(() => ({
  count: items.value.length,
  getScrollElement: () => scroller.value,
  // Rows vary from a one-line notice to a long answer, so this is only what an
  // unmeasured row is assumed to be; `measureElement` corrects each one as it
  // is drawn. Estimating high keeps a jump to the end from overshooting.
  estimateSize: () => 160,
  getItemKey: (index: number) => items.value[index]?.id ?? index,
  overscan: 4,
  initialRect: { width: 0, height: UNMEASURED_VIEWPORT },
  observeElementRect: (instance: any, callback: (rect: { width: number, height: number }) => void) =>
    observeElementRect(instance, rect =>
      callback({ width: rect.width, height: rect.height || UNMEASURED_VIEWPORT })
    )
})))

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

/**
 * Whether the view is pinned to the newest row.
 *
 * Pinned is the default and the state we return to, because a transcript is
 * read from the bottom. It is given up the moment the user scrolls away from
 * the end, and taken back when they come back to it — reading back through
 * what an agent did must not be yanked away by the next thing it says.
 */
const pinned = ref(true)
const BOTTOM_THRESHOLD = 64
let lastScrollTop = 0

function distanceFromBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/**
 * Only the reader going *back* unpins.
 *
 * Two things this must not mistake for that. "Not at the bottom any more" is
 * not it: a row that measures taller than its estimate, or one that has just
 * been appended, moves the bottom away without the reader having done
 * anything. Nor is a scroll position that *fell*: rows that measure shorter
 * than their estimate shrink the page under a view that is pinned to the end,
 * and the browser pulls the scroll down to fit. That one unpinned the
 * transcript mid-settle and left it stranded — a hundred thousand pixels above
 * the newest message after the condensed switch, which is what made this look
 * like the switch was broken.
 *
 * So a scroll that `followTail` is responsible for is ignored, and the window
 * outlives the loop by a moment because scroll events arrive after the
 * assignment that caused them.
 */
const FOLLOW_GRACE_MS = 120
let followingUntil = 0

function onScroll() {
  const el = scroller.value
  if (!el) return
  // At the bottom is pinned, whatever got us there — asked first, because a
  // view that has arrived cannot also be a reader who has left, and answering
  // the other question first once stranded the button on screen at the bottom
  // of a transcript that had just shrunk under it.
  if (distanceFromBottom(el) <= BOTTOM_THRESHOLD) pinned.value = true
  else if (performance.now() > followingUntil && el.scrollTop < lastScrollTop - 1) pinned.value = false
  lastScrollTop = el.scrollTop
}

/**
 * Go to the newest row, and keep going until it really is on screen.
 *
 * Arriving at the bottom of a virtual list is not one scroll. A row's height is
 * a guess until it has been drawn, the end of the list is the sum of those
 * guesses, and scrolling there is what draws the rows that correct them — so
 * the destination moves as you approach it. On a condensed transcript the
 * guesses are only a little wrong and one extra frame covers it; expanded, the
 * same list is thousands of rows estimated at four times their real height, and
 * chasing `scrollHeight` frame by frame never caught up inside any budget worth
 * spending.
 *
 * `scrollToEnd` is the virtualiser's own answer to this, and it reconciles
 * against its own measurements rather than against the DOM's lagging height.
 */
function followTail() {
  followingUntil = performance.now() + FOLLOW_GRACE_MS
  virtualizer.value.scrollToEnd()
}

function jumpToLatest() {
  pinned.value = true
  followTail()
}

/**
 * Condensing rewrites every row, so wherever the reader was has no counterpart
 * on the other side of the switch — a scroll position kept across it lands
 * somewhere arbitrary. The newest message is the one place that means the same
 * thing in both views, so that is where the switch leaves them.
 *
 * Declared before the watcher below, and it has to be: both answer the same
 * flush, in the order they were made, and the one below reads what this one
 * writes. The other way round it read the pin from before the switch, which is
 * how turning condensing off used to strand the view where the condensed
 * transcript had ended.
 */
watch(() => props.condensed, () => {
  pinned.value = true
})

/**
 * What to follow: the height of the content, not the list behind it.
 *
 * Watching the items is watching the wrong thing, and by a whole layout pass.
 * They change first; the box only grows once the virtualiser has re-measured
 * for them, which is frames later — so a follow started on the item change
 * found a scroller that still had its old height and decided it was already at
 * the bottom of it.
 *
 * `totalSize` is the virtualiser's own answer, so it moves when the content
 * really does — a new row, a row that measured differently, streamed text
 * growing the last one — and never before.
 */
watch(totalSize, () => {
  if (pinned.value) followTail()
})

// An empty transcript has no height to follow, so nothing above ever fires for
// it; this is what makes the first rows land at the bottom rather than the top.
onMounted(() => nextTick(() => followTail()))
</script>

<template>
  <div :data-status="live ? 'streaming' : 'ready'" class="relative flex h-full min-h-0 flex-col">
    <div
      ref="scroller"
      class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      @scroll.passive="onScroll"
    >
      <div
        class="relative mx-auto w-full max-w-3xl px-1 py-4"
        :style="{ height: `${totalSize}px` }"
      >
        <div
          v-for="row in virtualRows"
          :key="row.key as string"
          :ref="(el) => virtualizer.measureElement(el as Element)"
          :data-index="row.index"
          class="absolute inset-x-0 top-0 pb-4"
          :style="{ transform: `translateY(${row.start}px)` }"
        >
          <UChatMessage
            v-bind="{
              ...(items[row.index]!.kind === 'user' ? USER_PROPS : ASSISTANT_PROPS),
              ...messageFor(items[row.index]!)
            }"
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
            </template>
          </UChatMessage>
        </div>
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
