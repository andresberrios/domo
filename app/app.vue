<script setup lang="ts">
useHead({
  title: 'Domo',
  meta: [{ name: 'description', content: 'Voice control room for coding agents' }],
  htmlAttrs: { lang: 'en' }
})
</script>

<template>
  <UApp>
    <NewBuildReload />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
