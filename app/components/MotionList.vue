<script setup lang="ts">
/**
 * A list whose rows slide in when they join it, fade when they leave, and
 * glide to their new places when others come and go (the `list` motion in
 * main.css). Every child needs a key.
 *
 * A leaving row is taken out of the flow for its fade, so the rows under it
 * move up while it goes rather than after; it is pinned to the box it had,
 * against the list, which is why the list is `relative`.
 */
withDefaults(defineProps<{ tag?: string }>(), { tag: 'ul' })

function pin(el: Element) {
  const row = el as HTMLElement
  row.style.top = `${row.offsetTop}px`
  row.style.left = `${row.offsetLeft}px`
  row.style.width = `${row.offsetWidth}px`
}
</script>

<template>
  <TransitionGroup :tag="tag" name="list" class="relative" @before-leave="pin">
    <slot />
  </TransitionGroup>
</template>
