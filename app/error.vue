<script setup lang="ts">
import type { NuxtError } from '#app'

/**
 * Nuxt renders this *instead of* `app.vue`, not inside it, which is the whole
 * reason it has to exist: without it the built-in error page comes up outside
 * `UApp`, and `UApp` is what injects the Nuxt UI colour palette at runtime — so
 * a 404 arrived with none of the theme on it.
 */
const props = defineProps<{ error: NuxtError }>()

useHead({ title: `${props.error.statusCode ?? 'Error'} · Domo` })
</script>

<template>
  <UApp>
    <UError :error="error" />
  </UApp>
</template>
