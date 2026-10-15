<script setup lang="ts">
import { measureElement, observeElementRect, useVirtualizer } from '@tanstack/vue-virtual'
import { useNow, useResizeObserver } from '@vueuse/core'
import type { AgentEvent, AgentSession, PendingPermission } from '~~/shared/types'
import type { CondensedItem, DayRow, TranscriptItem, TranscriptRowModel } from '~/utils/agentTranscript'

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

/* -------------------------------------------------------------------------
 * When each row happened
 *
 * Each row's time is in the strip under it (`TranscriptRowMeta`), and each
 * day opens with a line naming it, a row of its own (`withDayRows`).
 *
 * `today` only changes at midnight, so the day lines re-render once a day.
 * ------------------------------------------------------------------------- */

const now = useNow({ interval: 60_000 })
const today = computed(() => dayKey(now.value))

const pendingPermissionIds = computed(() =>
  props.permissions.filter(permission => !permission.resolvedAt).map(permission => permission.id)
)

/* -------------------------------------------------------------------------
 * The window on screen
 *
 * A transcript is unbounded — a long session condenses to hundreds of rows,
 * each of which may be a rendered diff or a page of highlighted markdown — so
 * the rows are virtualised: only what fits on screen, plus a little either
 * side, is ever in the DOM. Each row is a `TranscriptRow`, here and in the
 * measuring below, so what a row looks like does not live in two places.
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

/** What a row nobody has measured yet is assumed to be. */
const ESTIMATED_ROW = 120

/* -------------------------------------------------------------------------
 * Every row's height, before the reader gets to it
 *
 * A row's height is a guess until it is drawn, and drawing it is what corrects
 * the guess — by moving everything under it, unless the scroll position moves
 * by the same amount. The virtualiser does move it, everywhere but iOS: there
 * a write to the scroll position stops a flick dead, so it holds every
 * correction until the reader stops, and meanwhile the page jumps under their
 * finger. Measured in Chromium posing as an iPhone, scrolling up through a
 * long session moved the page 79 times, by as much as 962px.
 *
 * So the guess is not left to be corrected while the reader scrolls: each row
 * is drawn offscreen, in the same component and at the same width, while the
 * page is idle, and the list is given its real height before the reader
 * reaches it. An earlier page is held back until all of its rows have been
 * measured, and goes in above the reader with every height already right.
 * Expanded state is kept per row id (`useRowOpen`), so a row that scrolls out
 * and back is the same height it was.
 *
 * Considered and not used: Pretext measures text runs without the DOM, but a
 * row is markdown — lists, tables, code — inside cards and groups, which it
 * does not lay out. `content-visibility: auto` would replace the virtual list
 * and lean on the browser's scroll anchoring, which Safari does not have; so
 * would `overflow-anchor`, which does not apply to positioned rows anyway.
 * ------------------------------------------------------------------------- */

/** Heights by item and the width they were measured at. An item that changes is a new object. */
const heights = new WeakMap<object, { width: number, height: number }>()
/** Every day's line is the same height; this is it, and the width it was measured at. */
let dayHeight: { width: number, height: number } | null = null
/** The list's width, which a height is only good for. */
const listWidth = ref(0)

function knownHeight(row: TranscriptRowModel | undefined): number | null {
  const known = !row ? undefined : row.kind === 'day' ? dayHeight : heights.get(row)
  return known && known.width === listWidth.value ? known.height : null
}

function rememberHeight(row: TranscriptRowModel, height: number) {
  const known = { width: listWidth.value, height }
  if (row.kind === 'day') dayHeight = known
  else heights.set(row, known)
}

/**
 * How many of the oldest items are held back from the list: an earlier page
 * that has arrived and is still being measured.
 */
const held = ref(0)
const dayRows = new Map<string, DayRow>()
const rows = computed(() => withDayRows(held.value ? items.value.slice(held.value) : items.value, dayRows))
/** The held page as it will be drawn, to measure. */
const heldRows = computed(() => (held.value ? withDayRows(items.value.slice(0, held.value)) : []))

/**
 * An earlier page has arrived: it waits above the list until its rows are
 * measured (`measureAhead`). Declared before the virtualiser, so the list it
 * lays out is the one without them.
 */
watch(items, (next, previous) => {
  if (!canMeasure || !previous.length) return
  const firstListed = previous[held.value]
  if (!firstListed || next[held.value]?.id === firstListed.id) return
  const at = next.findIndex(item => item.id === firstListed.id)
  held.value = Math.max(0, at)
  measureAhead()
}, { flush: 'pre' })

