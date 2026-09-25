<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'

/**
 * The model, the adapter's own settings and the session mode, behind one card
 * that opens a panel of columns.
 *
 * They live here rather than in the page header because they are decisions
 * about the message being written — "plan this one", "switch to Opus for this
 * bit", "think harder about this" — and the composer is where that decision is
 * made and where the answer is about to be sent. They are a *panel* rather
 * than a row of pickers because there can be four of them at once on a Codex
 * session (model, reasoning effort, collaboration mode, permission mode), and
 * four selects do not fit beside the attach button on a phone.
 *
 * The adapter is not among the columns: it is fixed when the session is
 * created, so the panel names it as a header rather than offering it as a
 * choice.
 *
 * Every column goes through the one `PATCH /api/agents/[id]`, which reaches
 * the adapter when one is running and records the choice on the row when none
 * is — picking a model here never starts a session, which matters most for the
 * environment-backed ones, where starting a session means starting work in a
 * container.
 *
 * Nothing here holds the chosen value: every column reads the session row, so
 * a change the adapter refuses reverts on its own, and a change made from the
 * voice agent or another browser arrives through Electric like any other.
 *
 * The panel stays open after a selection rather than closing like a menu,
 * because the options are per model — changing the model refreshes the effort
 * levels under it, and picking both is one errand, not two.
 */

const props = defineProps<{ session: AgentSession }>()

const toast = useToast()
const open = ref(false)
const adapterInfo = computed(() => agentAdapterInfo(props.session.adapter))

/**
 * The change in flight, as the column and the value that was clicked. The
 * spinner follows the *clicked* option, not the row's value — the row only
 * catches up when the PATCH lands, which is the whole point of the wait.
 */
const applying = ref<{ key: string, value: string } | null>(null)

