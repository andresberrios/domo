<script setup lang="ts">
/**
 * CodeMirror 6 wrapper. Read-only by default (the workspace surface opens
 * files for reading first); flip `readonly` off for edit mode. Language,
 * theme, and read-only are held in Compartments so they reconfigure
 * without tearing down the editor / losing scroll + selection.
 *
 * Everything CodeMirror is dynamically imported on mount — the app is SPA
 * so this only ever runs client-side, and it keeps the grammar chunks lazy.
 */
import type { EditorView } from '@codemirror/view'
import type { Compartment } from '@codemirror/state'

const props = withDefaults(
  defineProps<{
    modelValue: string
    language?: string
    readonly?: boolean
  }>(),
  { language: 'text', readonly: true },
)
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const container = ref<HTMLElement | null>(null)
const colorMode = useColorMode()

let view: EditorView | null = null
let langC: Compartment | null = null
let themeC: Compartment | null = null
let roC: Compartment | null = null
let applyingExternal = false

async function themeExt() {
  if (colorMode.value === 'dark') {
    const { oneDark } = await import('@codemirror/theme-one-dark')
    return oneDark
  }
  return []
}

onMounted(async () => {
  const { EditorView: EV, basicSetup } = await import('codemirror')
  const { EditorState, Compartment: Cmp } = await import('@codemirror/state')

  langC = new Cmp()
  themeC = new Cmp()
  roC = new Cmp()

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      basicSetup,
      langC.of(await languageExtension(props.language)),
      themeC.of(await themeExt()),
      roC.of([
        EditorState.readOnly.of(props.readonly),
        EV.editable.of(!props.readonly),
      ]),
      EV.updateListener.of((v) => {
        if (v.docChanged && !applyingExternal) {
          emit('update:modelValue', v.state.doc.toString())
        }
      }),
    ],
  })
  view = new EV({ state, parent: container.value! })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

watch(
  () => props.modelValue,
  (val) => {
    if (!view || val === view.state.doc.toString()) return
    applyingExternal = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: val },
    })
    applyingExternal = false
  },
)

watch(
  () => props.language,
  async (id) => {
    if (view && langC) {
      view.dispatch({ effects: langC.reconfigure(await languageExtension(id)) })
    }
  },
)

watch(
  () => props.readonly,
  async (ro) => {
    if (!view || !roC) return
    const { EditorState } = await import('@codemirror/state')
    const { EditorView: EV } = await import('@codemirror/view')
    view.dispatch({
      effects: roC.reconfigure([
        EditorState.readOnly.of(ro),
        EV.editable.of(!ro),
      ]),
    })
  },
)

watch(
  () => colorMode.value,
  async () => {
    if (view && themeC) {
      view.dispatch({ effects: themeC.reconfigure(await themeExt()) })
    }
  },
)
</script>

<template>
  <div ref="container" class="cm-host h-full min-h-0 overflow-auto text-sm" />
</template>

<style scoped>
.cm-host :deep(.cm-editor) {
  height: 100%;
}
.cm-host :deep(.cm-scroller) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