/**
 * A row above the screen that changes height moves everything under it, so
 * the scroll position moves by the same amount and the reader sees nothing
 * move. The virtualiser does this itself, except while the reader scrolls
 * up. A row the screen cuts through is left alone unless the list has never
 * had its height: one streaming in grows at its bottom, below where the
 * reader is looking.
 */
function keepsPlace(item: { key: unknown, start: number, end: number }, _delta: number, instance: any) {
  // Measured ahead: `applyKnownHeights` moves the view itself.
  if (correcting) return false
  const top = instance.getScrollOffset()
  return item.end <= top || (item.start < top && !instance.itemSizeCache.has(item.key))
}

/** The scroll box's height, as the virtualiser last measured it. */
let viewport = UNMEASURED_VIEWPORT

/**
 * The row at the top of the screen, noted before earlier rows go in above it
 * (see below). Declared before the virtualiser, and it has to be: both watch
 * the rows in the same flush, in the order they were made, and the
 * virtualiser's own watcher re-lays the rows out for the new ones. Running
 * after it, this read the new layout and noted the wrong row.
 */
let anchor: { key: string, offset: number } | null = null

/** The first row that is not a day's line: the day's line stays first when the page above opens on the same day. */
const firstMessage = (list: TranscriptRowModel[]) => list.find(row => row.kind !== 'day')?.id

watch(rows, (next, previous) => {
  const el = scroller.value
  if (!el || !previous.length || firstMessage(next) === firstMessage(previous)) return
  const top = el.scrollTop
  // A message, not a day's line: the line moves up when its day continues
  // into the page above.
  const row = virtualizer.value.getVirtualItems().find(entry => entry.end > top && previous[entry.index]?.kind !== 'day')
  if (row) anchor = { key: String(row.key), offset: row.start - top }
}, { flush: 'pre' })

const virtualizer = useVirtualizer(computed(() => ({
  count: rows.value.length,
  getScrollElement: () => scroller.value,
  // A row measured offscreen already has its height; the guess is for one
  // that has not been yet.
  estimateSize: (index: number) => knownHeight(rows.value[index]) ?? ESTIMATED_ROW,
  getItemKey: (index: number) => rows.value[index]?.id ?? index,
  overscan: 4,
  scrollMargin: HISTORY_BAND,
  initialRect: { width: 0, height: UNMEASURED_VIEWPORT },
  // A transcript opens at its end. Starting the window at the top drew the
  // first rows of the log, only to throw them away a frame later.
  initialOffset: () => Math.max(0, HISTORY_BAND + rows.value.length * ESTIMATED_ROW - UNMEASURED_VIEWPORT),
  // What a drawn row measures is its height from now on.
  measureElement: (el: Element, entry: ResizeObserverEntry | undefined, instance: any) => {
    const height = measureElement(el, entry, instance)
    const row = rows.value[Number((el as HTMLElement).dataset.index)]
    if (row && height > 0) rememberHeight(row, height)
    return height
  },
  observeElementRect: (instance: any, callback: (rect: { width: number, height: number }) => void) =>
    observeElementRect(instance, (rect) => {
      const height = rect.height || UNMEASURED_VIEWPORT
      callback({ width: rect.width, height })
      onViewportResize(height)
    })
})))

/**
 * Earlier rows arrive above the ones on screen. A virtual list places rows by
 * their offsets, not by the browser's flow, so nothing keeps the reader's
 * place for them: the row at the top of the screen is noted before the new
 * rows go in (above), and the view is put back on it here — before the rows
 * are drawn, not after. After, the list drew the new rows for the old scroll
 * position first, which took every row on screen down and put it back.
 *
 * So this runs in the same flush, after the virtualiser has laid the new rows
 * out and before the DOM is patched: the list is given its new height, so
 * the scroll position is not clamped to the old one, and the virtualiser is
 * told where the view now is rather than waiting a frame for the event.
 */
watch(rows, () => {
  const kept = anchor
  anchor = null
  const el = scroller.value
  if (!kept || !el) return
  const index = rows.value.findIndex(item => item.id === kept.key)
  const row = index < 0 ? undefined : rowAt(index)
  if (!row) return
  if (list.value) list.value.style.height = `${virtualizer.value.getTotalSize()}px`
  stopGlide()
  scrollTo(row.start - kept.offset)
}, { flush: 'pre' })