async function apply(column: Column, value: string) {
  applying.value = { key: column.key, value }
  try {
    await $fetch(`/api/agents/${props.session.id}`, { method: 'PATCH', body: column.patch(value) })
  } catch (error: any) {
    toast.add({
      title: `Could not change the ${column.label.toLowerCase()}`,
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    applying.value = null
  }
}

/**
 * The model list is the one thing not already on the session row: an adapter
 * only reports it in a `session/new` response, so the server answers this by
 * spawning a throwaway probe (cached an hour). Hence `immediate: false` and a
 * fetch on first open — opening an agent page must not cost an adapter spawn.
 */
const {
  data: modelData,
  status: modelStatus,
  error: modelError,
  refresh: refreshModels
} = await useFetch<{ models: Array<{ id: string, name: string }> }>('/api/adapters/models', {
  query: computed(() => ({ adapter: props.session.adapter })),
  immediate: false,
  lazy: true,
  watch: false
})

// Probed once on first open, and again by hand if that one failed — a probe
// that answered is cached by the server for an hour, so a second success
// costs nothing, while a failed one has to be retryable or the model column
// is stuck at "this adapter is not reachable" for the life of the page.
let probed = false
watch(open, (value) => {
  if (!value || probed) return
  probed = true
  void refreshModels()
})

/* ---------------------------- the columns ---------------------------- */

interface ColumnItem {
  value: string
  label: string
  /** Shown dimmed beside the label — currently the model's provider prefix. */
  hint?: string | null
  description?: string | null
}

interface Column {
  key: string
  label: string
  items: ColumnItem[]
  selected: string
  /** The body of the one consolidated PATCH this column's choice becomes. */
  patch: (value: string) => Record<string, unknown>
  loading?: boolean
  error?: string | null
  onRetry?: () => void
}

/**
 * An OpenCode session lists both `openai/*` and `opencode/*` at once, and 18
 * bare names appear in both — two models on two separate billing
 * relationships — so the provider prefix is never flattened out: it is the
 * only thing on screen that says which account a message is about to spend.
 *
 * It goes on its own dimmed line rather than in front of the name, because
 * OpenCode's display names carry it too (`openai/GPT-4.1`) and a column
 * narrow enough to fit four of them on a laptop then truncates every entry to
 * `opencode-go/Ki…`, which is the prefix and nothing else — the one part that
 * was never in doubt. Split, the name gets the full width and the prefix is
 * still right under it. Filtering still matches the whole id, so typing
 * "openai/" narrows to that provider.
 */
function splitModel(id: string, name: string): { label: string, hint: string | null } {
  const slash = id.lastIndexOf('/')
  if (slash <= 0) return { label: name, hint: null }
  const prefix = id.slice(0, slash)
  const carried = name.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
  return { label: carried ? name.slice(prefix.length + 1) : name, hint: prefix }
}

const modelColumn = computed<Column>(() => {
  const items = (modelData.value?.models ?? []).map(entry => ({
    value: entry.id,
    ...splitModel(entry.id, entry.name)
  }))
  // Whatever the session is actually on goes in even before the probe answers,
  // so the column always has a selected row to show.
  const current = props.session.model
  if (current && !items.some(item => item.value === current)) {
    items.unshift({ value: current, ...splitModel(current, current) })
  }
  return {
    key: 'model',
    label: 'Model',
    items,
    selected: current ?? '',
    patch: (value: string) => ({ model: value }),
    loading: modelStatus.value === 'pending',
    error: modelError.value
      ? (modelError.value.statusMessage ?? modelError.value.message ?? 'The probe failed')
      : null,
    onRetry: () => { void refreshModels() }
  }
})

/**
 * The adapter's own settings: reasoning effort, and whatever else it ships.
 *
 * Read off the row and never hard-coded, because the two adapters do not agree
 * on any of it — Claude Code calls effort `effort` and Codex
 * `reasoning_effort`, Codex has a collaboration mode Claude has never heard
 * of, and both publish these *per model*, so the list changes when the model
 * beside it does. The row is rewritten from the adapter's own answer on every
 * change, so this follows along on its own.
 */
const configColumns = computed<Column[]>(() =>
  (props.session.configOptions ?? []).map(option => ({
    key: option.id,
    label: option.name,
    items: option.options.map(entry => ({
      value: entry.value,
      label: entry.name,
      description: entry.description
    })),
    selected: props.session.config?.[option.id] ?? option.currentValue ?? '',
    patch: (value: string) => ({ config: { [option.id]: value } })
  }))
)

const modeColumn = computed<Column | null>(() => {
  const modes = props.session.modes ?? []
  if (!modes.length) return null
  return {
    key: 'mode',
    label: adapterInfo.value.modeLabel,
    items: modes.map(mode => ({ value: mode.id, label: mode.name, description: mode.description })),
    selected: props.session.modeId ?? '',
    patch: (value: string) => ({ modeId: value })
  }
})

/** Model, then whatever the adapter offers, then what it is allowed to do. */
const columns = computed<Column[]>(() => [
  modelColumn.value,
  ...configColumns.value,
  ...(modeColumn.value ? [modeColumn.value] : [])
])

/* ---------------------------- filtering ---------------------------- */

/**
 * An authenticated OpenCode lists 130 models. Anything past a handful gets a
 * filter box, per column rather than per panel, so a long model list does not
 * put a search field over a five-entry effort column.
 */
const FILTER_THRESHOLD = 8
const filters = reactive<Record<string, string>>({})

function visibleItems(column: Column): ColumnItem[] {
  const query = (filters[column.key] ?? '').trim().toLowerCase()
  if (!query) return column.items
  return column.items.filter(item =>
    `${item.label} ${item.value} ${item.hint ?? ''}`.toLowerCase().includes(query)
  )
}

/* -------------------- scrolling the choice into view -------------------- */

const lists = ref<HTMLElement[]>([])

/**
 * A column taller than its own box opens showing its first options, not its
 * chosen one — Claude Code's five permission modes scroll, and "Bypass
 * permissions" sits off the bottom edge, so the panel opened saying nothing
 * about the setting most worth checking.
 *
 * `scrollTop` rather than `scrollIntoView`: the latter walks up to every
 * scrollable ancestor, and the transcript behind the popover is one of them.
 *
 * It runs on the model list arriving as well as on the panel opening, because
 * those are not the same moment: the probe is only *started* by the open, so
 * at first paint the model column holds one item and has nothing to scroll.
 * An authenticated OpenCode then fills it with 130, and without this the
 * column that most needs the scroll would be the one that never got it.
 */
async function scrollSelectedIntoView() {
  await nextTick()
  for (const list of lists.value) {
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!selected || list.scrollHeight <= list.clientHeight) continue
    list.scrollTop = selected.offsetTop - (list.clientHeight - selected.clientHeight) / 2
  }
}

watch([open, modelData], () => {
  if (open.value) void scrollSelectedIntoView()
})

/* ---------------------------- the card ---------------------------- */

function labelFor(column: Column): string | null {
  const item = column.items.find(entry => entry.value === column.selected)
  return item?.label ?? (column.selected || null)
}

/**
 * A toggle's value does not stand on its own. Both adapters publish their
 * fast-mode switch as a two-value select — the client capability that would
 * make it a real boolean is one Domo does not advertise — so the card's second
 * line read "Opus 5 · High · Off · Bypass permissions", where "Off" says
 * nothing at all and cost the width that pushed the permission mode past the
 * truncation. An on/off value therefore becomes the option's own name when it
 * is on ("Fast mode") and nothing when it is off, which is how a badge behaves
 * and what makes the line worth reading.
 */
const OFF_VALUES = new Set(['off', 'false', 'no', 'none', 'disabled'])
const ON_VALUES = new Set(['on', 'true', 'yes', 'enabled'])

function summaryPart(column: Column): string | null {
  const label = labelFor(column)
  if (!label) return null
  const word = label.trim().toLowerCase()
  if (OFF_VALUES.has(word)) return null
  return ON_VALUES.has(word) ? column.label : label
}

/**
 * The card names the model whole, provider prefix and all — the column can
 * afford to split it across two lines and the card's one line cannot, and the
 * prefix is the half that says which account is about to be spent.
 */
const modelLabel = computed(() => {
  const current = props.session.model
  if (!current) return null
  return modelData.value?.models.find(entry => entry.id === current)?.name ?? current
})

/**
 * The card's second line: every setting the panel offers except the model,
 * which has the line above to itself. The mode is in it because "Plan" and
 * "Bypass permissions" are the difference between a message being thought
 * about and being acted on, which is worth seeing before pressing send rather
 * than after.
 */
const summary = computed(() => {
  const rest = [...configColumns.value, ...(modeColumn.value ? [modeColumn.value] : [])]
  const parts = rest.map(summaryPart).filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' · ') : 'Default settings'
})
</script>

