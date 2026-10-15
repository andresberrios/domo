<script setup lang="ts">
/**
 * A message's attachments: images as thumbnails that open full size
 * (`ImageLightbox`), anything else as a named badge. An image shows no name:
 * a pasted one only ever has a made-up one, and the picture says more. The same component under
 * a sent message in the transcript and above the composer's box, where
 * `removable` puts a remove button on each.
 */
const props = defineProps<{
  attachments: Array<{ name: string, uri?: string, mimeType?: string }>
  removable?: boolean
}>()
const emit = defineEmits<{ remove: [index: number] }>()

const items = computed(() => props.attachments.map((attachment, index) => {
  const url = attachmentUrl(attachment.uri)
  return { ...attachment, index, url, image: !!url && isImageAttachment(attachment.name, attachment.mimeType) }
}))
const images = computed(() => items.value.filter(item => item.image).map(item => ({ url: item.url! })))
/** Which image an item is, counted among the images only, for the lightbox and the labels. */
const imageNumber = (item: { url: string | null }) => images.value.findIndex(image => image.url === item.url)

const shown = ref<number | null>(null)
</script>

<template>
  <div class="flex flex-wrap items-end gap-1.5">
    <template v-for="item in items" :key="item.uri ?? `${item.index}-${item.name}`">
      <div v-if="item.image" class="group/thumb relative">
        <button
          type="button"
          class="block size-16 cursor-pointer overflow-hidden rounded-md border border-default bg-elevated focus-visible:outline-2 focus-visible:outline-primary"
          :aria-label="`Open image ${imageNumber(item) + 1}`"
          @click="shown = imageNumber(item)"
        >
          <img :src="item.url!" alt="" loading="lazy" class="size-full object-cover">
        </button>
        <UButton
          v-if="removable"
          icon="i-lucide-x"
          color="neutral"
          variant="solid"
          size="xs"
          :aria-label="`Remove image ${imageNumber(item) + 1}`"
          class="absolute -end-2 -top-2 rounded-full p-1"
          @click="emit('remove', item.index)"
        />
      </div>
      <UBadge
        v-else
        color="neutral"
        variant="subtle"
        :size="removable ? 'md' : 'sm'"
        class="gap-1"
      >
        <UIcon name="i-lucide-paperclip" class="size-3" />
        {{ item.name }}
        <UButton
          v-if="removable"
          icon="i-lucide-x"
          color="neutral"
          variant="link"
          size="xs"
          class="-me-1 p-0"
          :aria-label="`Remove ${item.name}`"
          @click="emit('remove', item.index)"
        />
      </UBadge>
    </template>
    <slot />

    <ImageLightbox v-model:index="shown" :images="images" />
  </div>
</template>
