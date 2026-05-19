<script setup lang="ts">
/**
 * Read-only diff via `@codemirror/merge` — review, not editing. Reused by
 * the workspace git surface and Phase 3's agent diff-approval card.
 *
 * **Responsive layout.** Side-by-side (`MergeView`) needs horizontal room
 * it doesn't have on a phone — two panes squeeze to unreadable. So we
 * render the **unified/inline** view (`unifiedMergeView`, deletions shown
 * inline) below `md` and the split view at `md+`. The existing rebuild
 * `watch` already re-runs on any reactive dep, so flipping breakpoint
 * (e.g. rotate, resize) just rebuilds into the other mode.
 */
import type { MergeView } from '@codemirror/merge'
import type { EditorView as EditorViewType } from '@codemirror/view'
import { useBreakpoints, breakpointsTailwind } from '@vueuse/core'

const props = withDefaults(
  defineProps<{
    original: string
    modified: string
    language?: string
    /** Force inline regardless of width (e.g. a narrow approval card). */
    inline?: boolean
  }>(),
  { language: 'text', inline: false },
)

const container = ref<HTMLElement | null>(null)
const colorMode = useColorMode()
// SPA app — window breakpoints are safe (no SSR hydration gap).
const isWide = useBreakpoints(breakpointsTailwind).greaterOrEqual('md')
const useInline = computed(() => props.inline || !isWide.value)

let mv: MergeView | null = null
let ev: EditorViewType | null = null

function teardown() {
  mv?.destroy()
  mv = null
  ev?.destroy()
  ev = null
}

async function themeExt() {
  if (colorMode.value === 'dark') {
    const { oneDark } = await import('@codemirror/theme-one-dark')
    return oneDark
  }
  return []
}

async function build() {
  if (!container.value) return
  teardown()
  const { basicSetup } = await import('codemirror')
  const { EditorView } = await import('@codemirror/view')
  const { EditorState } = await import('@codemirror/state')
  const lang = await languageExtension(props.language)
  const theme = await themeExt()
  const common = [
    basicSetup,
    ...lang,
    ...(Array.isArray(theme) ? theme : [theme]),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
  ]

  if (useInline.value) {
    const { unifiedMergeView } = await import('@codemirror/merge')
    ev = new EditorView({
      parent: container.value,
      doc: props.modified,
      extensions: [
        ...common,
        unifiedMergeView({
          original: props.original,
          // Review-only: no per-chunk accept/reject gutter controls.
          mergeControls: false,
          collapseUnchanged: { margin: 3, minSize: 4 },
        }),
      ],
    })
    return
  }

  const { MergeView } = await import('@codemirror/merge')
  mv = new MergeView({
    a: { doc: props.original, extensions: common },
    b: { doc: props.modified, extensions: common },
    parent: container.value,
    collapseUnchanged: { margin: 3, minSize: 4 },
    highlightChanges: true,
  })
}

onMounted(build)
onBeforeUnmount(teardown)
watch(
  () => [
    props.original,
    props.modified,
    props.language,
    colorMode.value,
    useInline.value,
  ],
  build,
)
</script>

<template>
  <div ref="container" class="cm-merge h-full min-h-0 overflow-auto text-sm" />
</template>

<style scoped>
.cm-merge :deep(.cm-mergeView),
.cm-merge :deep(.cm-editor) {
  height: 100%;
}
.cm-merge :deep(.cm-scroller) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
