<script setup lang="ts">
const props = defineProps<{ text: string }>()

const html = ref('')

// Rendering is async (Shiki), and streaming changes `text` every 150 ms. One
// render runs at a time, and when it lands the newest text is rendered next.
// Keeping only the newest render instead starved the view: on a phone a
// render outlasted the next delta, so every one was overtaken and the message
// sat at its first few words until the stream paused, while the voice bar was
// already reading far past them.
let rendering = false
let pending: string | null = null

async function render(text: string) {
  if (rendering) {
    pending = text
    return
  }
  rendering = true
  try {
    for (let next: string | null = text; next !== null; next = pending) {
      pending = null
      html.value = await renderMarkdown(next)
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
