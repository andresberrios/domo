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
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md-body" v-html="html" />
</template>
