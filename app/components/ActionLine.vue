<script setup lang="ts">
/**
 * One line saying what an agent did, as "Messaged agent: Builder  the text…":
 * the action in a quieter shade, so it never reads as part of the name after
 * it, then the name, then a muted preview and how it went. Shared by every
 * card that names what a Domo tool call acted on.
 */
const props = defineProps<{
  action: string
  subject?: string | null
  detail?: string | null
  outcome?: string | null
}>()

const preview = computed(() => props.detail?.replace(/\s+/g, ' ').trim() || null)
</script>

<template>
  <span class="min-w-0 flex-1 truncate text-sm">
    <span :class="subject ? 'text-muted' : 'text-default'" data-testid="action">{{ action }}{{ subject ? ':' : '' }}</span>
    <!-- Real spaces, not margins, so copied text and a screen reader get words. -->
    <template v-if="subject">{{ ' ' }}<span class="text-default" data-testid="subject">{{ subject }}</span></template>
    <template v-if="preview">{{ ' ' }}<span class="ms-1 text-dimmed">{{ preview }}</span></template>
    <template v-if="outcome">{{ ' ' }}<span class="text-xs text-muted">· {{ outcome }}</span></template>
  </span>
</template>
