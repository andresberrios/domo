<script lang="ts">
const CACHE_SIZE = 400
const rendered = new Map<string, string>()

function remember(text: string, html: string) {
  rendered.delete(text)
  rendered.set(text, html)
  if (rendered.size > CACHE_SIZE) rendered.delete(rendered.keys().next().value!)
}
</script>

<script setup lang="ts">
const props = defineProps<{ text: string }>()

/**
 * Drawn whole in the frame it mounts in: from the cache, or rendered on the
 * spot with its code not yet highlighted. A virtual transcript mounts a row as
 * it scrolls into view, and a row whose markdown arrived a moment later was
 * drawn empty and then grew, moving every row under it. Highlighting changes
 * colours, not height, so it can land whenever it is ready; the cache means a
 * row scrolled back to does not pay for it twice.
 */
const html = ref(rendered.get(props.text ?? '') ?? renderMarkdownNow(props.text ?? ''))

// Rendering is async (Shiki), and streaming changes `text` every 150 ms. One
// render runs at a time, and when it lands the newest text is rendered next.
// Keeping only the newest render instead starved the view: on a phone a
// render outlasted the next delta, so every one was overtaken and the message
// sat at its first few words until the stream paused, while the voice bar was
// already reading far past them.
let rendering = false
let pending: string | null = null
/** The text on screen should be, which a cached render may already be showing. */
let wanted = ''
/** What this view last cached: a message streaming in replaces its own entry, not everyone else's. */
let mine: string | null = null

function keep(text: string, out: string) {
  if (mine !== null && mine !== text && text.startsWith(mine)) rendered.delete(mine)
  mine = text
  remember(text, out)
}

async function render(text: string) {
  wanted = text
  const cached = rendered.get(text)
  if (cached !== undefined) {
    html.value = cached
    pending = null
    return
  }
  if (rendering) {
    pending = text
    return
  }
  rendering = true
  try {
    for (let next: string | null = text; next !== null; next = pending) {
      pending = null
      const out = await renderMarkdown(next)
      keep(next, out)
      // Unless a newer text was drawn from the cache while this one rendered.
      if (next === wanted || !rendered.has(wanted)) html.value = out
    }
  } finally {
    rendering = false
  }
}

watch(() => props.text ?? '', text => void render(text), { immediate: true })
</script>

<template>
  <!--
    `text` is untrusted: model output that quotes files, web pages and command
    output. `renderMarkdown` is what makes it safe to insert — it escapes raw
    HTML and allows only http/https/mailto/relative URLs — so nothing but its
    output may ever reach this `v-html`.
  -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md-body" v-html="html" />
</template>
