<script setup lang="ts">
/**
 * A USelectMenu that only shows its search field when there is something to
 * search: more than a handful of options, or a menu that takes a typed value
 * of its own (`create-item`). On a phone, a focused search field opens the
 * keyboard, which shoves the page up every time a menu of four options is
 * tapped, and then has to be dismissed before the option can be.
 *
 * Everything else goes straight through to USelectMenu, v-model included.
 */
defineOptions({ inheritAttrs: false })

const SEARCH_ABOVE = 10
const attrs = useAttrs()

const searchable = computed(() => {
  if (attrs['create-item'] !== undefined || attrs.createItem !== undefined) return true
  const items = attrs.items
  if (!Array.isArray(items)) return false
  const count = Array.isArray(items[0]) ? (items as unknown[][]).flat().length : items.length
  return count > SEARCH_ABOVE
})
</script>

<template>
  <USelectMenu v-bind="$attrs" :search-input="searchable ? undefined : false">
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
  </USelectMenu>
</template>