// Read off the instance, not the options: passed as an option it is ignored.
virtualizer.value.shouldAdjustScrollPositionOnItemSizeChange = keepsPlace

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
/** Telling the virtualiser of a scroll this component just made (below). */
let announcing = false

/**
 * Every write is announced to the virtualiser at once. It learns where the
 * view is from the scroll event, a frame later, and anything it corrected
 * before then it corrected from where the view had been: after the landing
 * moved the view, it overshot by the move into the empty space below the
 * last row.
 */
function scrollTo(top: number) {
  const el = scroller.value
  virtualizer.value.scrollToOffset(Math.max(0, top))
  ownTop = el?.scrollTop ?? null
  if (!el) return
  announcing = true
  el.dispatchEvent(new Event('scroll'))
  announcing = false
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

/**
 * Within this many screens of the top of what is loaded, the page before it
 * is asked for: far enough ahead that it has arrived and been measured before
 * a reader scrolling steadily gets there.
 */
const EARLIER_SCREENS = 3

let lastScrollTop = 0

/**
 * The end in view is following, whatever got it there. Otherwise only the
 * reader decides: going up leaves, and coming down to within a short way of
 * the end comes back — the follow then brings the end the rest of the way.
 */
function onScroll() {
  const el = scroller.value
  if (!el) return
  // Our own announcement (`scrollTo`): the browser's event for the same write
  // is still to come, and is matched against `ownTop` then.
  if (announcing) return
  const below = overflow(el)
  // While landing, every scroll is the virtualiser finding the end, and one
  // that went up for a row measured shorter used to read as the reader
  // leaving, and stopped the landing short.
  const own = !landed.value || (ownTop !== null && Math.abs(el.scrollTop - ownTop) <= 1)
  ownTop = null
  if (!own) {
    readerScrolledAt = performance.now()
    clearTimeout(measureWhenSettled)
    measureWhenSettled = setTimeout(measureAhead, SCROLL_SETTLE_MS)
  }
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
  if (!el || props.complete || props.loadingEarlier || held.value || !rows.value.length) return
  if (el.scrollTop < Math.max(800, el.clientHeight * EARLIER_SCREENS)) emit('loadEarlier')
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
  // retargeted rather than started again. A glide is for text arriving: when
  // nothing is streaming, the end moves because a row was measured, and that
  // is followed at once — so is everything while landing, where gliding
  // after each measured row kept the transcript hidden for most of a second.
  if (end > (glideTarget ?? el.scrollTop)) moveTo(end, { instant: instant || !landed.value || !live.value })
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
  // After the DOM has the list's new height, and not before: a scroll
  // position written against the old one is clamped to it. The virtualiser
  // writes its corrections as rows are measured — before the list has grown
  // — and retries a clamped one only at its next measurement, which while a
  // transcript lands came after it was shown, as a jump of most of a screen.
  ;(virtualizer.value as any)._retryClampedAdjustment?.()
  follow()
  askForEarlier()
}, { flush: 'post' })

/**
 * A message the person has just sent, while they are following: the view
 * moves so it sits at the top of the screen — or, if it is short, so it ends
 * a quarter of the way down — and the reply is written into the space below
 * it. That is the one time this component scrolls further than it has to,
 * and it happens as the turn starts, not while it streams.
 */
watch(() => rows.value[rows.value.length - 1], (last, before) => {
  if (!last || !before || last.id === before.id || last.kind !== 'user' || !pinned.value) return
  const index = rows.value.length - 1
  void nextTick(() => {
    const el = scroller.value
    const row = rowAt(index)
    if (!el || !row) return
    moveTo(row.start - 16)
  })
})



/* -------------------------------------------------------------------------
 * Measuring ahead
 *
 * While the page is idle, a few rows at a time are drawn offscreen and their
 * heights handed to the list: first an earlier page that is waiting to go in,
 * nearest the reader first, then the listed rows above the screen. Rows on
 * screen and in the window's margin are measured where they are.
 * ------------------------------------------------------------------------- */

/** Rows drawn offscreen to be measured. */
const measuring = shallowRef<TranscriptRowModel[]>([])
const measurer = ref<HTMLElement | null>(null)
const list = ref<HTMLElement | null>(null)
/** There is a layout to measure in; not so in a component test. */
let canMeasure = false
/**
 * Rows per idle slice: as many as fit in what is left of the idle period, at
 * least one; for a page held back, a few regardless, and more once the
 * reader has reached the top and is waiting for it.
 */