<template>
  <UPopover v-model:open="open" :content="{ side: 'top', align: 'start', collisionPadding: 8 }">
    <button
      type="button"
      class="flex min-w-0 max-w-56 shrink items-center gap-2 rounded-lg border border-default bg-elevated px-2.5 py-1 text-left transition-colors hover:bg-accented sm:max-w-80"
    >
      <!--
        The visible text is the accessible name, so this adds what the text
        does not say rather than an `aria-label` that would replace it.
      -->
      <span class="sr-only">Session settings:</span>
      <UIcon :name="adapterInfo.icon" class="size-4 shrink-0 text-primary" />
      <span class="min-w-0">
        <!--
          The adapter is fixed and the model is not, so they share the top
          line: the harness for recognition, the model because it is the first
          thing anyone checks. Everything else is the line below.
        -->
        <span class="block truncate text-xs leading-tight">
          <span class="font-semibold">{{ adapterInfo.label }}</span>
          <template v-if="modelLabel"> · {{ modelLabel }}</template>
        </span>
        <span class="block truncate text-[11px] leading-tight text-muted">{{ summary }}</span>
      </span>
      <UIcon name="i-lucide-chevrons-up-down" class="size-3.5 shrink-0 text-dimmed" />
    </button>

    <template #content>
      <div class="w-72 max-w-[calc(100vw-1rem)] sm:w-auto">
        <!--
          The adapter is fixed at session creation — there is no ACP call that
          swaps one out from under a transcript — so it heads the panel as a
          fact rather than appearing below as a column of one.
        -->
        <div class="flex items-center gap-2 border-b border-default px-3 py-2">
          <UIcon :name="adapterInfo.icon" class="size-4 shrink-0 text-primary" />
          <span class="text-sm font-semibold">{{ adapterInfo.label }}</span>
          <span class="ms-auto ps-3 text-xs text-dimmed">Fixed for this session</span>
        </div>

        <!--
          One scroll container on a phone, where the columns stack; on a wider
          screen each column scrolls on its own and the row scrolls sideways if
          a Codex session brings four of them.
        -->
        <div class="flex max-h-[60vh] flex-col divide-y divide-default overflow-auto sm:max-h-none sm:flex-row sm:divide-x sm:divide-y-0">
          <div v-for="column in columns" :key="column.key" class="min-w-0 shrink-0 p-1.5 sm:w-48">
            <div :id="`composer-${column.key}-label`" class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              {{ column.label }}
            </div>

            <UInput
              v-if="column.items.length > FILTER_THRESHOLD"
              v-model="filters[column.key]"
              size="xs"
              variant="none"
              icon="i-lucide-search"
              :placeholder="`Filter ${column.label.toLowerCase()}…`"
              :aria-label="`Filter ${column.label.toLowerCase()}`"
              class="mb-1 w-full"
            />

            <div
              ref="lists"
              role="listbox"
              :aria-labelledby="`composer-${column.key}-label`"
              class="sm:max-h-80 sm:overflow-y-auto"
            >
              <div v-if="column.error" class="px-2 py-1.5 text-xs text-error">
                {{ column.error }}
                <UButton
                  v-if="column.onRetry"
                  label="Try again"
                  color="error"
                  variant="link"
                  size="xs"
                  class="p-0"
                  @click="column.onRetry"
                />
              </div>
              <div
                v-else-if="column.loading && !column.items.length"
                class="flex items-center gap-2 px-2 py-1.5 text-sm text-dimmed"
              >
                <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
                Loading…
              </div>
              <p
                v-else-if="!visibleItems(column).length"
                class="px-2 py-1.5 text-xs text-dimmed"
              >
                Nothing matches.
              </p>

              <button
                v-for="item in visibleItems(column)"
                :key="item.value"
                type="button"
                role="option"
                :aria-selected="item.value === column.selected"
                :title="item.description || undefined"
                class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-elevated"
                :class="item.value === column.selected ? 'bg-primary/10 text-primary' : ''"
                @click="apply(column, item.value)"
              >
                <span class="min-w-0">
                  <span
                    class="block truncate text-sm"
                    :class="item.value === column.selected ? 'font-medium' : ''"
                    :title="item.label"
                  >
                    {{ item.label }}
                  </span>
                  <span v-if="item.hint" class="block truncate text-[11px] text-dimmed">{{ item.hint }}</span>
                  <!--
                    Two lines rather than one: a permission mode's description
                    is the sentence that distinguishes it from the mode above
                    it, and "Always ask before making c…" distinguishes nothing.
                  -->
                  <span v-else-if="item.description" class="line-clamp-2 text-[11px] leading-snug text-muted">{{ item.description }}</span>
                </span>
                <UIcon
                  v-if="applying?.key === column.key && applying.value === item.value"
                  name="i-lucide-loader-circle"
                  class="size-3.5 shrink-0 animate-spin"
                />
                <UIcon
                  v-else-if="item.value === column.selected"
                  name="i-lucide-check"
                  class="size-3.5 shrink-0 text-primary"
                />
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
