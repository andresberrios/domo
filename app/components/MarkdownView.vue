<script setup lang="ts">
const props = defineProps<{ text: string }>()

const html = ref('')

// Rendering is async (Shiki), and streaming changes `text` many times a second:
// only the newest render may land, or a slow older one overwrites newer text.
let latest = 0

watch(
  () => props.text ?? '',
  async (text) => {
    const run = ++latest
    const rendered = await renderMarkdown(text)
    if (run === latest) html.value = rendered
  },
  { immediate: true }
)
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
