<script setup lang="ts">
interface Health { db: boolean, electric: boolean, electricUrl: string, message: string }

const health = ref<Health | null>(null)

async function check() {
  try {
    health.value = await $fetch<Health>('/api/health')
  } catch {
    health.value = { db: false, electric: false, electricUrl: '', message: 'Domo server unreachable' }
  }
}

onMounted(() => {
  void check()
  const timer = setInterval(check, 15000)
  onScopeDispose(() => clearInterval(timer))
})

const down = computed(() => health.value && (!health.value.db || !health.value.electric))

const description = computed(() => {
  if (!health.value) return ''
  const missing = [
    !health.value.db ? 'Postgres' : null,
    !health.value.electric ? 'Electric' : null
  ].filter(Boolean).join(' and ')
  return `${missing} ${missing.includes('and') ? 'are' : 'is'} not reachable. Run \`docker compose up -d\` in the Domo directory — without them the UI cannot sync.`
})
</script>

<template>
  <UAlert
    v-if="down"
    color="warning"
    variant="subtle"
    icon="i-lucide-plug-zap"
    title="Backing services are down"
    :description="description"
    class="mb-3"
    :actions="[{ label: 'Re-check', color: 'neutral', variant: 'subtle', onClick: check }]"
  />
</template>
