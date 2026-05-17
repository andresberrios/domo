<script setup lang="ts">
/**
 * Global fatal-error page (Nuxt renders this outside the layout for an
 * uncaught error or `createError`). Wrapped in `UApp` so Nuxt UI tokens /
 * color mode still apply. "Go home" clears the error and returns to `/`.
 */
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const isNotFound = computed(() => props.error.statusCode === 404)
const title = computed(() =>
  isNotFound.value ? 'Page not found' : 'Something went wrong',
)
const description = computed(
  () =>
    props.error.statusMessage ||
    props.error.message ||
    'An unexpected error occurred.',
)

function goHome() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <UApp>
    <div class="h-screen w-screen bg-default text-default">
      <DomoEmptyState
        :icon="isNotFound ? 'i-lucide-compass' : 'i-lucide-triangle-alert'"
        :title="title"
        :description="description"
      >
        <UButton color="primary" icon="i-lucide-home" @click="goHome">
          Go home
        </UButton>
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-rotate-cw"
          @click="clearError()"
        >
          Try again
        </UButton>
      </DomoEmptyState>
    </div>
  </UApp>
</template>