const MEASURE_BATCH_HELD = 4
const MEASURE_BATCH_WAITING = 12
/** What drawing one row has been costing here, learnt as rows are measured. */
let measureRowMs = 30
let measureWhenSettled: ReturnType<typeof setTimeout> | undefined
let measuringAhead = false
/** When the reader last scrolled: an earlier page goes in between their scrolls. */
let readerScrolledAt = 0
const SCROLL_SETTLE_MS = 150

/**
 * When the page has nothing else to do. A page held back for measuring is
 * something the reader may be waiting on, so that much work is not put off
 * for long; measuring the rows already listed waits as long as it has to.
 */
function whenIdle(work: (deadline?: IdleDeadline) => void, urgent: boolean) {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(work, urgent ? { timeout: 300 } : undefined)
  else setTimeout(work, urgent ? 50 : 200)
}

function nextToMeasure(idleMs = Infinity) {
  const batch: TranscriptRowModel[] = []
  const waiting = heldRows.value
  const size = (scroller.value?.scrollTop ?? 0) <= HISTORY_BAND ? MEASURE_BATCH_WAITING : MEASURE_BATCH_HELD
  for (let index = waiting.length - 1; index >= 0 && batch.length < size; index--) {
    if (knownHeight(waiting[index]) === null) batch.push(waiting[index]!)
  }
  if (batch.length) return batch
  // Above the screen, nearest first, and all of them: a flick outruns any
  // margin, and a row still unmeasured when it scrolls in is corrected, on
  // iOS, only once the flick has stopped.
  const fits = Math.max(1, Math.min(MEASURE_BATCH_HELD, Math.floor(idleMs / measureRowMs)))
  const first = virtualRows.value[0]?.index ?? 0
  for (let index = first - 1; index >= 0 && batch.length < fits; index--) {
    if (knownHeight(rows.value[index]) === null) batch.push(rows.value[index]!)
  }
  return batch
}

function measureAhead() {
  if (measuringAhead || !canMeasure || !landed.value) return
  measuringAhead = true
  whenIdle(async (deadline) => {
    measuringAhead = false
    applyKnownHeights()
    letEarlierIn()
    const batch = nextToMeasure(deadline && !deadline.didTimeout ? deadline.timeRemaining() : Infinity)
    if (!batch.length) return
    const started = performance.now()
    measuring.value = batch
    await nextTick()
    const drawn = measurer.value?.children
    batch.forEach((row, at) => {
      const height = (drawn?.[at] as HTMLElement | undefined)?.offsetHeight ?? 0
      if (height) rememberHeight(row, height)
      else canMeasure = false
    })
    measureRowMs = (measureRowMs + (performance.now() - started) / batch.length) / 2
    measuring.value = []
    if (!canMeasure) held.value = 0
    else {
      applyKnownHeights()
      letEarlierIn()
      measureAhead()
    }
  }, held.value > 0)
}

/**
 * Hand the list the heights measured ahead, for rows above the screen.
 *
 * Every such row moves the scroll position by its difference, so the reader
 * sees nothing move — and this does that itself, in one write, rather than
 * leave it to the virtualiser. On iOS the virtualiser defers each correction
 * for as long as it counts the view as scrolling, which includes 150ms after
 * its own last write; one correction kept the next waiting, and the page
 * slid as they landed. Not while the reader scrolls, though: a write then
 * stops a flick on iOS, so it waits for them to stop.
 *
 * The list is grown before the write, too: it only grows when next drawn,
 * and a write past its end was clamped and finished a frame later.
 */
let correcting = false

function applyKnownHeights() {
  const el = scroller.value
  if (!el) return
  if (performance.now() - readerScrolledAt < SCROLL_SETTLE_MS) {
    setTimeout(measureAhead, SCROLL_SETTLE_MS)
    return
  }
  const first = virtualRows.value[0]?.index ?? 0
  const corrections: Array<{ index: number, height: number }> = []
  let delta = 0
  for (let index = 0; index < first; index++) {
    const height = knownHeight(rows.value[index])
    const laidOut = rowAt(index)
    if (height === null || !laidOut || laidOut.size === height) continue
    corrections.push({ index, height })
    delta += height - laidOut.size
  }
  if (!corrections.length) return
  if (list.value) list.value.style.height = `${Math.max(0, virtualizer.value.getTotalSize() + delta)}px`
  correcting = true
  for (const entry of corrections) virtualizer.value.resizeItem(entry.index, entry.height)
  correcting = false
  scrollTo(el.scrollTop + delta)
}

/**
 * Put a measured earlier page in: between the reader's scrolls, so the one
 * write that keeps their place does not land in the middle of a flick, or at
 * once if they have reached the top and are waiting for it.
 */
