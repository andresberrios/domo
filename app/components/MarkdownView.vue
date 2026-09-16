<script setup lang="ts">
const props = defineProps<{ text: string }>()

const html = ref('')

watchEffect(async () => {
  html.value = await renderMarkdown(props.text ?? '')
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md-body" v-html="html" />
</template>
