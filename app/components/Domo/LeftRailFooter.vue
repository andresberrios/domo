<script setup lang="ts">
const showDone = useState('leftRail:showDone', () => false)
</script>

<template>
  <USwitch v-model="showDone" label="Show done sessions" size="xs" />
</template>
