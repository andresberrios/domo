<script setup lang="ts">
/**
 * Images at full size, one at a time, over the page: what a thumbnail opens
 * onto, in the composer and in the transcript alike. `index` is the image
 * shown, and null is closed. On a phone the modal takes the screen; arrows
 * (and the keyboard's) step through a message's images.
 */
const props = defineProps<{ images: Array<{ name: string, url: string }> }>()
const index = defineModel<number | null>('index', { default: null })

const open = computed({
  get: () => index.value !== null && !!props.images[index.value],
  set: (value) => { if (!value) index.value = null }
})
const image = computed(() => (index.value === null ? null : props.images[index.value] ?? null))

function step(by: number) {
  if (index.value === null || props.images.length < 2) return
  index.value = (index.value + by + props.images.length) % props.images.length
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') step(-1)
  if (event.key === 'ArrowRight') step(1)
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="image?.name ?? 'Image'"
    :description="images.length > 1 && index !== null ? `${index + 1} of ${images.length}` : undefined"
    :ui="{ content: 'sm:max-w-5xl max-sm:max-h-dvh', body: 'p-0 sm:p-0' }"
  >
    <template #body>
      <div class="relative flex items-center justify-center bg-elevated/40" @keydown="onKeydown">
        <img
          v-if="image"
          :src="image.url"
          :alt="image.name"
          class="max-h-[75dvh] w-full object-contain"
        >
        <template v-if="images.length > 1">
          <UButton
            icon="i-lucide-chevron-left"
            color="neutral"
            variant="soft"
            aria-label="Previous image"
            class="absolute start-2 rounded-full"
            @click="step(-1)"
          />
          <UButton
            icon="i-lucide-chevron-right"
            color="neutral"
            variant="soft"
            aria-label="Next image"
            class="absolute end-2 rounded-full"
            @click="step(1)"
          />
        </template>
      </div>
    </template>
  </UModal>
</template>