let letInLater: ReturnType<typeof setTimeout> | undefined

function letEarlierIn() {
  if (!held.value || heldRows.value.some(row => knownHeight(row) === null)) return
  const el = scroller.value
  const settling = performance.now() - readerScrolledAt < SCROLL_SETTLE_MS
  if (settling && (el?.scrollTop ?? 0) > HISTORY_BAND) {
    clearTimeout(letInLater)
    letInLater = setTimeout(letEarlierIn, SCROLL_SETTLE_MS)
    return
  }
  held.value = 0
}

useResizeObserver(list, ([entry]) => {
  const width = Math.round(entry?.contentRect.width ?? 0)
  if (width === listWidth.value) return
  listWidth.value = width
  measureAhead()
})

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
 *
 * Until it has, the rows are not shown: the first frame could be drawn at the
 * very bottom of the box, the newest row 60% of the way down, and the
 * next one at the end — a jump of 40% of a screen as the
 * transcript appeared. Hidden, the rows are laid out and measured all the
 * same, and appear once the end of the last row is at the bottom edge and
 * has held there for a frame. Measuring ahead waits until then too.
 */
const landed = ref(false)
const LANDING_LIMIT_MS = 1500
let landingStarted = 0
let landingSize = -1

/**
 * Landed: the end of the last row is at the bottom edge, and the height of
 * the content has held for a frame — rows mounted at the end are estimates
 * until they are measured, and the end moves when they are. Asked once a
 * frame: asked twice in one, the height had always held.
 */
function tryLanding() {
  const el = scroller.value
  if (landed.value || !el || !landingStarted) return
  // A correction the virtualiser retried can overshoot into the space below
  // the last row; the end is put back at the bottom edge.
  if (overflow(el) < -1 && contentEnd() > el.clientHeight) scrollTo(contentEnd() - el.clientHeight)
  const steady = totalSize.value === landingSize
  landingSize = totalSize.value
  const atEnd = Math.abs(overflow(el)) <= 1 || contentEnd() <= el.clientHeight
  if ((steady && atEnd) || performance.now() - landingStarted > LANDING_LIMIT_MS) {
    landed.value = true
    measureAhead()
  }
}

function land() {
  const el = scroller.value
  if (!el || !rows.value.length || !canMeasure) {
    landed.value = true
    return
  }
  landingStarted = performance.now()
  const check = () => {
    tryLanding()
    if (!landed.value) requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

onMounted(() => nextTick(() => {
  if (rows.value.length) virtualizer.value.scrollToIndex(rows.value.length - 1, { align: 'end' })
  canMeasure = (scroller.value?.clientHeight ?? 0) > 0
  land()
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
      <div class="mx-auto w-full max-w-3xl px-1" :class="landed ? '' : 'invisible'" data-testid="transcript-content">
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

        <div ref="list" class="relative" :style="{ height: `${totalSize}px` }">
          <div
            v-for="row in virtualRows"
            :key="row.key as string"
            :ref="(el) => measure(el as Element | null)"
            :data-index="row.index"
            class="absolute inset-x-0 top-0 pb-4"
            :style="{ transform: `translateY(${row.start - HISTORY_BAND}px)` }"
          >
            <TranscriptRow
              :item="rows[row.index]!"
              :today="today"
              :avatar="avatar"
              :pending-permission-ids="pendingPermissionIds"
            />
          </div>

          <!--
            Rows drawn to be measured before the reader reaches them (see
            "Measuring ahead"): at the list's width, unseen, unreachable, and
            clipped to nothing so they never add to what scrolls.
          -->
          <div class="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden" aria-hidden="true" inert>
            <div ref="measurer">
              <div v-for="row in measuring" :key="row.id" class="pb-4">
                <TranscriptRow
                  :item="row"
                  :today="today"
                  :avatar="avatar"
                  :pending-permission-ids="pendingPermissionIds"
                />
              </div>
            </div>
          </div>
        </div>

        <!--
          The empty space under the last row: 40% of the box. Scrolled all
          the way down, the newest row ends 60% of the way down the screen, and what the agent says next is written into the
          space below it without anything moving. Sized by CSS against the
          box (a container query unit), so it changes in the same layout as
          the box does: sized by script, it lagged a frame behind the composer
          shrinking, and the browser clamped the scroll position meanwhile and
          moved every row down.
        -->
        <div aria-hidden="true" class="h-[40cqh]" data-testid="transcript-tail" />
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
