<script setup lang="ts">
/**
 * Side-by-side diff via `@codemirror/merge`. Read-only both sides — this
 * is review, not editing. Phase 3's agent-diff approval card reuses the
 * same component (just adds accept/reject around it).
 */
import type { MergeView } from '@codemirror/merge'

const props = withDefaults(
  defineProps<{
    original: string
    modified: string
    language?: string
  }>(),
  { language: 'text' },
)

const container = ref<HTMLElement | null>(null)
const colorMode = useColorMode()
let mv: MergeView | null = null

async function themeExt() {
  if (colorMode.value === 'dark') {
    const { oneDark } = await import('@codemirror/theme-one-dark')
    return oneDark
  }
  return []
}

async function build() {
  if (!container.value) return
  mv?.destroy()
  const { MergeView } = await import('@codemirror/merge')
  const { EditorView, basicSetup } = await import('codemirror')
  const { EditorState } = await import('@codemirror/state')
  const lang = await languageExtension(props.language)
  const theme = await themeExt()
  const common = [
    basicSetup,
    ...lang,
    ...(Array.isArray(theme) ? theme : [theme]),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
  ]
  mv = new MergeView({
    a: { doc: props.original, extensions: common },
    b: { doc: props.modified, extensions: common },
    parent: container.value,
    collapseUnchanged: { margin: 3, minSize: 4 },
    highlightChanges: true,
  })
}

onMounted(build)
onBeforeUnmount(() => {
  mv?.destroy()
  mv = null
})
watch(
  () => [props.original, props.modified, props.language, colorMode.value],
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
